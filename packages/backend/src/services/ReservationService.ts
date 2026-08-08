/**
 * ReservationService
 *
 * Owns the lifecycle of `RouteReservation`s: granting, cancelling,
 * suspending, resuming, and progressive release (see docs/route-locking.md,
 * D1–D14). No MQTT, no DCC — all hardware I/O and event publishing stays in
 * `LayoutService`, which calls in and reacts to the outcomes returned here.
 * Dependency direction is one-way: `LayoutService -> ReservationService ->
 * repo/stateManager/domain`. This service never calls back into
 * `LayoutService`.
 *
 * `grant`'s ordering is load-bearing and documented at the call site below:
 * plan (pure, synchronous) -> persist (the one necessary `await`) -> commit
 * locks to `LayoutStateManager` (synchronous, immediately after persist
 * resolves). The DB's partial unique indexes
 * (`route_holds_exclusive_unq`, `route_reservations_one_per_loco_unq`) are
 * the final arbiter against a second `grant` racing the first during that
 * `await` — the in-memory `planReservation` check is the fast path, not the
 * sole source of truth for concurrency, which is why D2/D13 were also put
 * at the DB level (#11's posture).
 */

import { randomUUID } from 'crypto';
import {
  checkPathIndependentPreconditions,
  evaluateOccupancyChange,
  planReservation,
  ReservationRequest,
  ReservationView,
} from '../domain/routeLocking';
import { PathfindingFailure, findPath } from '../domain/pathfinding';
import { LayoutStateManager } from '../domain/layoutState';
import { TrackGraph } from '../domain/graph';
import {
  Authority,
  BlockEdgeId,
  BlockEndLabel,
  BlockId,
  BlockState,
  LayoutId,
  LocoAddress,
  Occupancy,
  PointId,
  PointState,
  RouteHold,
  RouteId,
  RouteReservation,
  RouteRejection,
  RouteStatus,
} from '../domain/types';
import { ILayoutRepository } from '../ports/ILayoutRepository';
import { IRouteLockView } from '../ports/IRouteLockView';

export interface ReservationServiceLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ReservationOutcome {
  reservation: RouteReservation | null;
  changedBlocks: BlockState[];
  changedPoints: PointState[];
}

export type GrantOutcome =
  | { granted: true; reservation: RouteReservation; changedBlocks: BlockState[]; changedPoints: PointState[] }
  | { granted: false; rejections: RouteRejection[] };

/**
 * How a caller specifies the track a route should take (#4).
 *
 * `edges` is the original #3 form and remains first-class: an explicit,
 * ordered edge list, useful when an operator has chosen a specific road and
 * for tests that need a path the search would not pick. `destination` asks
 * the pathfinder for one. Both end up in the same `planReservation` call —
 * a searched path gets no more trust than a hand-supplied one.
 */
export type RequestedPath =
  | { kind: 'edges'; edgeIds: BlockEdgeId[] }
  | { kind: 'destination'; destinationBlockId: BlockId; startExitEnd?: BlockEndLabel };

/** A route request as the service layer takes it — `ReservationRequest` (the domain form) is what it resolves to once the path is known. */
export interface GrantRequest {
  locoAddress: LocoAddress;
  authority: Authority;
  startBlockId: BlockId;
  path: RequestedPath;
}

export interface OccupancyOutcome extends ReservationOutcome {
  /** True when this occupancy reading was a D7 route violation (occupancy in
   * a reserved block that was not the route's next expected step) — the
   * route has already been cancelled and its locks released by the time
   * this returns; the caller (`LayoutService`) still owns stopping the
   * loco and entering Safe-Stop, since this service has no DCC/MQTT access. */
  unexpectedOccupancy: boolean;
  /**
   * Set to the block id when a block this route still holds stopped being
   * determinable (#4). Unlike `unexpectedOccupancy`, the route is left
   * exactly as it was — status and locks untouched — because Safe-Stop holds
   * locks rather than releasing them (D8), and `LayoutService`'s Safe-Stop
   * is what will move it to `suspended`. This service only reports the fact.
   */
  occupancyUnknownBlockId: BlockId | null;
}

export type ResumeResult =
  | { resumed: true; reservation: RouteReservation; pointsToRecommand: RouteHold[] }
  | { resumed: false; reason: string };

/**
 * Maps a `PathfindingFailure` onto the `RouteRejection` union, so a refused
 * grant has one rejection vocabulary whether the refusal came from the search
 * or from the planner. A point-position conflict fans out to one rejection
 * per conflicting point, matching how `planReservation` reports the same
 * condition when it is handed an explicit path.
 */
function toRejections(failure: PathfindingFailure, destinationBlockId: BlockId): RouteRejection[] {
  switch (failure.kind) {
    case 'unknown-block':
      return [{ kind: 'unknown-block', blockId: failure.blockId }];
    case 'destination-is-start':
      return [{ kind: 'destination-is-start', blockId: failure.blockId }];
    case 'point-position-conflict':
      return failure.pointIds.map((pointId) => ({ kind: 'point-position-conflict', pointId }));
    case 'no-path':
      return [{ kind: 'no-path', destinationBlockId, blockers: failure.blockers }];
  }
}

/** Thrown when a route id does not resolve to a reservation in the given layout. */
export class RouteNotFoundError extends Error {
  constructor(readonly routeId: RouteId) {
    super(`Route ${routeId} not found`);
    this.name = 'RouteNotFoundError';
  }
}

export class ReservationService implements IRouteLockView {
  constructor(
    private readonly repo: ILayoutRepository,
    private readonly stateManager: LayoutStateManager,
    private readonly log: ReservationServiceLogger,
  ) {}

  // ─── Grant ──────────────────────────────────────────────────────────────────

  /**
   * Resolves `request.path` to an ordered edge list — searching the graph
   * when the caller named a destination (#4) — then plans, persists, and
   * commits the grant.
   *
   * The search happens *before* `planReservation`, against the same `view`,
   * and its output is then validated by `planReservation` like any other
   * edge list. That redundancy is deliberate (P6, docs/pathfinding.md): the
   * pathfinder is an optimiser over the graph, and the planner remains the
   * single authority on what may be reserved. If the two ever disagree, the
   * planner wins and the grant is refused — which is the fail-safe direction.
   */
  async grant(
    layoutId: LayoutId,
    request: GrantRequest,
    graph: TrackGraph | null,
  ): Promise<GrantOutcome> {
    const routeId = randomUUID();
    const now = new Date();
    const view = await this.buildView(layoutId, graph);

    const resolved = this.resolvePath(request, view);
    if (!resolved.ok) {
      this.log.warn('[ReservationService] Grant rejected — no path', {
        layoutId,
        locoAddress: request.locoAddress,
        rejections: resolved.rejections,
      });
      return { granted: false, rejections: resolved.rejections };
    }

    const fullRequest: ReservationRequest = {
      layoutId,
      locoAddress: request.locoAddress,
      authority: request.authority,
      startBlockId: request.startBlockId,
      edgeIds: resolved.edgeIds,
    };

    const result = planReservation(fullRequest, view, routeId, now);
    if (!result.granted) {
      this.log.warn('[ReservationService] Grant rejected', {
        layoutId,
        locoAddress: request.locoAddress,
        rejections: result.rejections,
      });
      return { granted: false, rejections: result.rejections };
    }

    // Persist first (see the class doc comment for why) — the DB write is
    // the actual commit point; a crash before this line means nothing
    // happened, a crash after it revives as `suspended` on next startup
    // (D9) with locks re-applied, never silently lost.
    const persisted = await this.repo.createReservation({
      id: result.reservation.id,
      layoutId: result.reservation.layoutId,
      locoAddress: result.reservation.locoAddress,
      authority: result.reservation.authority,
      status: result.reservation.status,
      path: result.reservation.path,
      holds: result.reservation.holds,
      confirmedIndex: result.reservation.confirmedIndex,
      reason: result.reservation.reason,
    });

    // No `await` from here to the end of lock application — one synchronous
    // pass over LayoutStateManager (D3).
    this.assignStartBlockLoco(persisted);
    const { changedBlocks, changedPoints } = this.applyLocks(persisted);

    this.log.info('[ReservationService] Route granted', {
      layoutId,
      routeId: persisted.id,
      locoAddress: persisted.locoAddress,
    });
    return { granted: true, reservation: persisted, changedBlocks, changedPoints };
  }

  // ─── Cancel / Suspend / Resume ────────────────────────────────────────────────

  async cancel(layoutId: LayoutId, routeId: RouteId, reason: string | null): Promise<ReservationOutcome> {
    const reservation = await this.mustGetReservation(layoutId, routeId);
    if (reservation.status === 'released' || reservation.status === 'cancelled') {
      return { reservation, changedBlocks: [], changedPoints: [] };
    }
    const unreleased = reservation.holds.filter((h) => !h.released);
    const outcome = await this.releaseAndPersist(routeId, unreleased, { status: 'cancelled', reason });
    this.log.info('[ReservationService] Route cancelled', { layoutId, routeId, reason });
    return outcome;
  }

  /** Safe-Stop (D8): every `active` reservation in the layout -> `suspended`. Locks retained. */
  async suspendAll(layoutId: LayoutId, reason: string): Promise<ReservationOutcome[]> {
    return this.suspendMatching(layoutId, reason, () => true);
  }

  /** `systemMode` flips to `manual` (D7): every `auto`-authority `active` reservation -> `suspended`. Locks retained; manual-authority routes are untouched. */
  async suspendAuto(layoutId: LayoutId, reason: string): Promise<ReservationOutcome[]> {
    return this.suspendMatching(layoutId, reason, (r) => r.authority === 'auto');
  }

  /**
   * One `active` route -> `suspended`, locks retained. Used to undo a resume
   * whose point re-commanding failed (see `resume`), so a route can never sit
   * `active` while a point it holds is known not to have accepted its
   * command. Returns `null` when the route is not currently `active` — a
   * caller undoing its own resume has already established that it is.
   */
  async suspendOne(
    layoutId: LayoutId,
    routeId: RouteId,
    reason: string,
  ): Promise<ReservationOutcome | null> {
    const outcomes = await this.suspendMatching(layoutId, reason, (r) => r.id === routeId);
    return outcomes[0] ?? null;
  }

  /**
   * D8's resume preconditions: every remaining (unconfirmed) block in the
   * path reads `clear`, the train's current confirmed block reads
   * `occupied`, and (any `unknown` anywhere refuses, since both prior
   * checks already fail on `unknown`). This service has no DCC access, so
   * it cannot itself re-command the held points D8 also requires — it
   * returns them as `pointsToRecommand` for `LayoutService` to issue after
   * this call flips the route back to `active`.
   *
   * That re-commanding is **not** best-effort, so this method's success is
   * provisional: D8 refuses a resume unless *every* held point is
   * re-commanded, which means `LayoutService.resumeRoute` must call
   * `suspendOne` to put the route straight back to `suspended` if any
   * command is rejected, and must not clear a restart Safe-Stop (D9) until
   * they have all succeeded. A point lock is an authority lock rather than a
   * physical position guarantee (D11) — which is precisely why a *rejected*
   * command must not be swallowed. It is the only evidence available today
   * that the road is not set.
   */
  async resume(layoutId: LayoutId, routeId: RouteId): Promise<ResumeResult> {
    const reservation = await this.mustGetReservation(layoutId, routeId);
    if (reservation.status !== 'suspended') {
      return { resumed: false, reason: `route ${routeId} is ${reservation.status}, not suspended` };
    }

    const state = this.stateManager.getState();
    const currentStep = reservation.path[reservation.confirmedIndex];
    const currentBlock = currentStep ? state.blocks.get(currentStep.blockId) : undefined;
    if (!currentBlock || currentBlock.occupancy !== 'occupied') {
      return {
        resumed: false,
        reason: `current block ${currentStep?.blockId} is ${currentBlock?.occupancy ?? 'unknown'}, not occupied`,
      };
    }

    for (const step of reservation.path.slice(reservation.confirmedIndex + 1)) {
      const block = state.blocks.get(step.blockId);
      const occupancy = block?.occupancy ?? 'unknown';
      if (occupancy !== 'clear') {
        return { resumed: false, reason: `block ${step.blockId} is ${occupancy}, not clear` };
      }
    }

    const updated = await this.repo.updateReservation(routeId, { status: 'active', reason: null });
    this.stateManager.upsertRoute(updated);
    const pointsToRecommand = updated.holds.filter((h) => h.kind === 'point' && !h.released);
    this.log.info('[ReservationService] Route resumed', { layoutId, routeId });
    return { resumed: true, reservation: updated, pointsToRecommand };
  }

  // ─── Occupancy ──────────────────────────────────────────────────────────────

  /**
   * Applies one block occupancy transition to whichever `active`/`suspended`
   * route currently holds an unreleased `block` hold on `blockId` — D2's
   * exclusivity guarantees at most one, so the first match is honoured
   * (defence in depth, not an assumption). See `evaluateOccupancyChange`
   * for the interpretation rules (D5 progressive release, D7 unexpected
   * occupancy).
   */
  async onOccupancyChange(
    layoutId: LayoutId,
    blockId: BlockId,
    occupancy: Occupancy,
    previous: Occupancy,
  ): Promise<OccupancyOutcome> {
    const route = this.stateManager
      .listRoutes(['active', 'suspended'])
      .find(
        (r) =>
          r.layoutId === layoutId &&
          r.holds.some((h) => h.kind === 'block' && h.targetId === blockId && !h.released),
      );

    if (!route) {
      return {
        reservation: null,
        changedBlocks: [],
        changedPoints: [],
        unexpectedOccupancy: false,
        occupancyUnknownBlockId: null,
      };
    }

    const effect = evaluateOccupancyChange(route, blockId, occupancy, previous);
    const quiet = { unexpectedOccupancy: false, occupancyUnknownBlockId: null };

    switch (effect.kind) {
      case 'progress': {
        const outcome = await this.releaseAndPersist(route.id, [], {
          confirmedIndex: effect.confirmedIndex,
        });
        return { ...outcome, ...quiet };
      }
      case 'release': {
        const outcome = await this.releaseAndPersist(route.id, effect.releasable, {
          confirmedIndex: effect.confirmedIndex,
        });
        return { ...outcome, ...quiet };
      }
      case 'complete': {
        const unreleased = route.holds.filter((h) => !h.released);
        const outcome = await this.releaseAndPersist(route.id, unreleased, {
          status: 'released',
          reason: null,
          confirmedIndex: route.path.length - 1,
        });
        this.log.info('[ReservationService] Route completed', { layoutId, routeId: route.id });
        return { ...outcome, ...quiet };
      }
      case 'unexpected-occupancy': {
        const unreleased = route.holds.filter((h) => !h.released);
        const reason = `unexpected occupancy in block ${blockId} — not the route's next expected step`;
        const outcome = await this.releaseAndPersist(route.id, unreleased, {
          status: 'cancelled',
          reason,
        });
        this.log.warn('[ReservationService] Route violation — unexpected occupancy', {
          layoutId,
          routeId: route.id,
          blockId,
        });
        return { ...outcome, unexpectedOccupancy: true, occupancyUnknownBlockId: null };
      }
      case 'occupancy-unknown': {
        // Deliberately no `releaseAndPersist`: the route keeps its status and
        // every lock it holds. Safe-Stop holds locks, it does not release
        // them (D8), and `LayoutService` is what suspends it. Reporting the
        // block is all this service can do without DCC/MQTT access.
        this.log.warn('[ReservationService] Route block occupancy became unknown', {
          layoutId,
          routeId: route.id,
          blockId,
        });
        return {
          reservation: route,
          changedBlocks: [],
          changedPoints: [],
          unexpectedOccupancy: false,
          occupancyUnknownBlockId: blockId,
        };
      }
      case 'ignore':
      default:
        return { reservation: route, changedBlocks: [], changedPoints: [], ...quiet };
    }
  }

  // ─── Startup recovery (D9) ────────────────────────────────────────────────────

  /**
   * Revives every reservation still `active`/`suspended` from a prior
   * process as `suspended` with reason `backend restarted`, re-applying its
   * locks to block/point state. Never revives as live authority — see D9.
   * `LayoutService` folds `recovered.length` into `SystemHealth.recoveredRouteCount`
   * and enters Safe-Stop when it is non-zero.
   */
  async loadOnStartup(
    layoutId: LayoutId,
  ): Promise<{ recovered: RouteReservation[]; outcomes: ReservationOutcome[] }> {
    const rows = await this.repo.listReservations(layoutId, ['active', 'suspended']);
    const outcomes: ReservationOutcome[] = [];

    for (const reservation of rows) {
      const persisted = await this.repo.updateReservation(reservation.id, {
        status: 'suspended',
        reason: 'backend restarted',
      });
      const { changedBlocks, changedPoints } = this.applyLocks(persisted);
      outcomes.push({ reservation: persisted, changedBlocks, changedPoints });
    }

    if (rows.length > 0) {
      this.log.warn('[ReservationService] Route reservation(s) survived a restart', {
        layoutId,
        count: rows.length,
      });
    }

    return { recovered: outcomes.map((o) => o.reservation!), outcomes };
  }

  // ─── Queries ────────────────────────────────────────────────────────────────

  /** D6's throttle rule: the `active`/`suspended` route currently holding `locoAddress`, if any. */
  routeHoldingLoco(layoutId: LayoutId, locoAddress: LocoAddress): RouteReservation | null {
    return (
      this.stateManager
        .listRoutes(['active', 'suspended'])
        .find((r) => r.layoutId === layoutId && r.locoAddress === locoAddress) ?? null
    );
  }

  listRoutes(layoutId: LayoutId, statuses?: RouteStatus[]): RouteReservation[] {
    return this.stateManager.listRoutes(statuses).filter((r) => r.layoutId === layoutId);
  }

  getRoute(layoutId: LayoutId, routeId: RouteId): RouteReservation | null {
    const route = this.stateManager.getRoute(routeId);
    return route && route.layoutId === layoutId ? route : null;
  }

  // ─── IRouteLockView ───────────────────────────────────────────────────────────

  findRouteHoldingBlock(layoutId: LayoutId, blockId: BlockId): RouteId | null {
    return this.findHolder(layoutId, 'block', blockId);
  }

  findRouteHoldingPoint(layoutId: LayoutId, pointId: PointId): RouteId | null {
    return this.findHolder(layoutId, 'point', pointId);
  }

  findRouteHoldingEdge(layoutId: LayoutId, edgeId: BlockEdgeId): RouteId | null {
    return this.findHolder(layoutId, 'edge', edgeId);
  }

  private findHolder(layoutId: LayoutId, kind: RouteHold['kind'], targetId: string): RouteId | null {
    const route = this.stateManager
      .listRoutes(['active', 'suspended'])
      .find(
        (r) =>
          r.layoutId === layoutId && r.holds.some((h) => h.kind === kind && h.targetId === targetId && !h.released),
      );
    return route?.id ?? null;
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Turns a `RequestedPath` into the ordered edge list `planReservation`
   * takes. An `edges` request passes straight through — #3's behaviour,
   * unchanged. A `destination` request runs the pathfinder.
   *
   * On a search failure this returns the path rejections **together with**
   * the path-independent ones (`checkPathIndependentPreconditions`), because
   * `planReservation` will never run to report them. Without that, an
   * operator whose system is Safe-Stopped *and* whose destination is blocked
   * would be told only about the blockage, fix it, and be refused again —
   * D14 exists precisely to prevent that.
   */
  private resolvePath(
    request: GrantRequest,
    view: ReservationView,
  ): { ok: true; edgeIds: BlockEdgeId[] } | { ok: false; rejections: RouteRejection[] } {
    if (request.path.kind === 'edges') {
      return { ok: true, edgeIds: request.path.edgeIds };
    }

    const { destinationBlockId, startExitEnd } = request.path;

    if (view.graph === null) {
      // `planReservation` would report this too, but it cannot run without a
      // path and the search cannot run without a graph.
      return { ok: false, rejections: checkPathIndependentPreconditions(request.locoAddress, view) };
    }

    const result = findPath(
      { startBlockId: request.startBlockId, destinationBlockId, startExitEnd },
      { graph: view.graph, blocks: view.blocks, points: view.points },
    );

    if (result.found) {
      return { ok: true, edgeIds: result.edgeIds };
    }

    return {
      ok: false,
      rejections: [
        ...checkPathIndependentPreconditions(request.locoAddress, view),
        ...toRejections(result.reason, destinationBlockId),
      ],
    };
  }

  private async buildView(layoutId: LayoutId, graph: TrackGraph | null): Promise<ReservationView> {
    const state = this.stateManager.getState();
    const locos = await this.repo.listLocos(layoutId);
    return {
      systemStatus: state.systemStatus,
      graph,
      blocks: state.blocks,
      points: state.points,
      holding: this.stateManager.listRoutes(['active', 'suspended']).filter((r) => r.layoutId === layoutId),
      knownLocoAddresses: new Set(locos.map((l) => l.address)),
    };
  }

  private async mustGetReservation(layoutId: LayoutId, routeId: RouteId): Promise<RouteReservation> {
    const cached = this.stateManager.getRoute(routeId);
    if (cached && cached.layoutId === layoutId) return cached;
    const fromRepo = await this.repo.getReservation(routeId);
    if (!fromRepo || fromRepo.layoutId !== layoutId) {
      throw new RouteNotFoundError(routeId);
    }
    return fromRepo;
  }

  /** D13: the grant is the operator's assertion that the loco is in the start block — if it had none recorded, this records it. Part of the synchronous commit pass, not a separate step. */
  private assignStartBlockLoco(reservation: RouteReservation): void {
    const startBlockId = reservation.path[0]?.blockId;
    if (!startBlockId) return;
    const block = this.stateManager.getBlock(startBlockId);
    if (block && block.locoAddress === null) {
      this.stateManager.updateBlockOccupancy(startBlockId, block.occupancy, reservation.locoAddress);
    }
  }

  private applyLocks(reservation: RouteReservation): { changedBlocks: BlockState[]; changedPoints: PointState[] } {
    const changedBlocks: BlockState[] = [];
    const changedPoints: PointState[] = [];
    for (const hold of reservation.holds) {
      if (hold.released) continue;
      if (hold.kind === 'block') {
        this.stateManager.lockBlock(hold.targetId, reservation.id);
        const block = this.stateManager.getBlock(hold.targetId);
        if (block) changedBlocks.push(block);
      } else if (hold.kind === 'point') {
        this.stateManager.lockPoint(hold.targetId, reservation.id);
        const point = this.stateManager.getPoint(hold.targetId);
        if (point) changedPoints.push(point);
      }
      // edge holds have no block/point runtime state to touch.
    }
    this.stateManager.upsertRoute(reservation);
    return { changedBlocks, changedPoints };
  }

  private releaseLocks(
    holdsToRelease: readonly RouteHold[],
  ): { changedBlocks: BlockState[]; changedPoints: PointState[] } {
    const changedBlocks: BlockState[] = [];
    const changedPoints: PointState[] = [];
    for (const hold of holdsToRelease) {
      if (hold.kind === 'block') {
        this.stateManager.unlockBlock(hold.targetId);
        const block = this.stateManager.getBlock(hold.targetId);
        if (block) changedBlocks.push(block);
      } else if (hold.kind === 'point') {
        this.stateManager.unlockPoint(hold.targetId);
        const point = this.stateManager.getPoint(hold.targetId);
        if (point) changedPoints.push(point);
      }
    }
    return { changedBlocks, changedPoints };
  }

  /**
   * Marks `holdsToRelease` released (if any), applies `changes` to the
   * reservation row, re-reads the merged result, unlocks the corresponding
   * block/point projections, and updates the in-memory route cache. The one
   * place every release/progress/status-change path in this service goes
   * through, so the DB and `LayoutStateManager` never drift apart.
   */
  private async releaseAndPersist(
    routeId: RouteId,
    holdsToRelease: readonly RouteHold[],
    changes: { status?: RouteStatus; confirmedIndex?: number; reason?: string | null },
  ): Promise<ReservationOutcome> {
    if (holdsToRelease.length > 0) {
      await this.repo.markHoldsReleased(
        routeId,
        holdsToRelease.map((h) => ({ kind: h.kind, targetId: h.targetId })),
      );
    }
    const updated = await this.repo.updateReservation(routeId, changes);
    const { changedBlocks, changedPoints } = this.releaseLocks(holdsToRelease);
    this.stateManager.upsertRoute(updated);
    return { reservation: updated, changedBlocks, changedPoints };
  }

  /** Shared implementation for `suspendAll`/`suspendAuto` (D7/D8) — locks retained, only status/reason change. */
  private async suspendMatching(
    layoutId: LayoutId,
    reason: string,
    predicate: (r: RouteReservation) => boolean,
  ): Promise<ReservationOutcome[]> {
    const targets = this.stateManager
      .listRoutes(['active'])
      .filter((r) => r.layoutId === layoutId && predicate(r));

    const outcomes: ReservationOutcome[] = [];
    for (const route of targets) {
      const updated = await this.repo.updateReservation(route.id, { status: 'suspended', reason });
      this.stateManager.upsertRoute(updated);
      outcomes.push({ reservation: updated, changedBlocks: [], changedPoints: [] });
    }
    if (outcomes.length > 0) {
      this.log.warn('[ReservationService] Suspended route reservation(s)', {
        layoutId,
        count: outcomes.length,
        reason,
      });
    }
    return outcomes;
  }
}
