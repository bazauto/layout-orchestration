import { describe, expect, it } from 'vitest';
import { buildLiveBlocks, perimeterEdges, roadSelection } from './liveState';
import { BlockState, LocoRecord, PointState, TilePointRoad } from '../types';

function block(overrides: Partial<BlockState> & { blockId: string }): BlockState {
  return {
    occupancy: 'clear',
    locoAddress: null,
    lockedByRoute: null,
    lastUpdated: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function point(pointId: string, position: PointState['position']): PointState {
  return {
    pointId,
    position,
    locked: false,
    lockedByRoute: null,
    lastUpdated: '2026-08-14T00:00:00.000Z',
  };
}

const LOCOS: LocoRecord[] = [
  {
    id: 'loco-1',
    layoutId: 'layout-1',
    name: 'Jinty',
    address: 12,
    type: 'steam',
    maxSpeed: 100,
    brakingFactor: 1,
  },
];

describe('buildLiveBlocks', () => {
  it('resolves a loco address to its roster name', () => {
    const out = buildLiveBlocks(
      { 'block-1': block({ blockId: 'block-1', occupancy: 'occupied', locoAddress: 12 }) },
      LOCOS,
    );
    expect(out.get('block-1')!.occupants).toEqual([{ kind: 'loco', address: 12, name: 'Jinty' }]);
  });

  it('keeps the address when no roster record matches, rather than dropping the occupant', () => {
    const out = buildLiveBlocks(
      { 'block-1': block({ blockId: 'block-1', occupancy: 'occupied', locoAddress: 99 }) },
      LOCOS,
    );
    expect(out.get('block-1')!.occupants).toEqual([{ kind: 'loco', address: 99 }]);
  });

  it('reports an occupied block with no identified occupant as occupied with an empty list', () => {
    // A rake of coaches in a siding. The system can see the block is occupied
    // and cannot say by what — an empty list, never a claim that it is clear.
    const out = buildLiveBlocks(
      { 'block-1': block({ blockId: 'block-1', occupancy: 'occupied', locoAddress: null }) },
      LOCOS,
    );
    expect(out.get('block-1')).toEqual({
      occupancy: 'occupied',
      lockedByRoute: null,
      occupants: [],
    });
  });

  it('carries occupancy and lock independently — a block can be locked and clear', () => {
    const out = buildLiveBlocks(
      { 'block-1': block({ blockId: 'block-1', occupancy: 'clear', lockedByRoute: 'route-7' }) },
      LOCOS,
    );
    expect(out.get('block-1')).toMatchObject({ occupancy: 'clear', lockedByRoute: 'route-7' });
  });
});

describe('roadSelection', () => {
  const road = (when: TilePointRoad['when']): TilePointRoad => ({ when, legs: ['w', 'e'] });

  it('is selected when every clause matches', () => {
    const points = new Map([['p1', point('p1', 'normal')]]);
    expect(roadSelection(road([{ pointId: 'p1', position: 'normal' }]), points)).toBe('selected');
  });

  it('is unselected on a definite disagreement', () => {
    const points = new Map([['p1', point('p1', 'reverse')]]);
    expect(roadSelection(road([{ pointId: 'p1', position: 'normal' }]), points)).toBe('unselected');
  });

  it('is indeterminate when a named point has no live state', () => {
    expect(roadSelection(road([{ pointId: 'p1', position: 'normal' }]), new Map())).toBe(
      'indeterminate',
    );
  });

  it('is indeterminate when a named point reads unknown', () => {
    const points = new Map([['p1', point('p1', 'unknown')]]);
    expect(roadSelection(road([{ pointId: 'p1', position: 'normal' }]), points)).toBe(
      'indeterminate',
    );
  });

  it('requires every clause of a multi-point road (#83: slips and three-ways)', () => {
    const points = new Map([
      ['p1', point('p1', 'normal')],
      ['p2', point('p2', 'normal')],
    ]);
    expect(
      roadSelection(
        road([
          { pointId: 'p1', position: 'normal' },
          { pointId: 'p2', position: 'normal' },
        ]),
        points,
      ),
    ).toBe('selected');
    expect(
      roadSelection(
        road([
          { pointId: 'p1', position: 'normal' },
          { pointId: 'p2', position: 'reverse' },
        ]),
        points,
      ),
    ).toBe('unselected');
  });

  it('prefers a definite disagreement over an unknown elsewhere in the same road', () => {
    // One clause is knowably wrong, so the road is knowably not set — that is
    // a stronger statement than "something here is unknown", and drawing it
    // as indeterminate would overstate the uncertainty.
    const points = new Map([['p1', point('p1', 'reverse')]]);
    expect(
      roadSelection(
        road([
          { pointId: 'missing', position: 'normal' },
          { pointId: 'p1', position: 'normal' },
        ]),
        points,
      ),
    ).toBe('unselected');
  });

  it('treats an empty `when` as indeterminate — it asserts nothing to confirm', () => {
    expect(roadSelection(road([]), new Map())).toBe('indeterminate');
  });
});

describe('perimeterEdges', () => {
  it('gives a single cell all four sides', () => {
    expect(perimeterEdges([{ x: 2, y: 3 }])).toHaveLength(4);
  });

  it('drops the shared side between two horizontally adjacent cells', () => {
    const edges = perimeterEdges([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ]);
    expect(edges).toHaveLength(6);
    expect(edges).not.toContainEqual({ x: 0, y: 0, side: 'e' });
    expect(edges).not.toContainEqual({ x: 1, y: 0, side: 'w' });
  });

  it('is 4-connected — a diagonal neighbour shares no edge and closes no gap', () => {
    const edges = perimeterEdges([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(edges).toHaveLength(8);
  });

  it('outlines the hole in a ring rather than filling it', () => {
    // A 3x3 block with its centre missing: 12 outer sides plus 4 inner ones.
    const cells = [];
    for (let x = 0; x < 3; x++) {
      for (let y = 0; y < 3; y++) {
        if (x === 1 && y === 1) continue;
        cells.push({ x, y });
      }
    }
    const edges = perimeterEdges(cells);
    expect(edges).toHaveLength(16);
    expect(edges).toContainEqual({ x: 1, y: 0, side: 's' });
  });

  it('tolerates a duplicated cell', () => {
    expect(
      perimeterEdges([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ]),
    ).toHaveLength(4);
  });
});
