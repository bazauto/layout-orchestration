import { describe, expect, it } from 'vitest';
import { buildLiveBlocks, roadSelection } from './liveState';
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

/**
 * Builds a `'none'`-feedback point whose `effectivePosition` reads
 * `position` — the pre-#25 trust model, and the simplest fixture for a test
 * that only cares about `roadSelection`'s own logic. `positionFeedback:
 * 'required'` points are covered by `pointConfirmation.test.ts`.
 */
function point(pointId: string, position: PointState['confirmedPosition']): PointState {
  return {
    pointId,
    commandedPosition: null,
    confirmedPosition: position,
    confirmation: position === 'unknown' ? 'unreported' : 'confirmed',
    positionFeedback: 'none',
    awaitingSince: null,
    lastReadingAt: null,
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
    autoSpeedStep: null,
    crawlSpeedStep: null,
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

// `perimeterEdges` and its tests went with the lock outline it drew (#129).
// A route is a line along the track now; nothing outlines a run.
