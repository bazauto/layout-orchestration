/**
 * TopologyService
 *
 * The write path for block edges. Validates every create/update against the
 * rest of the layout with `validateEdgeAgainstLayout` before persisting, and
 * notifies the caller (via the injected `onTopologyChanged` callback) so the
 * running `LayoutService` can reload and re-validate its `TrackGraph` and
 * apply Safe-Stop if needed. The callback is injected rather than a direct
 * `LayoutService` reference so this service stays testable without a full
 * running layout.
 */

import { MAX_EDGES_PER_LAYOUT, validateEdgeAgainstLayout, validateTopology } from '../domain/topology';
import { BlockEdge, BlockEdgeId, LayoutId, PointId, TopologyViolation } from '../domain/types';
import { ILayoutRepository, PointRecord } from '../ports/ILayoutRepository';
import { IRouteLockView } from '../ports/IRouteLockView';

export interface TopologyServiceLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface TopologyStatus {
  valid: boolean;
  violations: TopologyViolation[];
  edgeCount: number;
}

/** Thrown when a create/update would leave the topology invalid. */
export class TopologyRejectedError extends Error {
  readonly violations: TopologyViolation[];

  constructor(violations: TopologyViolation[], message?: string) {
    super(message ?? `Topology rejected: ${violations.length} violation(s)`);
    this.name = 'TopologyRejectedError';
    this.violations = violations;
  }
}

/**
 * Thrown when a create would push a layout's edge count past
 * `MAX_EDGES_PER_LAYOUT`. This is admission control, not a topology
 * violation — the candidate edge itself may be perfectly valid — so it is a
 * distinct type from `TopologyRejectedError` rather than a fabricated
 * violation. See `docs/topology.md` for why the cap is service-level only.
 */
export class EdgeLimitExceededError extends Error {
  constructor(
    readonly layoutId: LayoutId,
    readonly limit: number,
    readonly current: number,
  ) {
    super(`Layout ${layoutId} already has ${current} edges (limit ${limit})`);
    this.name = 'EdgeLimitExceededError';
  }
}

/** Thrown when an edge id does not resolve to an edge in the given layout. */
export class EdgeNotFoundError extends Error {
  constructor(readonly edgeId: BlockEdgeId) {
    super(`Edge ${edgeId} not found`);
    this.name = 'EdgeNotFoundError';
  }
}

/**
 * Thrown when a block or point id does not resolve to a record in the given
 * layout. Deleting by id alone would let a caller destroy another layout's
 * records by supplying any `:layoutId` in the path.
 */
export class RecordNotFoundError extends Error {
  constructor(
    readonly kind: 'block' | 'point',
    readonly recordId: string,
  ) {
    super(`${kind} ${recordId} not found`);
    this.name = 'RecordNotFoundError';
  }
}

/**
 * Thrown when a write would touch an edge, block, or point currently held
 * by an `active` or `suspended` route reservation (D10 — closes the
 * `docs/topology.md` deferred note). Mutating track geometry out from under
 * a held reservation is exactly the "guess a train's position" failure
 * CLAUDE.md's fail-safe rule forbids. The operator must cancel the route
 * first — always available, so this is an ordering requirement, not a
 * deadlock.
 */
export class LockedByRouteError extends Error {
  constructor(
    readonly kind: 'edge' | 'block' | 'point',
    readonly targetId: string,
    readonly routeId: string,
  ) {
    super(`${kind} ${targetId} is held by route ${routeId}`);
    this.name = 'LockedByRouteError';
  }
}

export type EdgeCreateData = Omit<BlockEdge, 'id' | 'layoutId'>;
export type EdgeUpdateData = Partial<Omit<BlockEdge, 'id' | 'layoutId'>>;
export type PointUpdateData = Partial<Omit<PointRecord, 'id' | 'layoutId'>>;

export class TopologyService {
  constructor(
    private readonly repo: ILayoutRepository,
    private readonly onTopologyChanged: () => Promise<unknown>,
    private readonly log: TopologyServiceLogger,
    /**
     * Read-only route-lock port (D10), matching the `onTopologyChanged`
     * injection style so this service stays testable standalone — no direct
     * `ReservationService` dependency. Implemented by `ReservationService`.
     */
    private readonly lockView: IRouteLockView,
  ) {}

  async listEdges(layoutId: LayoutId): Promise<BlockEdge[]> {
    return this.repo.listBlockEdges(layoutId);
  }

  async getStatus(layoutId: LayoutId): Promise<TopologyStatus> {
    const edges = await this.repo.listBlockEdges(layoutId);
    const context = await this.buildContext(layoutId);
    // Delegates to the same O(n) full-pass validator the load path uses
    // (validateTopology), rather than open-coding a flatMap over
    // validateEdgeAgainstLayout. That open-coded version was both O(n^2) and
    // silently missed duplicate-edge-id (validateTopology's seenIds check),
    // which let this read endpoint report valid on a graph the load path
    // would Safe-Stop on — see docs/topology.md (#21).
    const violations = validateTopology(layoutId, edges, context);
    return { valid: violations.length === 0, violations, edgeCount: edges.length };
  }

  /**
   * `createEdge` is deliberately NOT guarded against held routes (D10). A
   * new edge moves no train, and it cannot be traversed into reserved track
   * because the target block is already locked — the block/point locks
   * themselves are what protect a live route, not an admission check on
   * every new edge.
   */
  async createEdge(layoutId: LayoutId, data: EdgeCreateData): Promise<BlockEdge> {
    const existingEdges = await this.repo.listBlockEdges(layoutId);

    // Admission control, not a topology invariant (see docs/topology.md).
    // Checked here because createEdge already fetched existingEdges for
    // the duplicate-connection check below, so this is free — no extra
    // query. The await between this count and the repo.createBlockEdge
    // call below permits a small overshoot under concurrent requests; that
    // is acceptable for a policy cap and is not worth adding locking for.
    if (existingEdges.length >= MAX_EDGES_PER_LAYOUT) {
      this.log.warn('[TopologyService] Rejected edge create — layout at edge cap', {
        layoutId,
        limit: MAX_EDGES_PER_LAYOUT,
        current: existingEdges.length,
      });
      throw new EdgeLimitExceededError(layoutId, MAX_EDGES_PER_LAYOUT, existingEdges.length);
    }

    const context = await this.buildContext(layoutId);

    // A synthetic id (never persisted) lets validateEdgeAgainstLayout's
    // duplicate-connection check run before the real id exists.
    const candidate: BlockEdge = { id: '__pending__', layoutId, ...data };
    const violations = validateEdgeAgainstLayout(candidate, layoutId, context, existingEdges);
    if (violations.length > 0) {
      this.log.warn('[TopologyService] Rejected edge create', { layoutId, violations });
      throw new TopologyRejectedError(violations);
    }

    const created = await this.repo.createBlockEdge({ layoutId, ...data });
    this.log.info('[TopologyService] Edge created', { layoutId, edgeId: created.id });
    await this.onTopologyChanged();
    return created;
  }

  async updateEdge(layoutId: LayoutId, id: BlockEdgeId, patch: EdgeUpdateData): Promise<BlockEdge> {
    const existing = await this.repo.getBlockEdge(id);
    if (!existing || existing.layoutId !== layoutId) {
      throw new EdgeNotFoundError(id);
    }
    this.assertEdgeUnlocked(layoutId, id);

    const existingEdges = await this.repo.listBlockEdges(layoutId);
    const context = await this.buildContext(layoutId);

    const merged: BlockEdge = { ...existing, ...patch };
    const violations = validateEdgeAgainstLayout(merged, layoutId, context, existingEdges);
    if (violations.length > 0) {
      this.log.warn('[TopologyService] Rejected edge update', {
        layoutId,
        edgeId: id,
        violations,
      });
      throw new TopologyRejectedError(violations);
    }

    const updated = await this.repo.updateBlockEdge(id, patch);
    this.log.info('[TopologyService] Edge updated', { layoutId, edgeId: id });
    await this.onTopologyChanged();
    return updated;
  }

  async deleteEdge(layoutId: LayoutId, id: BlockEdgeId): Promise<void> {
    const existing = await this.repo.getBlockEdge(id);
    if (!existing || existing.layoutId !== layoutId) {
      throw new EdgeNotFoundError(id);
    }
    this.assertEdgeUnlocked(layoutId, id);

    await this.repo.deleteBlockEdge(id);
    this.log.info('[TopologyService] Edge deleted', { layoutId, edgeId: id });
    await this.onTopologyChanged();
  }

  /**
   * Deletes a block along with every edge that references it. Delegated to
   * by the blocks route so a block delete never leaves a dangling edge
   * behind — see `ILayoutRepository#deleteBlock`, which the repository
   * implements atomically.
   */
  async deleteBlockWithEdges(layoutId: LayoutId, blockId: string): Promise<{ removedEdges: number }> {
    // Ownership first. Without this, `DELETE /api/layouts/<any>/blocks/<id>`
    // deletes the block — and now, transitively, its edges — from whichever
    // layout actually owns it, because the delete is by id alone.
    const blocks = await this.repo.listBlocks(layoutId);
    if (!blocks.some((block) => block.id === blockId)) {
      throw new RecordNotFoundError('block', blockId);
    }
    this.assertBlockUnlocked(layoutId, blockId);

    const edges = await this.repo.listBlockEdges(layoutId);
    const referencingEdges = edges.filter(
      (edge) => edge.fromBlockId === blockId || edge.toBlockId === blockId,
    );
    for (const edge of referencingEdges) {
      this.assertEdgeUnlocked(layoutId, edge.id);
    }
    const removedEdges = referencingEdges.length;

    await this.repo.deleteBlock(layoutId, blockId);
    this.log.info('[TopologyService] Block deleted with edges', {
      layoutId,
      blockId,
      removedEdges,
    });
    await this.onTopologyChanged();
    return { removedEdges };
  }

  /**
   * Deletes a point only if no edge's `pointConditions` reference it.
   * Deleting a referenced point would leave an edge condition dangling
   * (`unknown-point` — non-fatal, but permanently non-traversable), so this
   * is rejected outright rather than silently degrading a live edge.
   */
  async deletePointIfUnreferenced(layoutId: LayoutId, pointId: PointId): Promise<void> {
    // Ownership must be checked BEFORE the reference guard, not after. The
    // guard below scans `layoutId`'s edges; if the point actually belongs to a
    // different layout, that scan finds no references and waves through a
    // delete that strands the owning layout's edge conditions.
    const points = await this.repo.listPoints(layoutId);
    if (!points.some((point) => point.id === pointId)) {
      throw new RecordNotFoundError('point', pointId);
    }
    this.assertPointUnlocked(layoutId, pointId);

    const edges = await this.repo.listBlockEdges(layoutId);
    const referencingEdgeIds = edges
      .filter((edge) => edge.pointConditions.some((c) => c.pointId === pointId))
      .map((edge) => edge.id);

    if (referencingEdgeIds.length > 0) {
      this.log.warn('[TopologyService] Rejected point delete — referenced by edges', {
        layoutId,
        pointId,
        referencingEdgeIds,
      });
      throw new TopologyRejectedError(
        [],
        `Point ${pointId} is referenced by edge(s): ${referencingEdgeIds.join(', ')}`,
      );
    }

    await this.repo.deletePoint(layoutId, pointId);
    this.log.info('[TopologyService] Point deleted', { layoutId, pointId });
  }

  /**
   * Updates a point's name, DCC address, or block assignment, scoped to
   * `layoutId` for the same ownership reason as `deletePointIfUnreferenced`
   * — without the check, `PUT /api/layouts/<any>/points/:id` could mutate a
   * point belonging to a different layout by id alone.
   *
   * Deliberately does NOT re-validate topology or call `onTopologyChanged`,
   * unlike the edge write path: an edge's `pointConditions` reference a
   * point only by its immutable `id` (see `TopologyContext.pointIds` in
   * `domain/topology.ts`), and neither `id` nor `layoutId` is updatable
   * through this method — so no edit made here can turn an existing edge's
   * point condition into an `unknown-point` violation, or otherwise change
   * what the load path's topology validation sees. Compare
   * `deletePointIfUnreferenced`, where the point's identity stops existing
   * altogether and so must be guarded against dangling references.
   */
  async updatePoint(layoutId: LayoutId, pointId: PointId, patch: PointUpdateData): Promise<PointRecord> {
    const points = await this.repo.listPoints(layoutId);
    if (!points.some((point) => point.id === pointId)) {
      throw new RecordNotFoundError('point', pointId);
    }

    const updated = await this.repo.updatePoint(pointId, patch);
    this.log.info('[TopologyService] Point updated', { layoutId, pointId });
    return updated;
  }

  private async buildContext(layoutId: LayoutId) {
    const [blocks, points] = await Promise.all([
      this.repo.listBlocks(layoutId),
      this.repo.listPoints(layoutId),
    ]);
    return {
      blockIds: new Set(blocks.map((b) => b.id)),
      pointIds: new Set(points.map((p) => p.id)),
    };
  }

  // ─── D10: the topology write-guard ─────────────────────────────────────────
  //
  // `lockView` only reports `active`/`suspended` holders (see
  // `ReservationService`'s `IRouteLockView` implementation) — a
  // `released`/`cancelled` route holds nothing, so it never blocks a write.

  private assertEdgeUnlocked(layoutId: LayoutId, edgeId: BlockEdgeId): void {
    const routeId = this.lockView.findRouteHoldingEdge(layoutId, edgeId);
    if (routeId) {
      this.log.warn('[TopologyService] Rejected edge write — held by an active route', {
        layoutId,
        edgeId,
        routeId,
      });
      throw new LockedByRouteError('edge', edgeId, routeId);
    }
  }

  private assertBlockUnlocked(layoutId: LayoutId, blockId: string): void {
    const routeId = this.lockView.findRouteHoldingBlock(layoutId, blockId);
    if (routeId) {
      this.log.warn('[TopologyService] Rejected block delete — held by an active route', {
        layoutId,
        blockId,
        routeId,
      });
      throw new LockedByRouteError('block', blockId, routeId);
    }
  }

  private assertPointUnlocked(layoutId: LayoutId, pointId: PointId): void {
    const routeId = this.lockView.findRouteHoldingPoint(layoutId, pointId);
    if (routeId) {
      this.log.warn('[TopologyService] Rejected point delete — held by an active route', {
        layoutId,
        pointId,
        routeId,
      });
      throw new LockedByRouteError('point', pointId, routeId);
    }
  }
}
