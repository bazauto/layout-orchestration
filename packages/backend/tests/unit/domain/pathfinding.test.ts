import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EDGE_LENGTH_MM,
  MAX_REPORTED_BLOCKERS,
  PathfindingView,
  describeBlocker,
  findPath,
} from '../../../src/domain/pathfinding';
import { buildTrackGraph } from '../../../src/domain/graph';
import { BlockEdge, BlockState, PointState } from '../../../src/domain/types';

const LAYOUT = 'layout-1';
const NOW = new Date('2026-08-08T00:00:00Z');

function edge(overrides: Partial<BlockEdge> & Pick<BlockEdge, 'id'>): BlockEdge {
  return {
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

function block(blockId: string, overrides: Partial<BlockState> = {}): BlockState {
  return {
    blockId,
    occupancy: 'clear',
    locoAddress: null,
    lockedByRoute: null,
    lastUpdated: NOW,
    ...overrides,
  };
}

function point(pointId: string, overrides: Partial<PointState> = {}): PointState {
  return {
    pointId,
    position: 'normal',
    locked: false,
    lockedByRoute: null,
    lastUpdated: NOW,
    ...overrides,
  };
}

/**
 * Builds a view. `blocks` is a list of `BlockState`; the start block is
 * expected to be supplied `occupied` by the caller when that matters, since
 * `findPath` itself does not care what the start block reads (that is
 * `planReservation`'s precondition, not the search's).
 */
function view(
  edges: BlockEdge[],
  blocks: BlockState[],
  points: PointState[] = [],
): PathfindingView {
  return {
    graph: buildTrackGraph(LAYOUT, edges),
    blocks: new Map(blocks.map((b) => [b.blockId, b])),
    points: new Map(points.map((p) => [p.pointId, p])),
  };
}

// ─── Basic search ─────────────────────────────────────────────────────────────

describe('findPath — basic search', () => {
  it('finds a single-edge path', () => {
    const v = view([edge({ id: 'e1' })], [block('b1', { occupancy: 'occupied' }), block('b2')]);
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b2' }, v);
    expect(result).toEqual({ found: true, edgeIds: ['e1'] });
  });

  it('finds a multi-edge path through intermediate blocks', () => {
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
        edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west' }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2'), block('b3')],
    );
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b3' }, v);
    expect(result).toEqual({ found: true, edgeIds: ['e1', 'e2'] });
  });

  it('rejects a destination equal to the start block', () => {
    const v = view([edge({ id: 'e1' })], [block('b1', { occupancy: 'occupied' }), block('b2')]);
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b1' }, v);
    expect(result).toEqual({
      found: false,
      reason: { kind: 'destination-is-start', blockId: 'b1' },
    });
  });

  it('rejects a start block that does not exist in the layout', () => {
    const v = view([edge({ id: 'e1' })], [block('b1'), block('b2')]);
    const result = findPath({ startBlockId: 'nope', destinationBlockId: 'b2' }, v);
    expect(result).toEqual({ found: false, reason: { kind: 'unknown-block', blockId: 'nope' } });
  });

  it('rejects a destination block that does not exist in the layout', () => {
    const v = view([edge({ id: 'e1' })], [block('b1'), block('b2')]);
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'nope' }, v);
    expect(result).toEqual({ found: false, reason: { kind: 'unknown-block', blockId: 'nope' } });
  });

  it('reports no-path when the destination is not reachable at all', () => {
    // b3 exists but nothing leads to it.
    const v = view(
      [edge({ id: 'e1' })],
      [block('b1', { occupancy: 'occupied' }), block('b2'), block('b3')],
    );
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b3' }, v);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason.kind).toBe('no-path');
  });
});

// ─── Direction of travel (P1) ─────────────────────────────────────────────────

describe('findPath — direction of travel', () => {
  it('refuses to leave a block by the end it was entered through', () => {
    // b1 --east--> b2(west); the only edge out of b2 also leaves by west,
    // which would mean reversing back the way the train came.
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
        edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'west', toBlockId: 'b3', toEnd: 'south' }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2'), block('b3')],
    );
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b3' }, v);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason.kind).toBe('no-path');
  });

  it('allows leaving by a different end than it entered by', () => {
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
        edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'south' }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2'), block('b3')],
    );
    expect(findPath({ startBlockId: 'b1', destinationBlockId: 'b3' }, v)).toEqual({
      found: true,
      edgeIds: ['e1', 'e2'],
    });
  });

  it('distinguishes the same block entered by different ends', () => {
    // Two ways into b2 — via its west end (dead end beyond) and via its
    // south end (which can go on to b4). A block-keyed search would settle
    // b2 once by the cheaper west route and never discover the b4 path.
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west', lengthMm: 100 }),
        edge({ id: 'e2', fromBlockId: 'b1', fromEnd: 'south', toBlockId: 'b3', toEnd: 'north', lengthMm: 200 }),
        edge({ id: 'e3', fromBlockId: 'b3', fromEnd: 'south', toBlockId: 'b2', toEnd: 'south', lengthMm: 200 }),
        // Only reachable from b2 by leaving via its west end — i.e. only if
        // b2 was entered by its south end.
        edge({ id: 'e4', fromBlockId: 'b2', fromEnd: 'west', toBlockId: 'b4', toEnd: 'east', lengthMm: 100 }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2'), block('b3'), block('b4')],
    );
    expect(findPath({ startBlockId: 'b1', destinationBlockId: 'b4' }, v)).toEqual({
      found: true,
      edgeIds: ['e2', 'e3', 'e4'],
    });
  });

  it('honours startExitEnd, refusing a path that leaves the start block the wrong way', () => {
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
        edge({ id: 'e2', fromBlockId: 'b1', fromEnd: 'west', toBlockId: 'b3', toEnd: 'east' }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2'), block('b3')],
    );
    expect(findPath({ startBlockId: 'b1', destinationBlockId: 'b2', startExitEnd: 'east' }, v)).toEqual(
      { found: true, edgeIds: ['e1'] },
    );

    const wrongWay = findPath(
      { startBlockId: 'b1', destinationBlockId: 'b2', startExitEnd: 'west' },
      v,
    );
    expect(wrongWay.found).toBe(false);
  });

  it('does not route back through the start block', () => {
    // The only way to b3 is back through b1, which holds the train.
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
        edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b1', toEnd: 'south' }),
        edge({ id: 'e3', fromBlockId: 'b1', fromEnd: 'north', toBlockId: 'b3', toEnd: 'west' }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2'), block('b3')],
    );
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b3' }, v);
    // Reachable directly via e3 — the point is that it does not detour.
    expect(result).toEqual({ found: true, edgeIds: ['e3'] });
  });
});

// ─── Blocked paths (fail-safe) ────────────────────────────────────────────────

describe('findPath — blocked paths', () => {
  it('will not route through an occupied block', () => {
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
        edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west' }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2', { occupancy: 'occupied' }), block('b3')],
    );
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b3' }, v);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toEqual({
      kind: 'no-path',
      blockers: [{ kind: 'block-not-clear', blockId: 'b2', occupancy: 'occupied' }],
    });
  });

  it('will not route through a block whose occupancy is unknown', () => {
    // The core fail-safe rule: unknown is not "probably fine".
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
        edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west' }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2', { occupancy: 'unknown' }), block('b3')],
    );
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b3' }, v);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toEqual({
      kind: 'no-path',
      blockers: [{ kind: 'block-not-clear', blockId: 'b2', occupancy: 'unknown' }],
    });
  });

  it('treats a block missing from the state map as unknown, not routable', () => {
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
        edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west' }),
      ],
      // b2 is a known block of the layout but has no runtime state yet.
      [block('b1', { occupancy: 'occupied' }), block('b3')],
    );
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b3' }, v);
    expect(result.found).toBe(false);
  });

  it('will not route through a block another route holds', () => {
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
        edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west' }),
      ],
      [
        block('b1', { occupancy: 'occupied' }),
        block('b2', { lockedByRoute: 'route-other' }),
        block('b3'),
      ],
    );
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b3' }, v);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toEqual({
      kind: 'no-path',
      blockers: [{ kind: 'block-locked', blockId: 'b2', heldBy: 'route-other' }],
    });
  });

  it('will not route over an edge whose point another route holds', () => {
    const v = view(
      [
        edge({
          id: 'e1',
          fromBlockId: 'b1',
          fromEnd: 'east',
          toBlockId: 'b2',
          toEnd: 'west',
          pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
        }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2')],
      [point('p1', { locked: true, lockedByRoute: 'route-other' })],
    );
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b2' }, v);
    expect(result.found).toBe(false);
    if (result.found) return;
    expect(result.reason).toEqual({
      kind: 'no-path',
      blockers: [{ kind: 'point-locked', pointId: 'p1', heldBy: 'route-other' }],
    });
  });

  it('routes around a blocked branch when an alternative exists', () => {
    const v = view(
      [
        edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west', lengthMm: 100 }),
        edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b4', toEnd: 'west', lengthMm: 100 }),
        edge({ id: 'e3', fromBlockId: 'b1', fromEnd: 'south', toBlockId: 'b3', toEnd: 'north', lengthMm: 500 }),
        edge({ id: 'e4', fromBlockId: 'b3', fromEnd: 'south', toBlockId: 'b4', toEnd: 'north', lengthMm: 500 }),
      ],
      [
        block('b1', { occupancy: 'occupied' }),
        block('b2', { occupancy: 'occupied' }),
        block('b3'),
        block('b4'),
      ],
    );
    // The short way through b2 is blocked, so the long way round is taken.
    expect(findPath({ startBlockId: 'b1', destinationBlockId: 'b4' }, v)).toEqual({
      found: true,
      edgeIds: ['e3', 'e4'],
    });
  });

  it('caps the number of blockers it reports', () => {
    const edges: BlockEdge[] = [];
    const blocks: BlockState[] = [block('b1', { occupancy: 'occupied' }), block('goal')];
    for (let i = 0; i < MAX_REPORTED_BLOCKERS + 10; i++) {
      edges.push(
        edge({ id: `e${i}`, fromBlockId: 'b1', fromEnd: `end-${i}`, toBlockId: `x${i}`, toEnd: 'west' }),
      );
      blocks.push(block(`x${i}`, { occupancy: 'occupied' }));
    }
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'goal' }, view(edges, blocks));
    expect(result.found).toBe(false);
    if (result.found) return;
    if (result.reason.kind !== 'no-path') throw new Error('expected no-path');
    expect(result.reason.blockers).toHaveLength(MAX_REPORTED_BLOCKERS);
  });
});

// ─── Point conditions (P3, P5) ────────────────────────────────────────────────

describe('findPath — point conditions', () => {
  it('routes over a point that is currently in the wrong position', () => {
    // Setting the road is what a route does. A point sitting at 'reverse'
    // must not make an edge requiring 'normal' unroutable — that is the whole
    // purpose of granting the route.
    const v = view(
      [
        edge({
          id: 'e1',
          fromBlockId: 'b1',
          fromEnd: 'east',
          toBlockId: 'b2',
          toEnd: 'west',
          pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
        }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2')],
      [point('p1', { position: 'reverse' })],
    );
    expect(findPath({ startBlockId: 'b1', destinationBlockId: 'b2' }, v)).toEqual({
      found: true,
      edgeIds: ['e1'],
    });
  });

  it('routes over a point whose position is unknown', () => {
    const v = view(
      [
        edge({
          id: 'e1',
          fromBlockId: 'b1',
          fromEnd: 'east',
          toBlockId: 'b2',
          toEnd: 'west',
          pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
        }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2')],
      [point('p1', { position: 'unknown' })],
    );
    expect(findPath({ startBlockId: 'b1', destinationBlockId: 'b2' }, v)).toEqual({
      found: true,
      edgeIds: ['e1'],
    });
  });

  it('refuses a path requiring one point in two positions', () => {
    const v = view(
      [
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
      ],
      [block('b1', { occupancy: 'occupied' }), block('b2'), block('b3')],
      [point('p1')],
    );
    const result = findPath({ startBlockId: 'b1', destinationBlockId: 'b3' }, v);
    expect(result).toEqual({
      found: false,
      reason: { kind: 'point-position-conflict', pointIds: ['p1'] },
    });
  });
});

// ─── Cost model (P2) ──────────────────────────────────────────────────────────

describe('findPath — cost model', () => {
  it('prefers the shorter path by length, not by hop count', () => {
    const v = view(
      [
        // One long hop...
        edge({ id: 'e-long', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'goal', toEnd: 'west', lengthMm: 5000 }),
        // ...versus two short ones.
        edge({ id: 'e-a', fromBlockId: 'b1', fromEnd: 'south', toBlockId: 'mid', toEnd: 'north', lengthMm: 100 }),
        edge({ id: 'e-b', fromBlockId: 'mid', fromEnd: 'south', toBlockId: 'goal', toEnd: 'north', lengthMm: 100 }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('mid'), block('goal')],
    );
    expect(findPath({ startBlockId: 'b1', destinationBlockId: 'goal' }, v)).toEqual({
      found: true,
      edgeIds: ['e-a', 'e-b'],
    });
  });

  it('costs an unmeasured edge at DEFAULT_EDGE_LENGTH_MM rather than treating it as free', () => {
    const v = view(
      [
        // Unmeasured single hop — costs DEFAULT_EDGE_LENGTH_MM (1000).
        edge({ id: 'e-unmeasured', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'goal', toEnd: 'west', lengthMm: null }),
        // Measured two-hop alternative, cheaper in total than the default.
        edge({ id: 'e-a', fromBlockId: 'b1', fromEnd: 'south', toBlockId: 'mid', toEnd: 'north', lengthMm: 1 }),
        edge({ id: 'e-b', fromBlockId: 'mid', fromEnd: 'south', toBlockId: 'goal', toEnd: 'north', lengthMm: 1 }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('mid'), block('goal')],
    );
    expect(DEFAULT_EDGE_LENGTH_MM).toBe(1000);
    // If the unmeasured edge were free it would win; it does not.
    expect(findPath({ startBlockId: 'b1', destinationBlockId: 'goal' }, v)).toEqual({
      found: true,
      edgeIds: ['e-a', 'e-b'],
    });
  });

  it('falls back to fewest hops when no edge records a length', () => {
    const v = view(
      [
        edge({ id: 'e-direct', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'goal', toEnd: 'west' }),
        edge({ id: 'e-a', fromBlockId: 'b1', fromEnd: 'south', toBlockId: 'mid', toEnd: 'north' }),
        edge({ id: 'e-b', fromBlockId: 'mid', fromEnd: 'south', toBlockId: 'goal', toEnd: 'north' }),
      ],
      [block('b1', { occupancy: 'occupied' }), block('mid'), block('goal')],
    );
    expect(findPath({ startBlockId: 'b1', destinationBlockId: 'goal' }, v)).toEqual({
      found: true,
      edgeIds: ['e-direct'],
    });
  });

  it('is deterministic across equal-cost alternatives, breaking the tie by edge id', () => {
    // Two identical-cost routes to the goal. Whichever is chosen, it must be
    // the same one every time and must not depend on edge insertion order.
    const build = (order: 'ab' | 'ba') => {
      const viaA = [
        edge({ id: 'e-a1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'ma', toEnd: 'west', lengthMm: 100 }),
        edge({ id: 'e-a2', fromBlockId: 'ma', fromEnd: 'east', toBlockId: 'goal', toEnd: 'west', lengthMm: 100 }),
      ];
      const viaB = [
        edge({ id: 'e-b1', fromBlockId: 'b1', fromEnd: 'south', toBlockId: 'mb', toEnd: 'north', lengthMm: 100 }),
        edge({ id: 'e-b2', fromBlockId: 'mb', fromEnd: 'south', toBlockId: 'goal', toEnd: 'north', lengthMm: 100 }),
      ];
      return view(order === 'ab' ? [...viaA, ...viaB] : [...viaB, ...viaA], [
        block('b1', { occupancy: 'occupied' }),
        block('ma'),
        block('mb'),
        block('goal'),
      ]);
    };

    const forwards = findPath({ startBlockId: 'b1', destinationBlockId: 'goal' }, build('ab'));
    const backwards = findPath({ startBlockId: 'b1', destinationBlockId: 'goal' }, build('ba'));
    expect(forwards).toEqual(backwards);
    expect(forwards.found).toBe(true);
  });
});

// ─── Descriptions ─────────────────────────────────────────────────────────────

describe('describeBlocker', () => {
  it('describes each blocker kind', () => {
    expect(describeBlocker({ kind: 'block-not-clear', blockId: 'b2', occupancy: 'unknown' })).toBe(
      'block b2 is unknown',
    );
    expect(describeBlocker({ kind: 'block-locked', blockId: 'b2', heldBy: 'r1' })).toBe(
      'block b2 is locked by route r1',
    );
    expect(describeBlocker({ kind: 'point-locked', pointId: 'p1', heldBy: 'r1' })).toBe(
      'point p1 is locked by route r1',
    );
    expect(describeBlocker({ kind: 'returns-to-start', blockId: 'b1' })).toContain('b1');
  });
});
