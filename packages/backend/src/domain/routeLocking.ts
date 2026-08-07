/**
 * Route locking: the pure planning and release logic behind `RouteReservation`.
 * See `docs/route-locking.md` for the full decision record (D1–D14) this
 * module implements. No imports outside `domain/` — this stays pure and
 * deterministic, same posture as `domain/topology.ts`.
 *
 * The two entry points:
 *  - `planReservation` computes an entire grant (or every rejection) from a
 *    snapshot view of the layout. It mutates nothing — `ReservationService`
 *    is the only thing that commits a grant's locks, and does so with no
 *    `await` between calling this and applying the result (D3).
 *  - `evaluateOccupancyChange` / `holdsReleasableAt` implement progressive
 *    (tail-first) release (D5) and unexpected-occupancy detection (D7).
 */

import {
  Authority,
  BlockEdge,
  BlockEdgeId,
  BlockId,
  BlockState,
  LayoutId,
  LocoAddress,
  Occupancy,
  PointId,
  PointState,
  RouteHold,
  RouteId,
  RoutePathStep,
  RouteReservation,
  RouteRejection,
  SystemStatus,
} from './types';
import { TrackGraph, collectPointConditions } from './graph';
import { canGrantRoute, isBlockEffectivelyOccupied } from './safety';

// ─── Planning ───────────────────────────────────────────────────────────────

/**
 * A request to reserve an explicit, ordered path. Pathfinding (#4) produces
 * `edgeIds`; this module never searches the graph, only validates and locks
 * a path already chosen.
 */
export interface ReservationRequest {
  layoutId: LayoutId;
  locoAddress: LocoAddress;
  authority: Authority;
  startBlockId: BlockId;
  /** Ordered edge ids forming the path. Empty is a rejection (`empty-path`). */
  edgeIds: BlockEdgeId[];
}

/**
 * A read-only snapshot of everything `planReservation` needs to judge a
 * request. Built by `ReservationService` from `LayoutStateManager` and the
 * running `TrackGraph` — never touches the repository or a clock itself, so
 * this stays a pure function of its inputs.
 */
export interface ReservationView {
  systemStatus: SystemStatus;
  graph: TrackGraph | null;
  blocks: ReadonlyMap<BlockId, BlockState>;
  points: ReadonlyMap<PointId, PointState>;
  /** Every `active` or `suspended` reservation in the layout — `released`/`cancelled` hold nothing and are excluded. */
  holding: readonly RouteReservation[];
  knownLocoAddresses: ReadonlySet<LocoAddress>;
}

export type GrantResult =
  | { granted: true; reservation: RouteReservation }
  | { granted: false; rejections: RouteRejection[] };

/**
 * Computes an entire grant, or every reason it cannot be granted (D14 — no
 * early return). Pure: mutates neither `view` nor its own inputs. On
 * success, returns a fully-formed `RouteReservation` with status `active`,
 * `confirmedIndex: 0` (the operator's assertion that the loco is in the
 * start block — see D13 — counts as the first confirmation), and every
 * block/point/edge hold computed with its `releaseAfterIndex`.
 */
export function planReservation(
  request: ReservationRequest,
  view: ReservationView,
  routeId: RouteId,
  now: Date,
): GrantResult {
  const rejections: RouteRejection[] = [];

  if (!canGrantRoute(view.systemStatus)) {
    rejections.push({ kind: 'system-not-online', status: view.systemStatus });
  }
  if (request.edgeIds.length === 0) {
    rejections.push({ kind: 'empty-path' });
  }
  if (!view.knownLocoAddresses.has(request.locoAddress)) {
    rejections.push({ kind: 'unknown-loco', locoAddress: request.locoAddress });
  }
  const existingForLoco = view.holding.find((r) => r.locoAddress === request.locoAddress);
  if (existingForLoco) {
    rejections.push({
      kind: 'loco-already-routed',
      locoAddress: request.locoAddress,
      routeId: existingForLoco.id,
    });
  }
  if (view.graph === null) {
    rejections.push({ kind: 'no-graph' });
  }

  // Nothing below is resolvable without a graph and a non-empty path — the
  // rejections collected above already cover both, so stop here rather than
  // fabricating a path over a null graph.
  if (view.graph === null || request.edgeIds.length === 0) {
    return { granted: false, rejections };
  }
  const graph = view.graph;

  // Resolve every edge id up front, one rejection per id that doesn't
  // resolve — every unknown edge is reported, not just the first (D14).
  const resolvedEdges: (BlockEdge | undefined)[] = request.edgeIds.map((edgeId) =>
    graph.edges.get(edgeId),
  );
  resolvedEdges.forEach((edge, i) => {
    if (!edge) {
      rejections.push({ kind: 'unknown-edge', edgeId: request.edgeIds[i] });
    }
  });

  // Walk the chain of blocks the path visits. Stops extending the chain (but
  // does not stop collecting other, independent rejections above) the
  // moment an edge is unresolved or disconnected — beyond that point the
  // block sequence is unknowable.
  const pathBlockIds: BlockId[] = [request.startBlockId];
  const pathEdges: BlockEdge[] = [];
  let currentBlockId = request.startBlockId;
  let arrivedAtEnd: string | undefined;
  let chainIntact = true;

  for (let i = 0; i < resolvedEdges.length; i++) {
    const edge = resolvedEdges[i];
    if (!edge) {
      chainIntact = false;
      break;
    }
    if (edge.fromBlockId !== currentBlockId) {
      rejections.push({ kind: 'path-not-connected', index: i });
      chainIntact = false;
      break;
    }
    if (arrivedAtEnd !== undefined && edge.fromEnd === arrivedAtEnd) {
      rejections.push({ kind: 'reversal-at-block', blockId: currentBlockId });
      // A reversal doesn't make the rest of the chain unknowable — keep walking.
    }
    pathEdges.push(edge);
    currentBlockId = edge.toBlockId;
    arrivedAtEnd = edge.toEnd;
    pathBlockIds.push(currentBlockId);
  }

  if (!chainIntact) {
    return { granted: false, rejections };
  }

  // ── Grant preconditions over the fully-known chain (D13) ──────────────────

  const startBlock = view.blocks.get(request.startBlockId);
  const startOccupancy = startBlock?.occupancy ?? 'unknown';
  if (startOccupancy !== 'occupied') {
    rejections.push({
      kind: 'start-block-not-occupied',
      blockId: request.startBlockId,
      occupancy: startOccupancy,
    });
  } else if (startBlock!.locoAddress !== null && startBlock!.locoAddress !== request.locoAddress) {
    rejections.push({
      kind: 'start-block-holds-other-loco',
      blockId: request.startBlockId,
      locoAddress: startBlock!.locoAddress,
    });
  }
  if (startBlock?.lockedByRoute) {
    rejections.push({
      kind: 'block-locked',
      blockId: request.startBlockId,
      heldBy: startBlock.lockedByRoute,
    });
  }

  for (const blockId of pathBlockIds.slice(1)) {
    const block = view.blocks.get(blockId);
    const occupancy = block?.occupancy ?? 'unknown';
    if (isBlockEffectivelyOccupied(occupancy)) {
      rejections.push({ kind: 'block-not-clear', blockId, occupancy });
    }
    if (block?.lockedByRoute) {
      rejections.push({ kind: 'block-locked', blockId, heldBy: block.lockedByRoute });
    }
  }

  const { conditions: pointConditions, conflicts } = collectPointConditions(pathEdges);
  for (const pointId of conflicts) {
    rejections.push({ kind: 'point-position-conflict', pointId });
  }
  // A conflicting point appears twice in `pointConditions` (once per
  // position — see collectPointConditions) — checked once each, not
  // reported as locked twice over.
  const checkedPointLocks = new Set<PointId>();
  for (const condition of pointConditions) {
    if (checkedPointLocks.has(condition.pointId)) continue;
    checkedPointLocks.add(condition.pointId);
    const point = view.points.get(condition.pointId);
    if (point?.lockedByRoute) {
      rejections.push({ kind: 'point-locked', pointId: condition.pointId, heldBy: point.lockedByRoute });
    }
  }

  if (rejections.length > 0) {
    return { granted: false, rejections };
  }

  // ── Build the reservation ──────────────────────────────────────────────

  const path = buildPath(request.startBlockId, pathEdges);
  const holds = buildHolds(pathBlockIds, pathEdges);

  const reservation: RouteReservation = {
    id: routeId,
    layoutId: request.layoutId,
    locoAddress: request.locoAddress,
    authority: request.authority,
    status: 'active',
    path,
    holds,
    confirmedIndex: 0,
    reason: null,
    createdAt: now,
    updatedAt: now,
  };

  return { granted: true, reservation };
}

function buildPath(startBlockId: BlockId, pathEdges: readonly BlockEdge[]): RoutePathStep[] {
  const steps: RoutePathStep[] = [
    {
      edgeId: null,
      blockId: startBlockId,
      entryEnd: null,
      exitEnd: pathEdges[0]?.fromEnd ?? null,
    },
  ];
  for (let i = 0; i < pathEdges.length; i++) {
    const edge = pathEdges[i];
    const next = pathEdges[i + 1];
    steps.push({
      edgeId: edge.id,
      blockId: edge.toBlockId,
      entryEnd: edge.toEnd,
      exitEnd: next?.fromEnd ?? null,
    });
  }
  return steps;
}

function buildHolds(pathBlockIds: readonly BlockId[], pathEdges: readonly BlockEdge[]): RouteHold[] {
  const holds: RouteHold[] = [];

  // Block holds: releaseAfterIndex is the LAST path index this block
  // occupies — a block visited twice (unusual, but not structurally
  // forbidden here) stays locked until the train is behind every visit.
  const lastBlockIndex = new Map<BlockId, number>();
  pathBlockIds.forEach((blockId, index) => lastBlockIndex.set(blockId, index));
  for (const [blockId, releaseAfterIndex] of lastBlockIndex) {
    holds.push({ kind: 'block', targetId: blockId, requiredPosition: null, releaseAfterIndex, released: false });
  }

  // Edge holds: releaseAfterIndex is the SOURCE step index (pathEdges[i]
  // leaves pathBlockIds[i] for pathBlockIds[i+1]) — the train has fully
  // traversed the edge once confirmed strictly past the block it left from.
  pathEdges.forEach((edge, i) => {
    holds.push({ kind: 'edge', targetId: edge.id, requiredPosition: null, releaseAfterIndex: i, released: false });
  });

  // Point holds: one per distinct point across the path, releaseAfterIndex
  // is the LAST source step index of any edge whose pointConditions
  // mention it (D5 — "a plain index computation over the ordered path").
  const pointHold = new Map<PointId, { requiredPosition: 'normal' | 'reverse'; releaseAfterIndex: number }>();
  pathEdges.forEach((edge, i) => {
    for (const condition of edge.pointConditions) {
      const existing = pointHold.get(condition.pointId);
      if (!existing || i > existing.releaseAfterIndex) {
        pointHold.set(condition.pointId, { requiredPosition: condition.requiredPosition, releaseAfterIndex: i });
      }
    }
  });
  for (const [pointId, { requiredPosition, releaseAfterIndex }] of pointHold) {
    holds.push({ kind: 'point', targetId: pointId, requiredPosition, releaseAfterIndex, released: false });
  }

  return holds;
}

// ─── Release ────────────────────────────────────────────────────────────────

/**
 * Every currently-unreleased hold whose `releaseAfterIndex` is strictly
 * behind `confirmedIndex` — i.e. the train has been confirmed in a later
 * block than the one this hold sits behind. Sufficient by itself for point
 * and edge holds (D5: "a plain index computation"); a block hold ALSO needs
 * its own `occupied` -> `clear` transition, which `evaluateOccupancyChange`
 * checks before treating this function's result as the final answer for it.
 */
export function holdsReleasableAt(r: RouteReservation, confirmedIndex: number): RouteHold[] {
  return r.holds.filter((h) => !h.released && confirmedIndex > h.releaseAfterIndex);
}

export type OccupancyEffect =
  | { kind: 'progress'; confirmedIndex: number }
  | { kind: 'release'; confirmedIndex: number; releasable: RouteHold[] }
  | { kind: 'complete' }
  | { kind: 'unexpected-occupancy'; blockId: BlockId }
  | { kind: 'ignore' };

/**
 * Interprets one block occupancy transition against a single route's path
 * (D5, D7). `ReservationService` calls this once per `active`/`suspended`
 * route that references `blockId` and applies the resulting effect.
 *
 * - `occupied` in the block that is exactly the route's next unconfirmed
 *   step is normal progress. `occupied` in the block the route is already
 *   confirmed in is a re-confirmation, ignored. `occupied` anywhere else in
 *   the route's reserved blocks is unexpected — a manual train has entered
 *   track the system did not expect it in (D7) — and is never optimistic.
 * - `clear` only matters coming from `occupied` (a block that never read
 *   occupied has nothing to release — detection dropout is not evidence of
 *   clearance) AND only once the train has been confirmed past every visit
 *   to that block in the path (never release blocks ahead of the train).
 *   When both hold, every hold releasable at the current `confirmedIndex`
 *   releases together — not just the one block that just cleared.
 * - `occupied` in the FINAL block of the path is `complete`: the train has
 *   arrived. `ReservationService` releases every remaining hold at that
 *   point (the completion release path in D5) — the destination block's own
 *   occupancy is no longer reservation-tracked once the route is complete.
 */
export function evaluateOccupancyChange(
  r: RouteReservation,
  blockId: BlockId,
  occupancy: Occupancy,
  previous: Occupancy,
): OccupancyEffect {
  const stepIndices = r.path
    .map((step, i) => (step.blockId === blockId ? i : -1))
    .filter((i) => i >= 0);

  if (stepIndices.length === 0) {
    return { kind: 'ignore' };
  }

  if (occupancy === 'occupied') {
    const nextExpectedIndex = r.confirmedIndex + 1;
    if (stepIndices.includes(nextExpectedIndex)) {
      if (nextExpectedIndex === r.path.length - 1) {
        return { kind: 'complete' };
      }
      return { kind: 'progress', confirmedIndex: nextExpectedIndex };
    }
    if (stepIndices.includes(r.confirmedIndex)) {
      return { kind: 'ignore' };
    }
    return { kind: 'unexpected-occupancy', blockId };
  }

  if (occupancy !== 'clear' || previous !== 'occupied') {
    return { kind: 'ignore' };
  }

  const lastIndexForBlock = Math.max(...stepIndices);
  if (r.confirmedIndex <= lastIndexForBlock) {
    // Tail hasn't caught up yet — never release a block ahead of the train.
    return { kind: 'ignore' };
  }

  const releasable = holdsReleasableAt(r, r.confirmedIndex);
  if (releasable.length === 0) {
    return { kind: 'ignore' };
  }
  return { kind: 'release', confirmedIndex: r.confirmedIndex, releasable };
}

// ─── Description ────────────────────────────────────────────────────────────

function describeRejection(rejection: RouteRejection): string {
  switch (rejection.kind) {
    case 'system-not-online':
      return `system is ${rejection.status}, not online`;
    case 'empty-path':
      return 'requested path has no edges';
    case 'unknown-edge':
      return `edge ${rejection.edgeId} does not exist in the current track graph`;
    case 'path-not-connected':
      return `path is not connected at step ${rejection.index}`;
    case 'reversal-at-block':
      return `path reverses at block ${rejection.blockId}`;
    case 'start-block-not-occupied':
      return `start block ${rejection.blockId} is ${rejection.occupancy}, not occupied`;
    case 'start-block-holds-other-loco':
      return `start block ${rejection.blockId} holds loco ${rejection.locoAddress}, not the requested loco`;
    case 'block-not-clear':
      return `block ${rejection.blockId} is ${rejection.occupancy}, not clear`;
    case 'block-locked':
      return `block ${rejection.blockId} is locked by route ${rejection.heldBy}`;
    case 'point-locked':
      return `point ${rejection.pointId} is locked by route ${rejection.heldBy}`;
    case 'point-position-conflict':
      return `point ${rejection.pointId} is required in two different positions by this path`;
    case 'loco-already-routed':
      return `loco ${rejection.locoAddress} already has an active route (${rejection.routeId})`;
    case 'unknown-loco':
      return `loco ${rejection.locoAddress} is not in the roster`;
    case 'no-graph':
      return 'no track graph is currently loaded';
  }
}

/**
 * Human-readable summary of a rejection list, for HTTP error bodies and log
 * messages. Unlike `describeViolations`, this does not truncate — a route
 * grant rejection list is bounded by path length, not layout size, so there
 * is no unbounded-string risk to guard against.
 */
export function describeRejections(rejections: readonly RouteRejection[]): string {
  const shown = rejections.map(describeRejection);
  return `Route rejected: ${rejections.length} reason(s) — ${shown.join('; ')}`;
}
