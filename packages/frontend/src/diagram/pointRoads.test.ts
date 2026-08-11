/**
 * `diagram/pointRoads` — the leg mapping a point tile carries (#73).
 *
 * The shape is what these tests mostly defend. #83's highest-value item is
 * that the representation be leg-list-shaped rather than a binary `normalLeg`,
 * because this data is being authored against real point tiles right now and
 * retrofitting it means a migration plus revisiting every point by hand.
 */

import { describe, expect, it } from 'vitest';
import { defaultPointRoads, edgeAnchor, isPointTile, roadFor, roadLabel } from './pointRoads';
import { TilePointRoad } from '../types';

describe('edgeAnchor', () => {
  it('places each named edge on the tile boundary', () => {
    expect(edgeAnchor('n', 40)).toEqual({ x: 20, y: 0 });
    expect(edgeAnchor('e', 40)).toEqual({ x: 40, y: 20 });
    expect(edgeAnchor('s', 40)).toEqual({ x: 20, y: 40 });
    expect(edgeAnchor('w', 40)).toEqual({ x: 0, y: 20 });
    expect(edgeAnchor('nw', 40)).toEqual({ x: 0, y: 0 });
    expect(edgeAnchor('se', 40)).toEqual({ x: 40, y: 40 });
  });
});

describe('isPointTile', () => {
  it('is true only for tile types that actually draw two legs', () => {
    expect(isPointTile('point-left')).toBe(true);
    expect(isPointTile('point-right')).toBe(true);
    expect(isPointTile('straight-h')).toBe(false);
    expect(isPointTile('crossing')).toBe(false);
  });
});

describe('defaultPointRoads', () => {
  it('maps normal to the through road and reverse to the divergent one', () => {
    expect(defaultPointRoads('point-left', 'p1')).toEqual([
      { when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'e'] },
      { when: [{ pointId: 'p1', position: 'reverse' }], legs: ['w', 'n'] },
    ]);
  });

  it('diverges south for a point-right, matching what TilePath draws', () => {
    expect(defaultPointRoads('point-right', 'p1')![1].legs).toEqual(['w', 's']);
  });

  it('swaps the mapping for a point wired the other way round', () => {
    const roads = defaultPointRoads('point-left', 'p1', true)!;
    expect(roads[0]).toEqual({ when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'n'] });
    expect(roads[1]).toEqual({ when: [{ pointId: 'p1', position: 'reverse' }], legs: ['w', 'e'] });
  });

  it('returns undefined for a tile that depicts no point', () => {
    expect(defaultPointRoads('straight-h', 'p1')).toBeUndefined();
  });

  it('names legs in the unrotated frame, so rotation cannot invalidate them', () => {
    // Rotation is applied at render time. Recording the post-rotation edge
    // would silently become wrong the moment the tile was rotated — and
    // rotation is a single keypress in this editor.
    expect(defaultPointRoads('point-left', 'p1')).toEqual(
      defaultPointRoads('point-left', 'p1'),
    );
  });
});

describe('roadFor', () => {
  const roads: TilePointRoad[] = [
    { when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'e'] },
    { when: [{ pointId: 'p1', position: 'reverse' }], legs: ['w', 'n'] },
  ];

  it('selects the road matching the point position', () => {
    expect(roadFor(roads, { p1: 'normal' })!.legs).toEqual(['w', 'e']);
    expect(roadFor(roads, { p1: 'reverse' })!.legs).toEqual(['w', 'n']);
  });

  it('selects nothing when the position is unknown', () => {
    // You cannot draw the road that uncertainty selects. Until #25 there is no
    // confirmed position at all, and a mimic must not invent one.
    expect(roadFor(roads, { p1: 'unknown' })).toBeUndefined();
  });

  it('requires EVERY condition to hold, so a slip needs both mechanisms set', () => {
    // The case a binary `normalLeg` field forecloses: one piece of track, two
    // independently switched mechanisms.
    const slip: TilePointRoad[] = [
      {
        when: [
          { pointId: 'p1', position: 'normal' },
          { pointId: 'p2', position: 'reverse' },
        ],
        legs: ['w', 'n'],
      },
    ];

    expect(roadFor(slip, { p1: 'normal', p2: 'reverse' })).toBeDefined();
    expect(roadFor(slip, { p1: 'normal', p2: 'normal' })).toBeUndefined();
    expect(roadFor(slip, { p1: 'normal' })).toBeUndefined();
  });

  it('tolerates a tile with no mapping at all', () => {
    expect(roadFor(undefined, { p1: 'normal' })).toBeUndefined();
  });
});

describe('roadLabel', () => {
  it('uses a letter, not a colour, so the mapping survives colour being removed', () => {
    expect(roadLabel({ when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'e'] })).toBe('N');
    expect(roadLabel({ when: [{ pointId: 'p1', position: 'reverse' }], legs: ['w', 'n'] })).toBe('R');
  });

  it('joins a multi-mechanism road', () => {
    expect(
      roadLabel({
        when: [
          { pointId: 'p1', position: 'normal' },
          { pointId: 'p2', position: 'reverse' },
        ],
        legs: ['w', 'n'],
      }),
    ).toBe('N+R');
  });
});
