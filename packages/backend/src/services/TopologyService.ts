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

import { MAX_EDGES_PER_LAYOUT, describeViolations, validateEdgeAgainstLayout, validateTopology } from '../domain/topology';
import { BlockEdge, BlockEdgeId, LayoutId, PointId, TopologyViolation } from '../domain/types';
import { blockLabel, edgeLabel, layoutLabel, pluralise, pointLabel } from '../domain/naming';
import { ILayoutRepository, PointRecord } from '../ports/ILayoutRepository';
import { IRouteLockView } from '../ports/IRouteLockView';
import { INameBook } from '../ports/INameBook';
import { INERT_NAME_BOOK } from './nameBook';

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
    layoutLabelText?: string,
  ) {
    super(`Layout ${layoutLabelText ?? layoutId} already has ${current} edges (limit ${limit})`);
    this.name = 'EdgeLimitExceededError';
  }
}

/** Thrown when an edge id does not resolve to an edge in the given layout. */
export class EdgeNotFoundError extends Error {
  constructor(
    readonly edgeId: BlockEdgeId,
    edgeLabelText?: string,
  ) {
    super(`Edge ${edgeLabelText ?? edgeId} not found`);
    this.name = 'EdgeNotFoundError';
  }
}

/**
 * Thrown when a block or point id does not resolve to a record in the given
 * layout. Deleting by id alone would let a caller destroy another layout's
 * records by supplying any `:layoutId` in the path.
 *
 * The record is already gone by the time this throws, so the book usually
 * misses and this degrades to the bare id — expected, not a bug: there is
 * nothing left to name.
 */
export class RecordNotFoundError extends Error {
  constructor(
    readonly kind: 'block' | 'point',
    readonly recordId: string,
    recordLabelText?: string,
  ) {
    super(`${kind} ${recordLabelText ?? recordId} not found`);
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
    /**
     * `'graph'` is the whole edge set, not one row (#103, D-E). A compiled
     * apply replaces everything and regenerates every end label, so there is no
     * single target to name and no per-target guard that composes into one.
     */
    readonly kind: 'edge' | 'block' | 'point' | 'graph',
    readonly targetId: string,
    readonly routeId: string,
    targetLabelText?: string,
  ) {
    super(`${kind} ${targetLabelText ?? targetId} is held by route ${routeId}`);
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
    private readonly names: INameBook = INERT_NAME_BOOK,
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
        layoutName: this.names.get().layouts.get(layoutId),
        limit: MAX_EDGES_PER_LAYOUT,
        current: existingEdges.length,
      });
      throw new EdgeLimitExceededError(
        layoutId,
        MAX_EDGES_PER_LAYOUT,
        existingEdges.length,
        layoutLabel(layoutId, this.names.get()),
      );
    }

    const context = await this.buildContext(layoutId);

    // A synthetic id (never persisted) lets validateEdgeAgainstLayout's
    // duplicate-connection check run before the real id exists.
    const candidate: BlockEdge = { id: '__pending__', layoutId, ...data };
    const violations = validateEdgeAgainstLayout(candidate, layoutId, context, existingEdges);
    if (violations.length > 0) {
      this.log.warn('[TopologyService] Rejected edge create', { layoutId, violations });
      throw new TopologyRejectedError(violations, describeViolations(violations, this.names.get()));
    }

    const created = await this.repo.createBlockEdge({ layoutId, ...data });
    this.log.info('[TopologyService] Edge created', {
      layoutId,
      edgeId: created.id,
      edgeLabel: edgeLabel(created.id, this.names.get()),
    });
    await this.onTopologyChanged();
    return created;
  }

  /**
   * Replaces this layout's whole edge set with a compiled graph (#103, D1/D3).
   *
   * The only write path for a compiled graph, for exactly the reason
   * `createEdge` is the only one for an authored edge: a second writer is what
   * "one process writes `block_edges`" forbids, and the cheapest way to keep
   * that true is to not build one. `CompileService` compiles and reviews; the
   * write lives here, beside the validation, the route-lock guard and
   * `onTopologyChanged`.
   *
   * **The order below is load-bearing and is the whole of D9: refuse first,
   * write second, never write-then-discover.** `reloadTopology()` applies
   * Safe-Stop when it loads a graph with a fatal violation. So if this method
   * could write rows and *then* have them rejected on reload, an authoring
   * action would halt a running railway — the one thing a compile must never be
   * able to do. Every refusal therefore happens before `replaceBlockEdges` is
   * called at all, and the repository's transaction covers what validation
   * cannot see.
   *
   * A recompile is a **replace, not a merge** (D3). On a layout with
   * hand-authored edges the compile does not reproduce, those edges are gone.
   * That is the design: a mixed graph reintroduces the two-representations
   * problem at a new seam, and the diff review is where the operator sees it
   * coming.
   */
  async replaceGraph(
    layoutId: LayoutId,
    edges: readonly EdgeCreateData[],
    fingerprint: string,
  ): Promise<BlockEdge[]> {
    // 1. Nothing may be held. Not per-edge (D-E): every row is about to be
    //    deleted and rewritten with regenerated labels, so "is *this* edge
    //    held" has no answer worth acting on — the row may not survive, and the
    //    label a live route recorded may not exist afterwards.
    const holder = this.lockView.findAnyHeldRoute(layoutId);
    if (holder) {
      this.log.warn('[TopologyService] Rejected compiled graph — a route holds this layout', {
        layoutId,
        layoutName: this.names.get().layouts.get(layoutId),
        routeId: holder,
      });
      throw new LockedByRouteError(
        'graph',
        layoutId,
        holder,
        layoutLabel(layoutId, this.names.get()),
      );
    }

    // 2. Admission control on the whole candidate set, which is where it always
    //    belonged: a cap on how much graph exists is a statement about the
    //    graph, not about the one row that happened to arrive last.
    if (edges.length > MAX_EDGES_PER_LAYOUT) {
      this.log.warn('[TopologyService] Rejected compiled graph — over the edge cap', {
        layoutId,
        layoutName: this.names.get().layouts.get(layoutId),
        limit: MAX_EDGES_PER_LAYOUT,
        current: edges.length,
      });
      throw new EdgeLimitExceededError(
        layoutId,
        MAX_EDGES_PER_LAYOUT,
        edges.length,
        layoutLabel(layoutId, this.names.get()),
      );
    }

    // 3. Validate the *whole proposed graph*, not each row against the live one.
    //    `validateTopology` is the same full pass the load path runs, so a graph
    //    that passes here is a graph `reloadTopology` will accept — which is
    //    what makes step 4 safe to perform. Synthetic ids: the rows have none
    //    yet, and `duplicate-edge-id` needs something to compare.
    const context = await this.buildContext(layoutId);
    const candidates: BlockEdge[] = edges.map((edge, i) => ({
      id: `__compiled__${i}`,
      layoutId,
      ...edge,
    }));

    const violations = validateTopology(layoutId, candidates, context);
    if (violations.length > 0) {
      this.log.warn('[TopologyService] Rejected compiled graph', {
        layoutId,
        layoutName: this.names.get().layouts.get(layoutId),
        edgeCount: candidates.length,
        violations,
      });
      throw new TopologyRejectedError(violations, describeViolations(violations, this.names.get()));
    }

    // 4. One transaction: the old edges out, the new ones in, the fingerprint
    //    stamped. Nothing partial can survive a failure here.
    const written = await this.repo.replaceBlockEdges(layoutId, edges, fingerprint, new Date());

    this.log.info('[TopologyService] Compiled graph applied', {
      layoutId,
      layoutName: this.names.get().layouts.get(layoutId),
      edgeCount: written.length,
      fingerprint,
    });

    await this.onTopologyChanged();
    return written;
  }

  async updateEdge(layoutId: LayoutId, id: BlockEdgeId, patch: EdgeUpdateData): Promise<BlockEdge> {
    const existing = await this.repo.getBlockEdge(id);
    if (!existing || existing.layoutId !== layoutId) {
      throw new EdgeNotFoundError(id, edgeLabel(id, this.names.get()));
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
        edgeLabel: edgeLabel(id, this.names.get()),
        violations,
      });
      throw new TopologyRejectedError(violations, describeViolations(violations, this.names.get()));
    }

    const updated = await this.repo.updateBlockEdge(id, patch);
    this.log.info('[TopologyService] Edge updated', {
      layoutId,
      edgeId: id,
      edgeLabel: edgeLabel(id, this.names.get()),
    });
    await this.onTopologyChanged();
    return updated;
  }

  async deleteEdge(layoutId: LayoutId, id: BlockEdgeId): Promise<void> {
    const existing = await this.repo.getBlockEdge(id);
    if (!existing || existing.layoutId !== layoutId) {
      throw new EdgeNotFoundError(id, edgeLabel(id, this.names.get()));
    }
    this.assertEdgeUnlocked(layoutId, id);

    await this.repo.deleteBlockEdge(id);
    this.log.info('[TopologyService] Edge deleted', {
      layoutId,
      edgeId: id,
      edgeLabel: edgeLabel(id, this.names.get()),
    });
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
      throw new RecordNotFoundError('block', blockId, blockLabel(blockId, this.names.get()));
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
      blockName: this.names.get().blocks.get(blockId),
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
      throw new RecordNotFoundError('point', pointId, pointLabel(pointId, this.names.get()));
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
        pointName: this.names.get().points.get(pointId),
        referencingEdgeIds,
      });
      // Same truncation posture as describeViolations (D6): the list is
      // bounded only by MAX_EDGES_PER_LAYOUT, so it must be capped here too.
      const book = this.names.get();
      const shown = referencingEdgeIds.slice(0, 5).map((id) => edgeLabel(id, book));
      throw new TopologyRejectedError(
        [],
        `Point ${pointLabel(pointId, book)} is referenced by ${pluralise(referencingEdgeIds.length, 'edge')}: ${shown.join('; ')}${
          referencingEdgeIds.length > 5 ? ' (first 5 shown)' : ''
        }`,
      );
    }

    await this.repo.deletePoint(layoutId, pointId);
    this.log.info('[TopologyService] Point deleted', {
      layoutId,
      pointId,
      pointName: this.names.get().points.get(pointId),
    });
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
      throw new RecordNotFoundError('point', pointId, pointLabel(pointId, this.names.get()));
    }

    const updated = await this.repo.updatePoint(pointId, patch);
    this.log.info('[TopologyService] Point updated', {
      layoutId,
      pointId,
      pointName: updated.name,
    });
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
        edgeLabel: edgeLabel(edgeId, this.names.get()),
        routeId,
      });
      throw new LockedByRouteError('edge', edgeId, routeId, edgeLabel(edgeId, this.names.get()));
    }
  }

  private assertBlockUnlocked(layoutId: LayoutId, blockId: string): void {
    const routeId = this.lockView.findRouteHoldingBlock(layoutId, blockId);
    if (routeId) {
      this.log.warn('[TopologyService] Rejected block delete — held by an active route', {
        layoutId,
        blockId,
        blockName: this.names.get().blocks.get(blockId),
        routeId,
      });
      throw new LockedByRouteError('block', blockId, routeId, blockLabel(blockId, this.names.get()));
    }
  }

  private assertPointUnlocked(layoutId: LayoutId, pointId: PointId): void {
    const routeId = this.lockView.findRouteHoldingPoint(layoutId, pointId);
    if (routeId) {
      this.log.warn('[TopologyService] Rejected point delete — held by an active route', {
        layoutId,
        pointId,
        pointName: this.names.get().points.get(pointId),
        routeId,
      });
      throw new LockedByRouteError('point', pointId, routeId, pointLabel(pointId, this.names.get()));
    }
  }
}
