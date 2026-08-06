/**
 * Topology validation for the Layout Orchestrator.
 *
 * Pure functions that check a set of `BlockEdge`s against the rest of the
 * layout (known blocks, known points, each other) and report every problem
 * found, rather than stopping at the first one. Callers decide what to do
 * with the result: `graph.ts` treats any violation as fatal to graph
 * construction; the load path (`services/topologyLoader.ts`) partitions
 * violations by `isFatalViolation` and may still build a degraded graph.
 *
 * Duplicate-connection detection (see `buildEdgeIndex`) is index-backed so a
 * full-layout pass (`validateTopology`) is O(n) rather than O(n^2) — see
 * `docs/topology.md`, "Validation cost, the edge cap, and why the full pass
 * stays", for the reasoning (#21).
 */

import { BlockEdge, BlockEdgeId, BlockId, LayoutId, PointId, TopologyViolation } from './types';

export interface TopologyContext {
  blockIds: ReadonlySet<BlockId>;
  pointIds: ReadonlySet<PointId>;
}

/**
 * Per-layout admission-control ceiling on edge count, enforced by
 * `TopologyService.createEdge` only — not a DB invariant (see
 * `docs/topology.md` for why) and deliberately not enforced on the load
 * path, which must still be able to load and let an operator delete their
 * way back under the cap. Chosen as ~50x a large club-scale layout (~1,200
 * edges for 200 blocks); the seeded Westgate Hollow layout is ~40. Lives here
 * because it's layout vocabulary, not service configuration.
 */
export const MAX_EDGES_PER_LAYOUT = 2000;

/** Separator for the duplicate-connection tuple key in `buildEdgeIndex`.
 * Block ids are UUIDs today but `fromEnd`/`toEnd` are free text matching
 * `/^[a-z0-9][a-z0-9_-]*$/` — `^@` cannot appear in either field, so there is
 * no ambiguity between e.g. `a` + `^@b` and `a^@` + `b`. */
const TUPLE_SEPARATOR = '^@';

function connectionKey(edge: Pick<BlockEdge, 'fromBlockId' | 'fromEnd' | 'toBlockId' | 'toEnd'>): string {
  return [edge.fromBlockId, edge.fromEnd, edge.toBlockId, edge.toEnd].join(TUPLE_SEPARATOR);
}

/**
 * An index over an edge list's connection tuples, built once per validation
 * pass so `validateTopology` can do duplicate-connection detection in O(n)
 * instead of the O(n^2) `Array#find` scan `validateEdgeAgainstLayout` used to
 * do per edge.
 *
 * Two slots per bucket suffice. The original check was `existingEdges.find(o
 * => o.id !== edge.id && sameTuple)` — the *first* edge in list order whose
 * id is not the edge being checked. If the bucket's first id is not that
 * edge's, that's the answer; if it is, the second slot is. Any third or
 * later edge sharing the tuple is never the answer under the old semantics
 * either, so a two-slot bucket reproduces `find`'s result byte-for-byte,
 * including on three-way (or more) duplicates.
 */
export interface EdgeIndex {
  readonly byConnection: ReadonlyMap<string, { first: BlockEdgeId; second: BlockEdgeId | null }>;
}

/** Builds an `EdgeIndex` from a full edge list. O(n). */
export function buildEdgeIndex(edges: readonly BlockEdge[]): EdgeIndex {
  const byConnection = new Map<string, { first: BlockEdgeId; second: BlockEdgeId | null }>();
  for (const edge of edges) {
    const key = connectionKey(edge);
    const bucket = byConnection.get(key);
    if (!bucket) {
      byConnection.set(key, { first: edge.id, second: null });
    } else if (bucket.second === null) {
      bucket.second = edge.id;
    }
  }
  return { byConnection };
}

/** Looks up the id that `edge` conflicts with in `index`, if any, using the
 * first/second-slot equivalence documented on `EdgeIndex`. */
function findConflictingEdgeId(edge: BlockEdge, index: EdgeIndex): BlockEdgeId | undefined {
  const bucket = index.byConnection.get(connectionKey(edge));
  if (!bucket) return undefined;
  if (bucket.first !== edge.id) return bucket.first;
  return bucket.second ?? undefined;
}

/**
 * Validates a single edge against the layout it claims to belong to, the
 * known blocks/points, and the other edges already present. `existingEdges`
 * should be the full edge list for the layout (or a prebuilt `EdgeIndex` over
 * it — see `buildEdgeIndex`); `edge.id` is excluded from the
 * duplicate-connection check so re-validating an edge against a list that
 * already contains it (e.g. re-saving it unchanged) is not flagged as
 * conflicting with itself.
 */
export function validateEdgeAgainstLayout(
  edge: BlockEdge,
  layoutId: LayoutId,
  context: TopologyContext,
  existingEdges: readonly BlockEdge[] | EdgeIndex,
): TopologyViolation[] {
  const violations: TopologyViolation[] = [];
  const index = Array.isArray(existingEdges) ? buildEdgeIndex(existingEdges) : existingEdges;

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

  const conflictingEdgeId = findConflictingEdgeId(edge, index);
  if (conflictingEdgeId !== undefined) {
    violations.push({
      kind: 'duplicate-connection',
      edgeId: edge.id,
      conflictingEdgeId,
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
  const index = buildEdgeIndex(edges);

  for (const edge of edges) {
    if (seenIds.has(edge.id)) {
      violations.push({ kind: 'duplicate-edge-id', edgeId: edge.id });
    }
    seenIds.add(edge.id);

    violations.push(...validateEdgeAgainstLayout(edge, layoutId, context, index));
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
