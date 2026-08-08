/**
 * Route pathfinding (#4). See `docs/pathfinding.md` for the decision record
 * (P1–P8) this module implements.
 *
 * Pure: imports only from `domain/`, calls no clock, mutates nothing. Given a
 * start block, a destination block, and a read-only snapshot of the layout,
 * it returns an **ordered edge list** — exactly the input
 * `ReservationService.grant` already took before this existed. The pathfinder
 * proposes; `planReservation` still disposes. Every safety precondition
 * checked here is checked again there against the same snapshot, deliberately:
 * this module is an optimiser over the graph, not a second source of truth
 * about what may be reserved (P6).
 *
 * What it does NOT do:
 *  - It does not consider current point positions. Setting the road is what a
 *    route *is*; refusing to route through a point because it happens to be
 *    thrown the wrong way now would be backwards (P3).
 *  - It does not search around a point-position conflict (P5), and it does not
 *    model fouling at a plain diamond crossing (#26) — the locking model
 *    behind it does not either.
 */

import {
  BlockEdge,
  BlockEdgeId,
  BlockEndLabel,
  BlockId,
  BlockState,
  Occupancy,
  PathBlocker,
  PointId,
  PointState,
} from './types';
import { TrackGraph, collectPointConditions, edgesFrom } from './graph';
import { isBlockEffectivelyOccupied } from './safety';

/**
 * Cost assigned to an edge whose `lengthMm` is NULL (P2). `lengthMm` is
 * optional on `block_edges` and much of a layout is authored without it, so
 * the search must not simply refuse to cost those edges. A single constant
 * makes an unmeasured stretch of track behave like an average one: on a
 * layout with no lengths recorded at all, every edge costs the same and
 * Dijkstra degenerates to a fewest-hops search, which is the sensible
 * fallback. Deliberately NOT zero (which would make unmeasured track free
 * and always preferred) and not Infinity (which would make it impassable).
 */
export const DEFAULT_EDGE_LENGTH_MM = 1000;

/** Cap on how many `PathBlocker`s a `no-path` result reports, so a large layout cannot produce an unbounded diagnostic string. Same posture as `describeViolations`' truncation. */
export const MAX_REPORTED_BLOCKERS = 20;

export interface PathfindingRequest {
  startBlockId: BlockId;
  destinationBlockId: BlockId;
  /**
   * Optional constraint on which end of the start block the train leaves by
   * (P4). Loco orientation is not modelled anywhere in this system, so
   * without this the search is free to route a train "backwards" out of its
   * current block. This lets the caller — an operator who can see which way
   * the loco faces — say so. Omitted means either end is acceptable.
   */
  startExitEnd?: BlockEndLabel;
}

/**
 * A read-only snapshot of everything `findPath` needs. Built by
 * `ReservationService` from the same `LayoutStateManager` state that builds
 * `ReservationView`, so the search and the plan see one consistent picture.
 */
export interface PathfindingView {
  graph: TrackGraph;
  blocks: ReadonlyMap<BlockId, BlockState>;
  points: ReadonlyMap<PointId, PointState>;
}

export type PathfindingFailure =
  | { kind: 'unknown-block'; blockId: BlockId }
  | { kind: 'destination-is-start'; blockId: BlockId }
  | { kind: 'point-position-conflict'; pointIds: PointId[] }
  | { kind: 'no-path'; blockers: PathBlocker[] };

export type PathfindingResult =
  | { found: true; edgeIds: BlockEdgeId[] }
  | { found: false; reason: PathfindingFailure };

/**
 * Finds the lowest-cost traversable path from `startBlockId` to
 * `destinationBlockId`, or reports why there is none.
 *
 * Dijkstra over a state space of **(block, end entered by)** rather than
 * plain blocks (P1). That is what makes the no-reversal rule expressible: a
 * train that entered block B by its north end may only leave by some other
 * end, so "B entered from the north" and "B entered from the south" are
 * genuinely different search states with different successors. A plain
 * block-keyed search cannot represent that and will happily return paths
 * that require a train to reverse through a junction it has just passed.
 *
 * An edge is usable only if the block it leads to is positively `clear` and
 * unlocked, and every point it depends on is unlocked. `unknown` occupancy is
 * not routable — `isBlockEffectivelyOccupied` is the shared fail-safe rule,
 * and using it here rather than an open-coded `!== 'clear'` is what keeps
 * "unknown means occupied" a single decision (CLAUDE.md safety rule 1).
 */
export function findPath(request: PathfindingRequest, view: PathfindingView): PathfindingResult {
  const { startBlockId, destinationBlockId } = request;

  if (!view.blocks.has(startBlockId)) {
    return { found: false, reason: { kind: 'unknown-block', blockId: startBlockId } };
  }
  if (!view.blocks.has(destinationBlockId)) {
    return { found: false, reason: { kind: 'unknown-block', blockId: destinationBlockId } };
  }
  if (startBlockId === destinationBlockId) {
    return { found: false, reason: { kind: 'destination-is-start', blockId: startBlockId } };
  }

  const blockers = new BlockerSet();
  const startKey = nodeKey(startBlockId, null);

  const distance = new Map<string, number>([[startKey, 0]]);
  const previous = new Map<string, { edge: BlockEdge; from: string }>();
  const settled = new Set<string>();
  const frontier = new MinHeap<QueueEntry>(compareQueueEntries);
  frontier.push({ key: startKey, cost: 0 });

  while (!frontier.isEmpty()) {
    const current = frontier.pop() as QueueEntry;
    if (settled.has(current.key)) continue;
    settled.add(current.key);

    const { blockId, entryEnd } = parseNodeKey(current.key);
    if (blockId === destinationBlockId) {
      return finish(reconstruct(previous, current.key));
    }

    for (const edge of edgesFrom(view.graph, blockId)) {
      // No reversal: never leave by the end we arrived through. The start
      // node has no arrival end, so it is governed by `startExitEnd` instead.
      if (entryEnd !== null && edge.fromEnd === entryEnd) continue;
      if (
        current.key === startKey &&
        request.startExitEnd !== undefined &&
        edge.fromEnd !== request.startExitEnd
      ) {
        continue;
      }

      // Re-entering the start block is never useful: `planReservation`
      // requires every block after the first to be clear, and the start block
      // is occupied by definition (it holds the loco), so such a path could
      // only ever be rejected. Refusing it here keeps the search from
      // proposing something the planner is guaranteed to refuse.
      if (edge.toBlockId === startBlockId) {
        blockers.add({ kind: 'returns-to-start', blockId: startBlockId });
        continue;
      }

      const target = view.blocks.get(edge.toBlockId);
      const occupancy: Occupancy = target?.occupancy ?? 'unknown';
      if (isBlockEffectivelyOccupied(occupancy)) {
        blockers.add({ kind: 'block-not-clear', blockId: edge.toBlockId, occupancy });
        continue;
      }
      if (target?.lockedByRoute) {
        blockers.add({ kind: 'block-locked', blockId: edge.toBlockId, heldBy: target.lockedByRoute });
        continue;
      }

      // A point another route holds cannot be moved for this one (D2's
      // exclusivity), so an edge depending on it is not usable — regardless
      // of which position that route holds it in. A point lock is an
      // authority lock: "no other authority will command this point".
      const lockedPoint = findLockedPoint(edge, view.points);
      if (lockedPoint) {
        blockers.add(lockedPoint);
        continue;
      }

      relax(edge, current, distance, previous, settled, frontier);
    }
  }

  return { found: false, reason: { kind: 'no-path', blockers: blockers.toArray() } };
}

// ─── Search internals ─────────────────────────────────────────────────────────

interface QueueEntry {
  key: string;
  cost: number;
}

/**
 * Cost first, then node key. The key tie-break is what makes the search
 * deterministic: two equal-cost frontier entries must pop in a defined order
 * or the same request can return different (equally short) paths between
 * runs, which is miserable to test and worse to debug against a live layout.
 */
function compareQueueEntries(a: QueueEntry, b: QueueEntry): number {
  if (a.cost !== b.cost) return a.cost - b.cost;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function relax(
  edge: BlockEdge,
  current: QueueEntry,
  distance: Map<string, number>,
  previous: Map<string, { edge: BlockEdge; from: string }>,
  settled: ReadonlySet<string>,
  frontier: MinHeap<QueueEntry>,
): void {
  const nextKey = nodeKey(edge.toBlockId, edge.toEnd);
  if (settled.has(nextKey)) return;

  const cost = current.cost + (edge.lengthMm ?? DEFAULT_EDGE_LENGTH_MM);
  const known = distance.get(nextKey);

  if (known === undefined || cost < known) {
    distance.set(nextKey, cost);
    previous.set(nextKey, { edge, from: current.key });
    frontier.push({ key: nextKey, cost });
    return;
  }

  // Equal cost by a different route in: prefer the smaller edge id, so the
  // chosen path does not depend on the order edges came out of the database.
  // No re-push — the node is already on the frontier at this exact cost.
  if (cost === known) {
    const incumbent = previous.get(nextKey);
    if (incumbent && edge.id < incumbent.edge.id) {
      previous.set(nextKey, { edge, from: current.key });
    }
  }
}

/** Walks `previous` back from the goal to the start. The map is a tree rooted at the start node, so this terminates. */
function reconstruct(
  previous: ReadonlyMap<string, { edge: BlockEdge; from: string }>,
  goalKey: string,
): BlockEdge[] {
  const edges: BlockEdge[] = [];
  let key = goalKey;
  for (;;) {
    const step = previous.get(key);
    if (!step) break;
    edges.push(step.edge);
    key = step.from;
  }
  return edges.reverse();
}

/**
 * Final gate on a found path (P5). A path that needs one point in both
 * positions cannot be set, and `planReservation` would reject it — so it is
 * reported here as its own failure rather than handed on to be refused a
 * layer later with a less useful message.
 *
 * The search does **not** backtrack to look for an alternative path avoiding
 * the conflict. That would require carrying the set of point commitments in
 * the search state, which is exponential in the worst case, to solve a case
 * that needs a path passing through one junction twice in opposite
 * positions. Recorded as a known limit in `docs/pathfinding.md` rather than
 * silently mis-answered.
 */
function finish(pathEdges: readonly BlockEdge[]): PathfindingResult {
  const { conflicts } = collectPointConditions(pathEdges);
  if (conflicts.length > 0) {
    return { found: false, reason: { kind: 'point-position-conflict', pointIds: conflicts } };
  }
  return { found: true, edgeIds: pathEdges.map((edge) => edge.id) };
}

function findLockedPoint(
  edge: BlockEdge,
  points: ReadonlyMap<PointId, PointState>,
): (PathBlocker & { kind: 'point-locked' }) | null {
  for (const condition of edge.pointConditions) {
    const point = points.get(condition.pointId);
    if (point?.lockedByRoute) {
      return { kind: 'point-locked', pointId: condition.pointId, heldBy: point.lockedByRoute };
    }
  }
  return null;
}

// ─── Node keys ────────────────────────────────────────────────────────────────

/**
 * Block ids and end labels are both operator-influenced strings, so they are
 * joined with a NUL — a character neither `blockEndLabelSchema`'s slug
 * pattern nor a practical id can contain — rather than a `:` or `-` an id
 * could legitimately carry, which would let two distinct nodes collide on
 * one key.
 */
const KEY_SEPARATOR = '\u0000';

function nodeKey(blockId: BlockId, entryEnd: BlockEndLabel | null): string {
  return `${blockId}${KEY_SEPARATOR}${entryEnd ?? ''}`;
}

function parseNodeKey(key: string): { blockId: BlockId; entryEnd: BlockEndLabel | null } {
  const index = key.indexOf(KEY_SEPARATOR);
  const entryEnd = key.slice(index + 1);
  return { blockId: key.slice(0, index), entryEnd: entryEnd === '' ? null : entryEnd };
}

// ─── Blocker collection ───────────────────────────────────────────────────────

/** De-duplicates blockers and caps the total, so a wide layout reports "block 4 is occupied" once rather than once per edge into it. */
class BlockerSet {
  private readonly seen = new Set<string>();
  private readonly items: PathBlocker[] = [];

  add(blocker: PathBlocker): void {
    if (this.items.length >= MAX_REPORTED_BLOCKERS) return;
    const key = JSON.stringify(blocker);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push(blocker);
  }

  toArray(): PathBlocker[] {
    return [...this.items];
  }
}

// ─── Min-heap ─────────────────────────────────────────────────────────────────

/**
 * A binary min-heap, so the search is O(E log V) rather than the O(V²) a
 * scan-for-minimum would give. `MAX_EDGES_PER_LAYOUT` is 2,000 (#21), and a
 * route grant runs this on the request path, so the quadratic version is not
 * obviously fine — same reasoning that made topology validation index-backed.
 */
class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (a: T, b: T) => number) {}

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  push(item: T): void {
    this.items.push(item);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.compare(this.items[index], this.items[parent]) >= 0) break;
      this.swap(index, parent);
      index = parent;
    }
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined;
    const top = this.items[0];
    const last = this.items.pop() as T;
    if (this.items.length === 0) return top;

    this.items[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.compare(this.items[left], this.items[smallest]) < 0) {
        smallest = left;
      }
      if (right < this.items.length && this.compare(this.items[right], this.items[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === index) break;
      this.swap(index, smallest);
      index = smallest;
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const tmp = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = tmp;
  }
}

// ─── Description ──────────────────────────────────────────────────────────────

/** Human-readable summary of one blocker, for `describeRejections` and log messages. */
export function describeBlocker(blocker: PathBlocker): string {
  switch (blocker.kind) {
    case 'block-not-clear':
      return `block ${blocker.blockId} is ${blocker.occupancy}`;
    case 'block-locked':
      return `block ${blocker.blockId} is locked by route ${blocker.heldBy}`;
    case 'point-locked':
      return `point ${blocker.pointId} is locked by route ${blocker.heldBy}`;
    case 'returns-to-start':
      return `paths returning to the start block ${blocker.blockId} were not considered`;
  }
}
