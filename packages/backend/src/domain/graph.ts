/**
 * Track topology graph for the Layout Orchestrator.
 *
 * Builds an in-memory adjacency structure over `BlockEdge`s and provides pure
 * queries over it. This module deliberately does not do pathfinding,
 * occupancy, or reservation — it only answers "what edges exist" and "which
 * of them are currently traversable given point positions".
 */

import {
  BlockEdge,
  BlockEdgeId,
  BlockEndLabel,
  BlockId,
  LayoutId,
  PointCondition,
  PointId,
  PointPosition,
  TopologyViolation,
} from './types';
import { TopologyInvalidError } from './topology';

// ─── Graph Construction ────────────────────────────────────────────────────────

export interface TrackGraph {
  readonly layoutId: LayoutId;
  readonly edges: ReadonlyMap<BlockEdgeId, BlockEdge>;
  readonly outgoing: ReadonlyMap<BlockId, readonly BlockEdge[]>;
  readonly incoming: ReadonlyMap<BlockId, readonly BlockEdge[]>;
  /**
   * Measured length per block, in mm. Distance is on the block, not the edge
   * (D4, `docs/track-graph-compilation.md`).
   *
   * **An absent key means unmeasured, and the two consumers treat that
   * differently on purpose**: the pathfinder costs it as
   * `DEFAULT_BLOCK_LENGTH_MM` and searches on, because guessing a cost only
   * picks a worse route; the braking model refuses outright, because guessing a
   * stopping distance is a collision (`docs/pathfinding.md` P2).
   */
  readonly blockLengthsMm: ReadonlyMap<BlockId, number>;
}

/**
 * Builds a `TrackGraph` from a flat list of edges.
 * Throws `TopologyInvalidError` on layoutId mismatch, duplicate edge id, or
 * self-loop — these are data integrity errors, not runtime conditions to be
 * handled gracefully. This throw is a typed backstop, not the primary
 * validation path: load-path callers (`services/topologyLoader.ts`) run
 * `validateTopology` first and only call this once no fatal violation
 * remains, so in practice this constructor-time check should never fire
 * outside of tests exercising it directly.
 *
 * `blockLengthsMm` defaults to empty, which reads as "nothing is measured".
 * That is the fail-safe default — braking refuses on an absent entry — which is
 * what makes an optional parameter acceptable here at all.
 */
export function buildTrackGraph(
  layoutId: LayoutId,
  edges: readonly BlockEdge[],
  blockLengthsMm: ReadonlyMap<BlockId, number> = new Map(),
): TrackGraph {
  const edgeMap = new Map<BlockEdgeId, BlockEdge>();
  const outgoing = new Map<BlockId, BlockEdge[]>();
  const incoming = new Map<BlockId, BlockEdge[]>();
  const violations: TopologyViolation[] = [];

  for (const edge of edges) {
    if (edge.layoutId !== layoutId) {
      violations.push({
        kind: 'layout-mismatch',
        edgeId: edge.id,
        expectedLayoutId: layoutId,
        actualLayoutId: edge.layoutId,
      });
    }
    if (edgeMap.has(edge.id)) {
      violations.push({ kind: 'duplicate-edge-id', edgeId: edge.id });
    }
    if (edge.fromBlockId === edge.toBlockId) {
      violations.push({ kind: 'self-loop', edgeId: edge.id, blockId: edge.fromBlockId });
    }

    edgeMap.set(edge.id, edge);

    const from = outgoing.get(edge.fromBlockId) ?? [];
    from.push(edge);
    outgoing.set(edge.fromBlockId, from);

    const to = incoming.get(edge.toBlockId) ?? [];
    to.push(edge);
    incoming.set(edge.toBlockId, to);
  }

  if (violations.length > 0) {
    throw new TopologyInvalidError(violations);
  }

  return { layoutId, edges: edgeMap, outgoing, incoming, blockLengthsMm };
}

/** Edges leaving `blockId`, in the order they were provided to `buildTrackGraph`. */
export function edgesFrom(graph: TrackGraph, blockId: BlockId): readonly BlockEdge[] {
  return graph.outgoing.get(blockId) ?? [];
}

/** Edges arriving at `blockId`, in the order they were provided to `buildTrackGraph`. */
export function edgesTo(graph: TrackGraph, blockId: BlockId): readonly BlockEdge[] {
  return graph.incoming.get(blockId) ?? [];
}

// ─── Traversability ─────────────────────────────────────────────────────────────

/**
 * Returns the conditions on `edge` that are NOT currently satisfied.
 * Fail-safe: a point that is missing from `pointPositions` or whose position
 * is 'unknown' counts as unsatisfied.
 */
export function unsatisfiedConditions(
  edge: BlockEdge,
  pointPositions: ReadonlyMap<PointId, PointPosition>,
): PointCondition[] {
  return edge.pointConditions.filter((condition) => {
    const actual = pointPositions.get(condition.pointId);
    return actual === undefined || actual === 'unknown' || actual !== condition.requiredPosition;
  });
}

/** Whether every condition on `edge` currently holds. */
export function isEdgeTraversable(
  edge: BlockEdge,
  pointPositions: ReadonlyMap<PointId, PointPosition>,
): boolean {
  return unsatisfiedConditions(edge, pointPositions).length === 0;
}

/**
 * Edges leaving `blockId` that are currently traversable.
 * If `options.arrivedAtEnd` is given, edges that would leave by the same end
 * the block was entered by are excluded — no reversal.
 */
export function traversableEdgesFrom(
  graph: TrackGraph,
  blockId: BlockId,
  pointPositions: ReadonlyMap<PointId, PointPosition>,
  options?: { arrivedAtEnd?: BlockEndLabel },
): BlockEdge[] {
  return edgesFrom(graph, blockId).filter((edge) => {
    if (options?.arrivedAtEnd !== undefined && edge.fromEnd === options.arrivedAtEnd) {
      return false;
    }
    return isEdgeTraversable(edge, pointPositions);
  });
}

// ─── Point Conditions ────────────────────────────────────────────────────────────

/**
 * Collects the distinct point conditions across `edges`, de-duplicating
 * identical entries and flagging any point required in both positions.
 */
export function collectPointConditions(edges: readonly BlockEdge[]): {
  conditions: PointCondition[];
  conflicts: PointId[];
} {
  const seen = new Set<string>();
  const conditions: PointCondition[] = [];
  const requiredPositions = new Map<PointId, Set<'normal' | 'reverse'>>();

  for (const edge of edges) {
    for (const condition of edge.pointConditions) {
      const key = `${condition.pointId}:${condition.requiredPosition}`;
      if (!seen.has(key)) {
        seen.add(key);
        conditions.push(condition);
      }

      const positions = requiredPositions.get(condition.pointId) ?? new Set();
      positions.add(condition.requiredPosition);
      requiredPositions.set(condition.pointId, positions);
    }
  }

  const conflicts: PointId[] = [];
  for (const [pointId, positions] of requiredPositions) {
    if (positions.size > 1) {
      conflicts.push(pointId);
    }
  }

  return { conditions, conflicts };
}

// ─── Reachability ─────────────────────────────────────────────────────────────────

/**
 * Blocks reachable from `startBlockId` via currently-traversable edges,
 * including `startBlockId` itself. Breadth-first, cycle-safe.
 */
export function reachableBlocks(
  graph: TrackGraph,
  startBlockId: BlockId,
  pointPositions: ReadonlyMap<PointId, PointPosition>,
): Set<BlockId> {
  const visited = new Set<BlockId>([startBlockId]);
  const queue: BlockId[] = [startBlockId];

  while (queue.length > 0) {
    const blockId = queue.shift() as BlockId;
    for (const edge of traversableEdgesFrom(graph, blockId, pointPositions)) {
      if (!visited.has(edge.toBlockId)) {
        visited.add(edge.toBlockId);
        queue.push(edge.toBlockId);
      }
    }
  }

  return visited;
}
