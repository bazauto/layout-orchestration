/**
 * `services/gridGeometry` — deriving block openings and their cardinal labels
 * from the drawing (#72), and the buffer termination #84 builds on.
 *
 * The interesting cases are the ones that produce a *wrong name* rather than
 * no name: a bearing computed from the wrong origin, two openings quietly
 * sharing one label, or a dead end that produces no end at all and so looks
 * identical to unfinished track.
 */

import { describe, expect, it } from 'vitest';
import {
  GeometryTile,
  bearingLabel,
  findBlockRuns,
  generateBlockEnds,
} from '../../../src/services/gridGeometry';
import { GridTileMetadata, TileType } from '../../../src/domain/types';

function tile(
  x: number,
  y: number,
  metadata: GridTileMetadata = {},
  tileType: TileType = 'straight-h',
): GeometryTile {
  return { x, y, tileType, metadata };
}

const inBlock = (id: string): GridTileMetadata => ({ blockId: id });

describe('bearingLabel', () => {
  // North is the top of the *diagram*, so y decreasing is north. Getting this
  // inverted would name every end its opposite, and the pathfinder would plan
  // through it happily because it has no independent notion of geometry.
  it.each([
    [0, -1, 'north'],
    [1, -1, 'northeast'],
    [1, 0, 'east'],
    [1, 1, 'southeast'],
    [0, 1, 'south'],
    [-1, 1, 'southwest'],
    [-1, 0, 'west'],
    [-1, -1, 'northwest'],
  ])('maps (%i, %i) to %s', (dx, dy, expected) => {
    expect(bearingLabel(dx, dy)).toBe(expected);
  });

  it('returns null for a zero vector rather than inventing a direction', () => {
    expect(bearingLabel(0, 0)).toBeNull();
  });

  it('rounds to the nearest of the eight points', () => {
    expect(bearingLabel(10, -1)).toBe('east');
    expect(bearingLabel(10, -9)).toBe('northeast');
  });
});

describe('findBlockRuns', () => {
  it('groups 8-connected tiles of one block into a single run', () => {
    const runs = findBlockRuns([
      tile(0, 0, inBlock('b1')),
      tile(1, 1, inBlock('b1')), // diagonal — a 45° run is one block
      tile(2, 1, inBlock('b1')),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0].tiles).toHaveLength(3);
  });

  it('gives a block drawn in two disconnected places one run per place', () => {
    const runs = findBlockRuns([tile(0, 0, inBlock('b1')), tile(9, 9, inBlock('b1'))]);
    expect(runs).toHaveLength(2);
  });

  it('excludes decorative and unclassified tiles, so neither extends a block', () => {
    const runs = findBlockRuns([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, { trackRole: 'decorative' }),
      tile(2, 0, {}),
      tile(3, 0, inBlock('b1')),
    ]);

    // Two runs, not one: the decorative feeder between them is deliberately
    // not part of any block and must not silently join two blocks together.
    expect(runs).toHaveLength(2);
  });
});

describe('generateBlockEnds', () => {
  it('names the two ends of a straight block west and east', () => {
    const { openings, collisions } = generateBlockEnds([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, inBlock('b1')),
    ]);

    expect(collisions).toEqual([]);
    expect(openings.map((o) => o.label).sort()).toEqual(['east', 'west']);
    // The label lands on a tile of the block, so the editor can draw it
    // somewhere real rather than in the gap next to it.
    expect(openings.find((o) => o.label === 'west')!.at).toEqual({ x: 0, y: 0 });
    expect(openings.find((o) => o.label === 'east')!.at).toEqual({ x: 2, y: 0 });
  });

  it('finds an opening where one block hands over to another', () => {
    const { openings } = generateBlockEnds([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, inBlock('b2')),
      tile(3, 0, inBlock('b2')),
    ]);

    expect(openings.filter((o) => o.blockId === 'b1').map((o) => o.label).sort()).toEqual([
      'east',
      'west',
    ]);
    expect(openings.filter((o) => o.blockId === 'b2').map((o) => o.label).sort()).toEqual([
      'east',
      'west',
    ]);
  });

  it('finds an opening onto decorative track, which is where a block hands over to undetected rails', () => {
    // The Westgate Hollow entry feeder: plain track the system neither detects
    // nor reserves. The block still has an end there.
    const { openings } = generateBlockEnds([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, { trackRole: 'decorative' }),
    ]);

    expect(openings.map((o) => o.label).sort()).toEqual(['east', 'west']);
  });

  it('marks an end terminated when a buffer tile sits at it', () => {
    const { openings } = generateBlockEnds([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, inBlock('b1'), 'buffer'),
    ]);

    const east = openings.find((o) => o.label === 'east')!;
    // Without this, a siding ending in buffers touches nothing foreign and so
    // would produce no end at all — indistinguishable from unfinished track,
    // which is exactly the ambiguity #84 exists to remove.
    expect(east.terminated).toBe(true);
    expect(openings.find((o) => o.label === 'west')!.terminated).toBe(false);
  });

  it('refuses to name two separate openings that face the same way', () => {
    // One block drawn as two parallel roads — each opens west to the throat
    // and east to its buffer, from two different places.
    const { openings, collisions } = generateBlockEnds([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, inBlock('b1'), 'buffer'),
      tile(0, 4, inBlock('b1')),
      tile(1, 4, inBlock('b1')),
      tile(2, 4, inBlock('b1'), 'buffer'),
    ]);

    // Refusing beats suffixing: `east_2` is exactly the kind of name that gets
    // typed wrong later in an edge, and the manual override exists for this.
    expect(collisions.map((c) => c.label).sort()).toEqual(['east', 'west']);
    expect(collisions.find((c) => c.label === 'east')!.at).toHaveLength(2);
    expect(openings).toEqual([]);
  });

  it('collapses a multi-cell handover face into a single end', () => {
    // b1 meets b2 along three cells. The railway has one opening there; three
    // generated labels for it would be worse than none, because an edge would
    // then reference a name for a place that does not exist.
    const { openings, collisions } = generateBlockEnds([
      tile(0, 0, inBlock('b1')),
      tile(0, 1, inBlock('b1')),
      tile(0, 2, inBlock('b1')),
      tile(1, 0, inBlock('b2')),
      tile(1, 1, inBlock('b2')),
      tile(1, 2, inBlock('b2')),
    ]);

    expect(collisions).toEqual([]);
    expect(openings.filter((o) => o.blockId === 'b1')).toEqual([
      { blockId: 'b1', label: 'east', at: { x: 0, y: 1 }, terminated: false },
    ]);
    expect(openings.filter((o) => o.blockId === 'b2')).toEqual([
      { blockId: 'b2', label: 'west', at: { x: 1, y: 1 }, terminated: false },
    ]);
  });

  it('produces nothing for a layout with no block-tagged tiles', () => {
    expect(generateBlockEnds([tile(0, 0, {}), tile(1, 0, { trackRole: 'decorative' })])).toEqual({
      openings: [],
      collisions: [],
    });
  });

  it('is deterministic across input order, so labels do not shuffle between reloads', () => {
    const tiles = [
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, inBlock('b2')),
    ];
    expect(generateBlockEnds(tiles)).toEqual(generateBlockEnds([...tiles].reverse()));
  });
});
