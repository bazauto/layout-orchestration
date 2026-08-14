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
  compileOpenings,
  findBlockRuns,
  findUnjoinedEdges,
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
describe('compileOpenings — touching is not connecting (#91)', () => {
  /** Two parallel single-row blocks, as ordinary as a layout gets: a two-road fiddle yard. */
  const parallelRoads = (): GeometryTile[] => [
    tile(0, 0, inBlock('b1')),
    tile(1, 0, inBlock('b1')),
    tile(2, 0, inBlock('b1')),
    tile(0, 1, inBlock('b2')),
    tile(1, 1, inBlock('b2')),
    tile(2, 1, inBlock('b2')),
  ];

  const endsOf = (openings: ReturnType<typeof compileOpenings>, blockId: string) =>
    openings
      .filter((o) => o.blockId === blockId)
      .map((o) => ({ label: o.label, at: o.at }))
      .sort((a, b) => a.label.localeCompare(b.label));

  it('gives each of two parallel roads its own two ends', () => {
    // Before the fix: one end per block, labelled `south`/`north`, sitting at
    // (1,0)/(1,1) — the middle of the siding — and the two real ends absent.
    const openings = compileOpenings(parallelRoads());

    expect(endsOf(openings, 'b1')).toEqual([
      { label: 'east', at: { x: 2, y: 0 } },
      { label: 'west', at: { x: 0, y: 0 } },
    ]);
    expect(endsOf(openings, 'b2')).toEqual([
      { label: 'east', at: { x: 2, y: 1 } },
      { label: 'west', at: { x: 0, y: 1 } },
    ]);
    // Bare cardinals, not suffixed: each block has exactly one opening facing
    // each way, so there is nothing to disambiguate.
  });

  it('does not open a block toward one it merely runs alongside', () => {
    const openings = compileOpenings(parallelRoads());

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

    const openings = compileOpenings(tiles);
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

    expect(endsOf(compileOpenings(tiles), 'b1')).toEqual([
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

    const openings = compileOpenings(tiles);

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

    const openings = compileOpenings(tiles);

    // The point tile opens toward the tile below it, and that tile opens back.
    expect(openings.some((o) => o.blockId === 'b1' && o.at.x === 2 && o.at.y === 0)).toBe(true);
    expect(openings.some((o) => o.blockId === 'b2' && o.at.x === 2 && o.at.y === 1)).toBe(true);
  });

  it('never marks an open-air end as terminated', () => {
    const openings = compileOpenings(parallelRoads());
    expect(openings.every((o) => o.terminated === false)).toBe(true);
  });

  it('does not call a mixed face a finished dead end', () => {
    // One cell of the face is buffered, the next continues into `b2`. Under the
    // old `some()` aggregation the whole end read as terminated — which
    // suppresses `end-unfinished`, and once the b1→b2 edge is authored raises a
    // false `buffer-contradicted-by-edge`. It is unfinished until that edge
    // exists, and that is what it now says.
    const openings = compileOpenings([
      tile(0, 0, inBlock('b1'), 'buffer'),
      tile(0, 1, inBlock('b1')),
      tile(1, 1, inBlock('b2')),
    ]);

    expect(openings.find((o) => o.blockId === 'b1' && o.label === 'east')).toMatchObject({
      terminated: false,
    });
  });
});

describe('compileOpenings — naming and clustering', () => {
  it('names the two ends of a straight block west and east', () => {
    const openings = compileOpenings([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, inBlock('b1')),
    ]);

    expect(openings.map((o) => o.label).sort()).toEqual(['east', 'west']);
    // The label lands on a tile of the block, so the editor can draw it
    // somewhere real rather than in the gap next to it.
    expect(openings.find((o) => o.label === 'west')!.at).toEqual({ x: 0, y: 0 });
    expect(openings.find((o) => o.label === 'east')!.at).toEqual({ x: 2, y: 0 });
  });

  it('finds an opening where one block hands over to another', () => {
    const openings = compileOpenings([
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
    const openings = compileOpenings([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, { trackRole: 'decorative' }),
    ]);

    expect(openings.map((o) => o.label).sort()).toEqual(['east', 'west']);
  });

  it('marks an end terminated when a buffer tile sits at it', () => {
    const openings = compileOpenings([
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

  it('suffixes two separate openings that face the same way, rather than refusing both', () => {
    // One block drawn as two parallel roads — each opens west to the throat
    // and east to its buffer, from two different places.
    //
    // `generateBlockEnds` named **neither**, because the label was an
    // identifier a later edge would be typed against and a guessed `east_2`
    // gets typed wrong. The cost was that a real, drawn, trafficable opening
    // became unreferenceable: naming failure was routing failure, which is the
    // whole of #103. A disposable label may be guessed at freely.
    const openings = compileOpenings([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, inBlock('b1'), 'buffer'),
      tile(0, 4, inBlock('b1')),
      tile(1, 4, inBlock('b1')),
      tile(2, 4, inBlock('b1'), 'buffer'),
    ]);

    expect(openings.map((o) => o.label).sort()).toEqual([
      'east-1',
      'east-2',
      'west-1',
      'west-2',
    ]);
    // Ordered by the cluster's own (y, x), so a redraw that does not move these
    // openings does not renumber them either.
    expect(openings.find((o) => o.label === 'west-1')!.at).toEqual({ x: 0, y: 0 });
    expect(openings.find((o) => o.label === 'west-2')!.at).toEqual({ x: 0, y: 4 });
  });

  it('collapses a multi-cell handover face into a single end', () => {
    // b1 meets b2 along three cells. The railway has one opening there; three
    // generated labels for it would be worse than none, because an edge would
    // then reference a name for a place that does not exist.
    const openings = compileOpenings([
      tile(0, 0, inBlock('b1')),
      tile(0, 1, inBlock('b1')),
      tile(0, 2, inBlock('b1')),
      tile(1, 0, inBlock('b2')),
      tile(1, 1, inBlock('b2')),
      tile(1, 2, inBlock('b2')),
    ]);

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

});

/**
 * `compileOpenings` — D-I's disambiguation, the disposable-output twin of
 * `generateBlockEnds`. Never refuses, never drops: every raw opening this
 * walk finds gets a name, because nothing between compiles references one by
 * string (D8).
 */
describe('compileOpenings', () => {
  /**
   * `aedae611-…` is Westgate Hollow's real `Engine / Goods Transfer` block, as
   * drawn (`grid_tiles`, verified against `packages/backend/data/layout.db`).
   * Under #72's model these two openings — 118.5° and 134.7° from the run's
   * centroid, both rounding to `southeast` — could not be named at all
   * (`end-label-collision`), which is the specific failure #103 exists to
   * end. This is that fixture, not a stand-in for it.
   */
  const engineGoodsTransfer = (): GeometryTile[] => {
    const blockId = 'aedae611-310e-4f43-96e9-b07f3a6d9e87';
    const rows: Array<[number, number, GridTileMetadata['rotation']]> = [
      [13, 4, 90],
      [14, 4, 270],
      [14, 5, 90],
      [19, 10, 90],
      [19, 9, 270],
      [18, 9, 90],
      [17, 8, 90],
      [16, 7, 90],
      [15, 6, 90],
      [15, 5, 270],
      [16, 6, 270],
      [17, 7, 270],
    ];
    return [
      ...rows.map(([x, y, rotation]) =>
        tile(x, y, { blockId, rotation }, 'straight-45'),
      ),
      {
        x: 18,
        y: 8,
        tileType: 'point-right',
        metadata: {
          blockId,
          rotation: 0,
          pointId: '720bde49-5e2e-47f9-b691-1391e0195240',
          pointRoads: [
            {
              when: [{ pointId: '720bde49-5e2e-47f9-b691-1391e0195240', position: 'normal' }],
              legs: ['w', 'e'],
            },
            {
              when: [{ pointId: '720bde49-5e2e-47f9-b691-1391e0195240', position: 'reverse' }],
              legs: ['w', 's'],
            },
          ],
        },
      },
    ];
  };

  it('names Westgate Hollow’s colliding pair southeast-1 / southeast-2, ordered by (y, x)', () => {
    // Two openings at 118.5° and 134.7° from the run's centroid, both rounding
    // to `southeast`. `generateBlockEnds` named **neither** — a collision — so
    // no edge could reference either, and the block's whole south-east face was
    // unroutable. That is the failure #103 is named after, and this is the
    // fixture it happened on, not a stand-in.
    //
    // Both are named now, and the applied live graph routes through both:
    // `southeast-1` to the engine sheds, `southeast-2` to the goods shed.
    const openings = compileOpenings(engineGoodsTransfer());
    const blockId = 'aedae611-310e-4f43-96e9-b07f3a6d9e87';
    const southeast = openings.filter((o) => o.blockId === blockId && o.label.startsWith('southeast'));

    expect(southeast.map((o) => ({ label: o.label, at: o.at }))).toEqual([
      { label: 'southeast-1', at: { x: 18, y: 8 } },
      { label: 'southeast-2', at: { x: 19, y: 10 } },
    ]);
  });

  it('keeps the bare cardinal for an opening with no collision', () => {
    const openings = compileOpenings([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(2, 0, inBlock('b1')),
    ]);

    expect(openings.map((o) => o.label).sort()).toEqual(['east', 'west']);
  });

  it('failure path: a zero-bearing opening gets a port-derived label, never dropped', () => {
    // A pair of vertical tiles sit atop a pair of horizontal ones. `straight-v`
    // draws n/s, `straight-h` draws w/e, so the top row's south face is never
    // met — and because the pair sits astride the run's own centroid (the
    // shape is a symmetric 2x2 square), `bearingLabel` returns null for it.
    // Under `generateBlockEnds` this opening simply never existed.
    const tiles: GeometryTile[] = [
      tile(0, 0, inBlock('b1'), 'straight-v'),
      tile(1, 0, inBlock('b1'), 'straight-v'),
      tile(0, 1, inBlock('b1')),
      tile(1, 1, inBlock('b1')),
    ];

    // The premise is `bearingLabel(0, 0) === null`, covered in its own describe
    // above. What matters here is that the opening whose cluster mean lands
    // exactly on the centroid **survives**: the old walk dropped it, so a real
    // opening was invisible for want of a bearing.
    const openings = compileOpenings(tiles);
    expect(openings).toHaveLength(4); // one per raw directional cluster — none merged away

    const fromZeroBearing = openings.find(
      (o) => o.ports.length === 2 && o.ports.every((p) => p.edge === 's'),
    );
    expect(fromZeroBearing).toMatchObject({ label: 'south', at: { x: 0, y: 0 } });
  });

  it('is stable across input permutation, so labels do not shuffle between reloads', () => {
    const tiles = engineGoodsTransfer();
    expect(compileOpenings(tiles)).toEqual(compileOpenings([...tiles].reverse()));
  });

  it('produces nothing for a layout with no block-tagged tiles', () => {
    expect(compileOpenings([tile(0, 0, {}), tile(1, 0, { trackRole: 'decorative' })])).toEqual([]);
  });
});
