import { describe, it, expect } from 'vitest';
import {
  describeRejections,
  evaluateOccupancyChange,
  holdsReleasableAt,
  planReservation,
  ReservationRequest,
  ReservationView,
} from '../../../src/domain/routeLocking';
import { buildTrackGraph } from '../../../src/domain/graph';
import { EMPTY_NAME_BOOK } from '../../../src/domain/naming';
import { BlockEdge, BlockState, NameBook, PointState, RouteReservation, RouteRejection } from '../../../src/domain/types';

const LAYOUT = 'layout-1';
const ROUTE_ID = 'route-new';
const NOW = new Date('2026-08-07T00:00:00Z');

function edge(overrides: Partial<BlockEdge> = {}): BlockEdge {
  return {
    id: 'e1',
    layoutId: LAYOUT,
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [],
    lengthMm: null,
    ...overrides,
  };
}

function block(overrides: Partial<BlockState> = {}): BlockState {
  return {
    blockId: 'b1',
    occupancy: 'unknown',
    locoAddress: null,
    lockedByRoute: null,
    lastUpdated: NOW,
    ...overrides,
  };
}

function point(overrides: Partial<PointState> = {}): PointState {
  return {
    pointId: 'p1',
    position: 'normal',
    locked: false,
    lockedByRoute: null,
    lastUpdated: NOW,
    ...overrides,
  };
}

/** A three-block chain b1 -[e1, point p1=normal]-> b2 -[e2]-> b3. */
function threeBlockEdges(): BlockEdge[] {
  return [
    edge({
      id: 'e1',
      fromBlockId: 'b1',
      fromEnd: 'east',
      toBlockId: 'b2',
      toEnd: 'west',
      pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
    }),
    edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west' }),
  ];
}

function baseView(overrides: Partial<ReservationView> = {}): ReservationView {
  const edges = threeBlockEdges();
  return {
    systemStatus: 'online',
    graph: buildTrackGraph(LAYOUT, edges),
    blocks: new Map([
      ['b1', block({ blockId: 'b1', occupancy: 'occupied', locoAddress: 3 })],
      ['b2', block({ blockId: 'b2', occupancy: 'clear' })],
      ['b3', block({ blockId: 'b3', occupancy: 'clear' })],
    ]),
    points: new Map([['p1', point()]]),
    holding: [],
    knownLocoAddresses: new Set([3]),
    ...overrides,
  };
}

function baseRequest(overrides: Partial<ReservationRequest> = {}): ReservationRequest {
  return {
    layoutId: LAYOUT,
    locoAddress: 3,
    authority: 'manual',
    startBlockId: 'b1',
    edgeIds: ['e1', 'e2'],
    ...overrides,
  };
}

function existingReservation(overrides: Partial<RouteReservation> = {}): RouteReservation {
  return {
    id: 'route-99',
    layoutId: LAYOUT,
    locoAddress: 3,
    authority: 'manual',
    status: 'active',
    path: [
      { edgeId: null, blockId: 'b1', entryEnd: null, exitEnd: 'east' },
      { edgeId: 'e1', blockId: 'b2', entryEnd: 'west', exitEnd: 'east' },
      { edgeId: 'e2', blockId: 'b3', entryEnd: 'west', exitEnd: null },
    ],
    holds: [
      { kind: 'block', targetId: 'b1', requiredPosition: null, releaseAfterIndex: 0, released: false },
      { kind: 'block', targetId: 'b2', requiredPosition: null, releaseAfterIndex: 1, released: false },
      { kind: 'block', targetId: 'b3', requiredPosition: null, releaseAfterIndex: 2, released: false },
      { kind: 'edge', targetId: 'e1', requiredPosition: null, releaseAfterIndex: 0, released: false },
      { kind: 'edge', targetId: 'e2', requiredPosition: null, releaseAfterIndex: 1, released: false },
      { kind: 'point', targetId: 'p1', requiredPosition: 'normal', releaseAfterIndex: 0, released: false },
    ],
    confirmedIndex: 0,
    reason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('planReservation — happy path', () => {
  it('grants a route over a clear, connected path starting from an occupied block', () => {
    const result = planReservation(baseRequest(), baseView(), ROUTE_ID, NOW);
    expect(result.granted).toBe(true);
    if (!result.granted) throw new Error('expected grant');

    expect(result.reservation.id).toBe(ROUTE_ID);
    expect(result.reservation.status).toBe('active');
    expect(result.reservation.confirmedIndex).toBe(0);
    expect(result.reservation.path).toHaveLength(3);
    expect(result.reservation.path[0]).toEqual({
      edgeId: null,
      blockId: 'b1',
      entryEnd: null,
      exitEnd: 'east',
    });
    expect(result.reservation.path[2]).toEqual({
      edgeId: 'e2',
      blockId: 'b3',
      entryEnd: 'west',
      exitEnd: null,
    });

    const blockHolds = result.reservation.holds.filter((h) => h.kind === 'block');
    expect(blockHolds).toHaveLength(3);
    const pointHold = result.reservation.holds.find((h) => h.kind === 'point');
    expect(pointHold).toMatchObject({ targetId: 'p1', requiredPosition: 'normal', releaseAfterIndex: 0 });
    const edgeHolds = result.reservation.holds.filter((h) => h.kind === 'edge');
    expect(edgeHolds.map((h) => h.targetId).sort()).toEqual(['e1', 'e2']);
  });

  it('does not reject when the start block has no loco assigned yet — the grant is the assertion (D13), applied by ReservationService, not this pure function', () => {
    const view = baseView({
      blocks: new Map([
        ['b1', block({ blockId: 'b1', occupancy: 'occupied', locoAddress: null })],
        ['b2', block({ blockId: 'b2', occupancy: 'clear' })],
        ['b3', block({ blockId: 'b3', occupancy: 'clear' })],
      ]),
    });
    const result = planReservation(baseRequest(), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(true);
  });
});

describe('planReservation — failure paths', () => {
  it('rejects when the system is not online', () => {
    const result = planReservation(baseRequest(), baseView({ systemStatus: 'safe-stop' }), ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({ kind: 'system-not-online', status: 'safe-stop' });
  });

  it('rejects an empty path', () => {
    const result = planReservation(baseRequest({ edgeIds: [] }), baseView(), ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({ kind: 'empty-path' });
  });

  it('rejects an unknown loco', () => {
    const result = planReservation(
      baseRequest({ locoAddress: 99 }),
      baseView({ knownLocoAddresses: new Set([3]) }),
      ROUTE_ID,
      NOW,
    );
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({ kind: 'unknown-loco', locoAddress: 99 });
  });

  it('rejects a loco that already has an active or suspended route', () => {
    const existing = existingReservation({ id: 'route-existing', locoAddress: 3, status: 'suspended' });
    const result = planReservation(baseRequest(), baseView({ holding: [existing] }), ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({
      kind: 'loco-already-routed',
      locoAddress: 3,
      routeId: 'route-existing',
    });
  });

  it('rejects when there is no track graph', () => {
    const result = planReservation(baseRequest(), baseView({ graph: null }), ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({ kind: 'no-graph' });
  });

  it('rejects and reports every unknown edge id, not just the first', () => {
    const result = planReservation(
      baseRequest({ edgeIds: ['ghost-1', 'ghost-2'] }),
      baseView(),
      ROUTE_ID,
      NOW,
    );
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({ kind: 'unknown-edge', edgeId: 'ghost-1' });
    expect(result.rejections).toContainEqual({ kind: 'unknown-edge', edgeId: 'ghost-2' });
  });

  it('rejects a disconnected path', () => {
    const edges = [
      edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
      // e2 does not leave from b2 — leaves from b3, disconnected from e1.
      edge({ id: 'e2', fromBlockId: 'b3', fromEnd: 'east', toBlockId: 'b4', toEnd: 'west' }),
    ];
    const graph = buildTrackGraph(LAYOUT, edges);
    const view = baseView({
      graph,
      blocks: new Map([
        ['b1', block({ blockId: 'b1', occupancy: 'occupied', locoAddress: 3 })],
        ['b2', block({ blockId: 'b2', occupancy: 'clear' })],
        ['b3', block({ blockId: 'b3', occupancy: 'clear' })],
        ['b4', block({ blockId: 'b4', occupancy: 'clear' })],
      ]),
      points: new Map(),
    });
    const result = planReservation(baseRequest({ edgeIds: ['e1', 'e2'] }), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({ kind: 'path-not-connected', index: 1 });
  });

  it('rejects a reversal — leaving a block by the same end it was entered by', () => {
    const edges = [
      edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
      // Leaves b2 by 'west' — the same end e1 arrived at.
      edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'west', toBlockId: 'b3', toEnd: 'west' }),
    ];
    const graph = buildTrackGraph(LAYOUT, edges);
    const view = baseView({
      graph,
      blocks: new Map([
        ['b1', block({ blockId: 'b1', occupancy: 'occupied', locoAddress: 3 })],
        ['b2', block({ blockId: 'b2', occupancy: 'clear' })],
        ['b3', block({ blockId: 'b3', occupancy: 'clear' })],
      ]),
      points: new Map(),
    });
    const result = planReservation(baseRequest({ edgeIds: ['e1', 'e2'] }), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({ kind: 'reversal-at-block', blockId: 'b2' });
  });

  it('rejects when the start block is not occupied', () => {
    const view = baseView({
      blocks: new Map([
        ['b1', block({ blockId: 'b1', occupancy: 'clear' })],
        ['b2', block({ blockId: 'b2', occupancy: 'clear' })],
        ['b3', block({ blockId: 'b3', occupancy: 'clear' })],
      ]),
    });
    const result = planReservation(baseRequest(), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({
      kind: 'start-block-not-occupied',
      blockId: 'b1',
      occupancy: 'clear',
    });
  });

  it('rejects when the start block is unknown, not just not-clear (fail-safe)', () => {
    const view = baseView({
      blocks: new Map([
        ['b1', block({ blockId: 'b1', occupancy: 'unknown' })],
        ['b2', block({ blockId: 'b2', occupancy: 'clear' })],
        ['b3', block({ blockId: 'b3', occupancy: 'clear' })],
      ]),
    });
    const result = planReservation(baseRequest(), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({
      kind: 'start-block-not-occupied',
      blockId: 'b1',
      occupancy: 'unknown',
    });
  });

  it('rejects when the start block holds a different loco than requested', () => {
    const view = baseView({
      blocks: new Map([
        ['b1', block({ blockId: 'b1', occupancy: 'occupied', locoAddress: 7 })],
        ['b2', block({ blockId: 'b2', occupancy: 'clear' })],
        ['b3', block({ blockId: 'b3', occupancy: 'clear' })],
      ]),
    });
    const result = planReservation(baseRequest({ locoAddress: 3 }), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({
      kind: 'start-block-holds-other-loco',
      blockId: 'b1',
      locoAddress: 7,
    });
  });

  it('rejects a mid-path block that reads unknown — never optimistically accepted', () => {
    const view = baseView({
      blocks: new Map([
        ['b1', block({ blockId: 'b1', occupancy: 'occupied', locoAddress: 3 })],
        ['b2', block({ blockId: 'b2', occupancy: 'unknown' })],
        ['b3', block({ blockId: 'b3', occupancy: 'clear' })],
      ]),
    });
    const result = planReservation(baseRequest(), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({
      kind: 'block-not-clear',
      blockId: 'b2',
      occupancy: 'unknown',
    });
  });

  it('rejects a block already locked by another route', () => {
    const view = baseView({
      blocks: new Map([
        ['b1', block({ blockId: 'b1', occupancy: 'occupied', locoAddress: 3 })],
        ['b2', block({ blockId: 'b2', occupancy: 'clear', lockedByRoute: 'route-other' })],
        ['b3', block({ blockId: 'b3', occupancy: 'clear' })],
      ]),
    });
    const result = planReservation(baseRequest(), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({
      kind: 'block-locked',
      blockId: 'b2',
      heldBy: 'route-other',
    });
  });

  it('rejects a point already locked by another route', () => {
    const view = baseView({ points: new Map([['p1', point({ lockedByRoute: 'route-other' })]]) });
    const result = planReservation(baseRequest(), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({
      kind: 'point-locked',
      pointId: 'p1',
      heldBy: 'route-other',
    });
  });

  it('rejects a path requiring one point both normal and reverse', () => {
    const edges = [
      edge({
        id: 'e1',
        fromBlockId: 'b1',
        fromEnd: 'east',
        toBlockId: 'b2',
        toEnd: 'west',
        pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
      }),
      edge({
        id: 'e2',
        fromBlockId: 'b2',
        fromEnd: 'east',
        toBlockId: 'b3',
        toEnd: 'west',
        pointConditions: [{ pointId: 'p1', requiredPosition: 'reverse' }],
      }),
    ];
    const graph = buildTrackGraph(LAYOUT, edges);
    const view = baseView({ graph });
    const result = planReservation(baseRequest(), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections).toContainEqual({ kind: 'point-position-conflict', pointId: 'p1' });
  });

  it('returns every rejection found, not just the first', () => {
    const view = baseView({ systemStatus: 'safe-stop', knownLocoAddresses: new Set() });
    const result = planReservation(baseRequest(), view, ROUTE_ID, NOW);
    expect(result.granted).toBe(false);
    if (result.granted) throw new Error('expected rejection');
    expect(result.rejections.length).toBeGreaterThanOrEqual(2);
    expect(result.rejections).toContainEqual({ kind: 'system-not-online', status: 'safe-stop' });
    expect(result.rejections).toContainEqual({ kind: 'unknown-loco', locoAddress: 3 });
  });
});

describe('holdsReleasableAt', () => {
  it('returns holds whose releaseAfterIndex is strictly behind confirmedIndex', () => {
    const r = existingReservation();
    const releasable = holdsReleasableAt(r, 1);
    // releaseAfterIndex 0 < 1 for b1, e1, p1 — those three release; b2/b3/e2 (index 1) do not.
    expect(releasable.map((h) => h.targetId).sort()).toEqual(['b1', 'e1', 'p1']);
  });

  it('excludes already-released holds', () => {
    const r = existingReservation();
    r.holds[0].released = true; // b1
    const releasable = holdsReleasableAt(r, 1);
    expect(releasable.map((h) => h.targetId).sort()).toEqual(['e1', 'p1']);
  });
});

describe('evaluateOccupancyChange', () => {
  it('reports progress when occupancy appears in the next expected block', () => {
    const r = existingReservation({ confirmedIndex: 0 });
    const effect = evaluateOccupancyChange(r, 'b2', 'occupied', 'clear');
    expect(effect).toEqual({ kind: 'progress', confirmedIndex: 1 });
  });

  it('reports complete when occupancy appears in the final block of the path', () => {
    const r = existingReservation({ confirmedIndex: 1 });
    const effect = evaluateOccupancyChange(r, 'b3', 'occupied', 'clear');
    expect(effect).toEqual({ kind: 'complete' });
  });

  it('reports unexpected-occupancy for a non-adjacent path block', () => {
    const r = existingReservation({ confirmedIndex: 0 });
    // b3 is two steps ahead of the confirmed position (b1) — not the next step (b2).
    const effect = evaluateOccupancyChange(r, 'b3', 'occupied', 'clear');
    expect(effect).toEqual({ kind: 'unexpected-occupancy', blockId: 'b3' });
  });

  it('ignores a block outside the route entirely', () => {
    const r = existingReservation({ confirmedIndex: 0 });
    const effect = evaluateOccupancyChange(r, 'b-unrelated', 'occupied', 'clear');
    expect(effect).toEqual({ kind: 'ignore' });
  });

  // ── occupancy-unknown (#4) ────────────────────────────────────────────

  it('reports occupancy-unknown when a block ahead of the train stops being determinable', () => {
    const r = existingReservation({ confirmedIndex: 0 });
    const effect = evaluateOccupancyChange(r, 'b2', 'unknown', 'clear');
    expect(effect).toEqual({ kind: 'occupancy-unknown', blockId: 'b2' });
  });

  it('reports occupancy-unknown for the block the train is confirmed in as well', () => {
    // Losing sight of the train itself is no less serious than losing sight
    // of the road ahead.
    const r = existingReservation({ confirmedIndex: 1 });
    const effect = evaluateOccupancyChange(r, 'b2', 'unknown', 'occupied');
    expect(effect).toEqual({ kind: 'occupancy-unknown', blockId: 'b2' });
  });

  it('ignores unknown -> unknown, so an already-faulted route is not re-faulted on every recompute', () => {
    const r = existingReservation({ confirmedIndex: 0 });
    const effect = evaluateOccupancyChange(r, 'b2', 'unknown', 'unknown');
    expect(effect).toEqual({ kind: 'ignore' });
  });

  it('ignores unknown on a block outside the route', () => {
    const r = existingReservation({ confirmedIndex: 0 });
    const effect = evaluateOccupancyChange(r, 'b-unrelated', 'unknown', 'clear');
    expect(effect).toEqual({ kind: 'ignore' });
  });

  it('ignores a clear reading on a block that never went occupied (detection dropout is not evidence of clearance)', () => {
    const r = existingReservation({ confirmedIndex: 1 });
    const effect = evaluateOccupancyChange(r, 'b1', 'clear', 'unknown');
    expect(effect).toEqual({ kind: 'ignore' });
  });

  it('does not release a block ahead of the train even if it reads clear', () => {
    // Train confirmed at b1 (index 0) — b2 (index 1) is still ahead.
    const r = existingReservation({ confirmedIndex: 0 });
    const effect = evaluateOccupancyChange(r, 'b2', 'clear', 'occupied');
    expect(effect).toEqual({ kind: 'ignore' });
  });

  it('releases the block and its wholly-behind holds once confirmed past it and it reads clear', () => {
    // Train confirmed at b2 (index 1) — b1 (index 0) is now behind it.
    const r = existingReservation({ confirmedIndex: 1 });
    const effect = evaluateOccupancyChange(r, 'b1', 'clear', 'occupied');
    expect(effect.kind).toBe('release');
    if (effect.kind !== 'release') throw new Error('expected release');
    expect(effect.releasable.map((h) => h.targetId).sort()).toEqual(['b1', 'e1', 'p1']);
  });
});

describe('describeRejections', () => {
  const rejections: RouteRejection[] = [
    { kind: 'destination-is-start', blockId: 'b2' },
    { kind: 'no-path', destinationBlockId: 'b2', blockers: [{ kind: 'block-not-clear', blockId: 'b2', occupancy: 'occupied' }] },
  ];

  it('degrades to raw ids, byte-for-byte, with no book (D8)', () => {
    expect(describeRejections(rejections)).toBe(
      'Route rejected: 2 reasons — destination block b2 is the start block; no route exists to block b2 [blocked by: block b2 is occupied]',
    );
  });

  it('renders quoted names when a book is supplied, with the bracketed nested-blocker form (D7)', () => {
    const book: NameBook = { ...EMPTY_NAME_BOOK, blocks: new Map([['b2', 'Up Loop']]) };
    expect(describeRejections(rejections, book)).toBe(
      'Route rejected: 2 reasons — destination block "Up Loop" (b2) is the start block; no route exists to block "Up Loop" (b2) [blocked by: block "Up Loop" (b2) is occupied]',
    );
  });

  it('uses the singular for one reason', () => {
    expect(describeRejections([{ kind: 'destination-is-start', blockId: 'b2' }])).toBe(
      'Route rejected: 1 reason — destination block b2 is the start block',
    );
  });
});
