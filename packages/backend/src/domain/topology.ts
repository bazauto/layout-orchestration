/**
 * Topology validation for the Layout Orchestrator.
 *
 * Pure functions that check a set of `BlockEdge`s against the rest of the
 * layout (known blocks, known points, each other) and report every problem
 * found, rather than stopping at the first one. Callers decide what to do
 * with the result: `graph.ts` treats any violation as fatal to graph
 * construction; the load path (`services/topologyLoader.ts`) partitions
 * violations by `isFatalViolation` and may still build a degraded graph.
 */

import { BlockEdge, BlockEdgeId, BlockId, LayoutId, PointId, TopologyViolation } from './types';

export interface TopologyContext {
  blockIds: ReadonlySet<BlockId>;
  pointIds: ReadonlySet<PointId>;
}

/**
 * Validates a single edge against the layout it claims to belong to, the
 * known blocks/points, and the other edges already present. `existingEdges`
 * should be the full edge list for the layout; `edge.id` is excluded from
 * the duplicate-connection check so re-validating an edge against a list
 * that already contains it (e.g. re-saving it unchanged) is not flagged as
 * conflicting with itself.
 */
export function validateEdgeAgainstLayout(
  edge: BlockEdge,
  layoutId: LayoutId,
  context: TopologyContext,
  existingEdges: readonly BlockEdge[],
): TopologyViolation[] {
  const violations: TopologyViolation[] = [];

  if (edge.layoutId !== layoutId) {
    violations.push({
      kind: 'layout-mismatch',
      edgeId: edge.id,
      expectedLayoutId: layoutId,
      actualLayoutId: edge.layoutId,
    });
  }

  if (edge.fromBlockId === edge.toBlockId) {
    violations.push({ kind: 'self-loop', edgeId: edge.id, blockId: edge.fromBlockId });
  }

  if (!context.blockIds.has(edge.fromBlockId)) {
    violations.push({ kind: 'unknown-block', edgeId: edge.id, blockId: edge.fromBlockId });
  }
  if (!context.blockIds.has(edge.toBlockId)) {
    violations.push({ kind: 'unknown-block', edgeId: edge.id, blockId: edge.toBlockId });
  }

  for (const condition of edge.pointConditions) {
    if (!context.pointIds.has(condition.pointId)) {
      violations.push({ kind: 'unknown-point', edgeId: edge.id, pointId: condition.pointId });
    }
  }

  const conflicting = existingEdges.find(
    (other) =>
      other.id !== edge.id &&
      other.fromBlockId === edge.fromBlockId &&
      other.fromEnd === edge.fromEnd &&
      other.toBlockId === edge.toBlockId &&
      other.toEnd === edge.toEnd,
  );
  if (conflicting) {
    violations.push({
      kind: 'duplicate-connection',
      edgeId: edge.id,
      conflictingEdgeId: conflicting.id,
    });
  }

  return violations;
}

/**
 * Validates a full edge list for a layout. Returns every violation found —
 * there is deliberately no early return, so a caller can report (or, for
 * non-fatal kinds, tolerate) all of them at once rather than fixing one and
 * re-running to discover the next.
 */
export function validateTopology(
  layoutId: LayoutId,
  edges: readonly BlockEdge[],
  context: TopologyContext,
): TopologyViolation[] {
  const violations: TopologyViolation[] = [];
  const seenIds = new Set<BlockEdgeId>();

  for (const edge of edges) {
    if (seenIds.has(edge.id)) {
      violations.push({ kind: 'duplicate-edge-id', edgeId: edge.id });
    }
    seenIds.add(edge.id);

    violations.push(...validateEdgeAgainstLayout(edge, layoutId, context, edges));
  }

  return violations;
}

/**
 * Whether a violation must block graph construction. `unknown-point` is the
 * sole exception: a point condition referencing a point that no longer
 * exists makes that one edge permanently non-traversable (fails closed, per
 * `unsatisfiedConditions` in `./graph`) without invalidating the rest of the
 * graph, so the layout can stay online rather than Safe-Stopping.
 */
export function isFatalViolation(violation: TopologyViolation): boolean {
  return violation.kind !== 'unknown-point';
}

function describeViolation(violation: TopologyViolation): string {
  switch (violation.kind) {
    case 'layout-mismatch':
      return `edge ${violation.edgeId} belongs to layout ${violation.actualLayoutId}, not ${violation.expectedLayoutId}`;
    case 'duplicate-edge-id':
      return `duplicate edge id ${violation.edgeId}`;
    case 'self-loop':
      return `edge ${violation.edgeId} is a self-loop on block ${violation.blockId}`;
    case 'unknown-block':
      return `edge ${violation.edgeId} references unknown block ${violation.blockId}`;
    case 'unknown-point':
      return `edge ${violation.edgeId} references unknown point ${violation.pointId}`;
    case 'duplicate-connection':
      return `edge ${violation.edgeId} duplicates the connection already defined by edge ${violation.conflictingEdgeId}`;
  }
}

/**
 * Human-readable summary of a violation list, for log messages and Safe-Stop
 * reasons. Lists at most the first three violations to keep the reason
 * string (which ends up on `system/status.reason` over MQTT) bounded.
 */
export function describeViolations(violations: readonly TopologyViolation[]): string {
  const shown = violations.slice(0, 3).map(describeViolation);
  return `Topology invalid: ${violations.length} violation(s) — ${shown.join('; ')}`;
}

/** Thrown by `graph.ts` when a `TrackGraph` cannot be built from the given edges. */
export class TopologyInvalidError extends Error {
  readonly violations: TopologyViolation[];

  constructor(violations: TopologyViolation[]) {
    super(describeViolations(violations));
    this.name = 'TopologyInvalidError';
    this.violations = violations;
  }
}
