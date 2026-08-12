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
  findUnjoinedEdges,
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

describe('findUnjoinedEdges', () => {
  it('reports track that runs into a tile drawing nothing back', () => {
    // The horizontal run's east edge meets a tile drawn vertically, which has
    // nothing on its west boundary. The drawing looks continuous; it is not.
    expect(
      findUnjoinedEdges([
        tile(0, 0, inBlock('b1')),
        tile(1, 0, { blockId: 'b2', rotation: 90 }),
      ]),
    ).toEqual([{ at: { x: 0, y: 0 }, edge: 'e', against: { x: 1, y: 0 } }]);
  });

  it('never reports a line ending in open air', () => {
    // An unoccupied neighbour is a legitimate end of the line — most of a
    // half-drawn layout looks like this, and flagging it would bury the real
    // findings.
    expect(findUnjoinedEdges([tile(0, 0, inBlock('b1'))])).toEqual([]);
  });

  it('catches decorative track drawn into a block that does not meet it', () => {
    // The direction the mistake usually points: decorative track is drawn last,
    // against a block already in place. The run walk only visits block tiles,
    // so this pass has to cover all of them.
    const found = findUnjoinedEdges([
      tile(0, 0, { trackRole: 'decorative' }),
      tile(1, 0, { blockId: 'b1', rotation: 90 }),
    ]);

    expect(found).toEqual([{ at: { x: 0, y: 0 }, edge: 'e', against: { x: 1, y: 0 } }]);
  });

  it('is sorted, so the diagnostics list does not reshuffle between polls', () => {
    const found = findUnjoinedEdges([
      tile(5, 5, inBlock('b1')),
      tile(6, 5, { blockId: 'b2', rotation: 90 }),
      tile(0, 1, inBlock('b3')),
      tile(1, 1, { blockId: 'b4', rotation: 90 }),
    ]);

    expect(found.map((u) => u.at)).toEqual([
      { x: 0, y: 1 },
      { x: 5, y: 5 },
    ]);
  });
});

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

/**
 * #91 — the shape that produced the issue. Two blocks drawn side by side touch
 * along their whole length and connect nowhere, and before the fix every tile
 * of both read as an opening toward the other.
 */
describe('generateBlockEnds — touching is not connecting (#91)', () => {
  /** Two parallel single-row blocks, as ordinary as a layout gets: a two-road fiddle yard. */
  const parallelRoads = (): GeometryTile[] => [
    tile(0, 0, inBlock('b1')),
    tile(1, 0, inBlock('b1')),
    tile(2, 0, inBlock('b1')),
    tile(0, 1, inBlock('b2')),
    tile(1, 1, inBlock('b2')),
    tile(2, 1, inBlock('b2')),
  ];

  const endsOf = (openings: ReturnType<typeof generateBlockEnds>['openings'], blockId: string) =>
    openings
      .filter((o) => o.blockId === blockId)
      .map((o) => ({ label: o.label, at: o.at }))
      .sort((a, b) => a.label.localeCompare(b.label));

  it('gives each of two parallel roads its own two ends', () => {
    // Before the fix: one end per block, labelled `south`/`north`, sitting at
    // (1,0)/(1,1) — the middle of the siding — and the two real ends absent.
    const { openings, collisions } = generateBlockEnds(parallelRoads());

    expect(endsOf(openings, 'b1')).toEqual([
      { label: 'east', at: { x: 2, y: 0 } },
      { label: 'west', at: { x: 0, y: 0 } },
    ]);
    expect(endsOf(openings, 'b2')).toEqual([
      { label: 'east', at: { x: 2, y: 1 } },
      { label: 'west', at: { x: 0, y: 1 } },
    ]);
    expect(collisions).toEqual([]);
  });

  it('does not open a block toward one it merely runs alongside', () => {
    const { openings } = generateBlockEnds(parallelRoads());

    // No drawn track crosses between the two rows, so neither block opens
    // north or south at all. This is the assertion the whole issue reduces to.
    expect(openings.every((o) => o.label !== 'north' && o.label !== 'south')).toBe(true);
  });

  it('recovers the buffered end of a yard road drawn beside another', () => {
    // The Fiddle Yard shape: a buffer at the west end of each road, stub facing
    // east into the run (`rotation: 180`), and the throat open at the east.
    const tiles: GeometryTile[] = [
      tile(0, 0, { blockId: 'b1', rotation: 180 }, 'buffer'),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, inBlock('b1')),
      tile(0, 1, { blockId: 'b2', rotation: 180 }, 'buffer'),
      tile(1, 1, inBlock('b2')),
      tile(2, 1, inBlock('b2')),
    ];

    const { openings } = generateBlockEnds(tiles);
    const b1 = openings.filter((o) => o.blockId === 'b1');

    expect(b1.find((o) => o.label === 'west')).toMatchObject({
      at: { x: 0, y: 0 },
      terminated: true,
    });
    expect(b1.find((o) => o.label === 'east')).toMatchObject({
      at: { x: 2, y: 0 },
      terminated: false,
    });
  });

  it('honours rotation, so a vertical run gets vertical ends', () => {
    const tiles: GeometryTile[] = [
      tile(0, 0, { blockId: 'b1', rotation: 90 }),
      tile(0, 1, { blockId: 'b1', rotation: 90 }),
      tile(0, 2, { blockId: 'b1', rotation: 90 }),
    ];

    expect(endsOf(generateBlockEnds(tiles).openings, 'b1')).toEqual([
      { label: 'north', at: { x: 0, y: 0 } },
      { label: 'south', at: { x: 0, y: 2 } },
    ]);
  });

  it('treats track butting a tile that does not meet it as an end, not a join', () => {
    // `b2` is drawn vertical, so its west edge has nothing on it. `b1`'s track
    // stops against a wall rather than continuing into it.
    const tiles: GeometryTile[] = [
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, { blockId: 'b2', rotation: 90 }),
    ];

    const { openings } = generateBlockEnds(tiles);

    expect(openings.find((o) => o.blockId === 'b1' && o.label === 'east')).toBeDefined();
    expect(openings.some((o) => o.blockId === 'b2' && o.label === 'west')).toBe(false);
  });

  it('opens a block through a point’s divergent leg', () => {
    // A point on `b1`'s row diverging down to `b2` on the next, which is the
    // Westgate Hollow throat in miniature.
    const tiles: GeometryTile[] = [
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, inBlock('b1'), 'point-right'),
      // `straight-45` unrotated joins west and north — exactly the corner that
      // takes the point's divergent leg down and across to the next row.
      tile(2, 1, inBlock('b2'), 'straight-45'),
      tile(1, 1, inBlock('b2')),
      tile(0, 1, inBlock('b2')),
    ];

    const { openings } = generateBlockEnds(tiles);

    // The point tile opens toward the tile below it, and that tile opens back.
    expect(openings.some((o) => o.blockId === 'b1' && o.at.x === 2 && o.at.y === 0)).toBe(true);
    expect(openings.some((o) => o.blockId === 'b2' && o.at.x === 2 && o.at.y === 1)).toBe(true);
  });

  it('never marks an open-air end as terminated', () => {
    const { openings } = generateBlockEnds(parallelRoads());
    expect(openings.every((o) => o.terminated === false)).toBe(true);
  });

  it('does not call a mixed face a finished dead end', () => {
    // One cell of the face is buffered, the next continues into `b2`. Under the
    // old `some()` aggregation the whole end read as terminated — which
    // suppresses `end-unfinished`, and once the b1→b2 edge is authored raises a
    // false `buffer-contradicted-by-edge`. It is unfinished until that edge
    // exists, and that is what it now says.
    const { openings } = generateBlockEnds([
      tile(0, 0, inBlock('b1'), 'buffer'),
      tile(0, 1, inBlock('b1')),
      tile(1, 1, inBlock('b2')),
    ]);

    expect(openings.find((o) => o.blockId === 'b1' && o.label === 'east')).toMatchObject({
      terminated: false,
    });
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

    // The single-end-per-face rule is what this test is for, and it holds: one
    // `east` on b1 and one `west` on b2, not three of each.
    //
    // The outer ends are new since #91 and are correct. Each of these tiles is
    // a `straight-h`, so every one of them also draws a stub into the empty
    // column beyond, and three cells of open track ending in mid-air is a real
    // opening — the drawing simply does not say what is out there yet. Under
    // the old adjacency model it was invisible, because nothing foreign was
    // touching it.
    const named = (blockId: string) =>
      openings
        .filter((o) => o.blockId === blockId)
        .map(({ label, at, terminated }) => ({ label, at, terminated }));

    expect(named('b1')).toEqual([
      { label: 'east', at: { x: 0, y: 1 }, terminated: false },
      { label: 'west', at: { x: 0, y: 1 }, terminated: false },
    ]);
    expect(named('b2')).toEqual([
      { label: 'east', at: { x: 1, y: 1 }, terminated: false },
      { label: 'west', at: { x: 1, y: 1 }, terminated: false },
    ]);

    // The three cells of the handover face are one opening, and it carries all
    // three boundaries — which is what lets #78 tell which end a walk arrived
    // at when an end is several cells wide.
    expect(openings.find((o) => o.blockId === 'b1' && o.label === 'east')!.ports).toHaveLength(3);
  });

  it('reports nothing unjoined for a fully joined drawing', () => {
    // The no-noise guarantee `track-not-joined` lives or dies by: this is the
    // shape most of a layout is, and it must be silent.
    expect(
      findUnjoinedEdges([
        tile(0, 0, inBlock('b1')),
        tile(1, 0, inBlock('b1')),
        tile(0, 1, inBlock('b2')),
        tile(1, 1, inBlock('b2')),
      ]),
    ).toEqual([]);
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
