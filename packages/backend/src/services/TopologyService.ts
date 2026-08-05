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

import { validateEdgeAgainstLayout } from '../domain/topology';
import { BlockEdge, BlockEdgeId, LayoutId, PointId, TopologyViolation } from '../domain/types';
import { ILayoutRepository } from '../ports/ILayoutRepository';

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

export type EdgeCreateData = Omit<BlockEdge, 'id' | 'layoutId'>;
export type EdgeUpdateData = Partial<Omit<BlockEdge, 'id' | 'layoutId'>>;

export class TopologyService {
  constructor(
    private readonly repo: ILayoutRepository,
    private readonly onTopologyChanged: () => Promise<unknown>,
    private readonly log: TopologyServiceLogger,
  ) {}

  async listEdges(layoutId: LayoutId): Promise<BlockEdge[]> {
    return this.repo.listBlockEdges(layoutId);
  }

  async getStatus(layoutId: LayoutId): Promise<TopologyStatus> {
    const edges = await this.repo.listBlockEdges(layoutId);
    const context = await this.buildContext(layoutId);
    const violations = edges.flatMap((edge) =>
      validateEdgeAgainstLayout(edge, layoutId, context, edges),
    );
    return { valid: violations.length === 0, violations, edgeCount: edges.length };
  }

  async createEdge(layoutId: LayoutId, data: EdgeCreateData): Promise<BlockEdge> {
    const existingEdges = await this.repo.listBlockEdges(layoutId);
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

    const edges = await this.repo.listBlockEdges(layoutId);
    const removedEdges = edges.filter(
      (edge) => edge.fromBlockId === blockId || edge.toBlockId === blockId,
    ).length;

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
}
