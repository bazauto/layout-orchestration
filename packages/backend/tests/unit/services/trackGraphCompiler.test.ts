/**
 * `services/trackGraphCompiler` — the whole candidate graph, its gaps, and the
 * fingerprint of the drawing it came from (#103).
 *
 * The walk itself is covered by `edgeProposals.test.ts`, which passes unchanged
 * across the move and is the regression signal that the move was faithful. What
 * is tested here is what the compiler adds on top: **assertions over the
 * output**, not over the walk.
 *
 * That distinction is D7's whole argument and the reason the graph-level tests
 * below assert two things at once — that the cell-level note is present *and*
 * that a sentence naming the isolated block is present. When P1's tile was
 * tinted `Fiddle Yard 1`, the walk emitted three notes and never once said that
 * three blocks had become unreachable.
 */

import { describe, expect, it } from 'vitest';
import {
  CompileInput,
  CompileLimitExceededError,
  MAX_COMPILED_EDGES,
  compileTrackGraph,
  drawingFingerprint,
} from '../../../src/services/trackGraphCompiler';
import { GeometryTile, compileOpenings } from '../../../src/services/gridGeometry';
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
const decorative: GridTileMetadata = { trackRole: 'decorative' };

/** Every block drawn is known and detected unless a test says otherwise. */
function input(tiles: GeometryTile[], over: Partial<CompileInput> = {}): CompileInput {
  const drawn = [...new Set(tiles.map((t) => t.metadata.blockId).filter((b): b is string => !!b))];
  return {
    tiles,
    unreadable: [],
    blocks: drawn.map((id) => ({ id })),
    sensors: drawn.map((id) => ({ blockId: id, inService: true })),
    ...over,
  };
}

/** b1 — decorative — b2, the simplest real connection. */
const pair = (): GeometryTile[] => [
  tile(0, 0, inBlock('b1')),
  tile(1, 0, decorative),
  tile(2, 0, inBlock('b2')),
];

describe('compileTrackGraph — the graph it emits', () => {
  it('emits both directions of a connection, each naming the other end', () => {
    const { edges } = compileTrackGraph(input(pair()));

    expect(edges).toHaveLength(2);
    const pairs = edges.map((e) => `${e.fromBlockId}->${e.toBlockId}`).sort();
    expect(pairs).toEqual(['b1->b2', 'b2->b1']);
    // Every end is named. `block_edges` has no way to reference an unnamed one,
    // which is the whole reason `compileOpenings` may not refuse (D8/D-I).
    for (const e of edges) {
      expect(typeof e.fromEnd).toBe('string');
      expect(typeof e.toEnd).toBe('string');
    }
  });

  it('proposes nothing between two roads that merely run alongside each other', () => {
    // #91, restated because the compiler is a new caller of the walk: a
    // cell-adjacency walk joins every pair of parallel sidings on the layout.
    const { edges } = compileTrackGraph(
      input([
        tile(0, 0, inBlock('b1')),
        tile(1, 0, inBlock('b1')),
        tile(0, 1, inBlock('b2')),
        tile(1, 1, inBlock('b2')),
      ]),
    );

    expect(edges).toEqual([]);
  });

  it('never mirrors an arrival into a departure the drawing refuses (#104)', () => {
    // A point tinted as one of the blocks it serves. `fy2 -> fy1` is real — the
    // tile *is* fy1. `fy1 -> fy2` is not: a train in fy1 proper approaches
    // through P1's west leg, which no road joins to the south one. Mirroring
    // would author it, and a route planned over it trails through the blades.
    const { edges } = compileTrackGraph(
      input([
        tile(0, 0, inBlock('fy1')),
        {
          x: 1,
          y: 0,
          tileType: 'point-left',
          metadata: {
            blockId: 'fy1',
            rotation: 180,
            pointId: 'p1',
            pointRoads: [
              { when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'e'] },
              { when: [{ pointId: 'p1', position: 'reverse' }], legs: ['w', 'n'] },
            ],
          },
        },
        tile(1, 1, inBlock('fy2'), 'straight-45'),
        tile(0, 1, inBlock('fy2')),
      ]),
    );

    expect(edges.some((e) => e.fromBlockId === 'fy2' && e.toBlockId === 'fy1')).toBe(true);
    expect(edges.some((e) => e.fromBlockId === 'fy1' && e.toBlockId === 'fy2')).toBe(false);
  });

  it('refuses a drawing that compiles to more edges than a person will review', () => {
    const tiles: GeometryTile[] = [];
    for (let i = 0; i < 120; i++) {
      tiles.push(tile(0, i * 2, inBlock(`a${i}`)));
      tiles.push(tile(1, i * 2, decorative));
      tiles.push(tile(2, i * 2, inBlock(`b${i}`)));
    }

    expect(() => compileTrackGraph(input(tiles))).toThrow(CompileLimitExceededError);
    expect(MAX_COMPILED_EDGES).toBe(200);
  });
});

describe('compileTrackGraph — D7, assertions over the output', () => {
  it('names a block nothing reaches, not just the cell the walk stopped at', () => {
    // **This is D7's whole argument in one test.** The per-cell note is
    // necessary and nowhere near sufficient: it says where a walk stopped, and
    // reads as authoring noise. The block-level gap says which railway just
    // became unreachable.
    const { gaps } = compileTrackGraph(
      input([
        tile(0, 0, inBlock('b1')),
        tile(1, 0, {}), // unclassified — the walk stops here
        tile(2, 0, inBlock('b2')),
      ]),
    );

    expect(gaps).toContainEqual({ kind: 'blocked-by-unclassified', at: { x: 1, y: 0 } });

    const isolated = gaps.filter((g) => g.kind === 'block-not-in-graph');
    expect(isolated.map((g) => (g as { blockId: string }).blockId).sort()).toEqual(['b1', 'b2']);
  });

  it('reports a block in the graph with no in-service detection', () => {
    // Promoted from advice to a hard clause (D9): the argument that a mis-mapped
    // point is caught on first movement depends entirely on the wrong block
    // being detected. An undetected one produces no first failure at all — just
    // a train somewhere the system believes is empty.
    const tiles = pair();
    const { gaps } = compileTrackGraph(
      input(tiles, {
        sensors: [
          { blockId: 'b1', inService: true },
          { blockId: 'b2', inService: false },
        ],
      }),
    );

    expect(gaps).toContainEqual({ kind: 'block-without-detection', blockId: 'b2' });
    expect(gaps).not.toContainEqual({ kind: 'block-without-detection', blockId: 'b1' });
  });

  it('reports an opening with no edge, unless a buffer terminates it', () => {
    const open = [tile(0, 0, inBlock('b1')), tile(1, 0, inBlock('b1'))];
    const openGaps = compileTrackGraph(input(open)).gaps;
    expect(openGaps.some((g) => g.kind === 'opening-unresolved')).toBe(true);

    // A buffer is an answer, not an omission: it asserts track goes no further.
    const buffered = [
      tile(0, 0, inBlock('b1'), 'buffer'),
      tile(1, 0, inBlock('b1'), 'buffer'),
    ];
    const bufferedGaps = compileTrackGraph(input(buffered)).gaps;
    expect(bufferedGaps.some((g) => g.kind === 'opening-unresolved')).toBe(false);

    // Not vacuous: the buffered block really does have openings, they are just
    // all terminated. Without this the assertion above passes for a fixture
    // that produced no openings at all.
    const openings = compileOpenings(buffered);
    expect(openings.length).toBeGreaterThan(0);
    expect(openings.every((o) => o.terminated)).toBe(true);
  });

  it('names disconnected components without making them a gap (D-B)', () => {
    // Two legitimate railways in one layout. Gating on this would refuse `auto`
    // forever with nothing for the operator to acknowledge, so it is reported
    // and never gated.
    const { components, gaps } = compileTrackGraph(
      input([
        ...pair(),
        tile(0, 5, inBlock('c1')),
        tile(1, 5, decorative),
        tile(2, 5, inBlock('c2')),
      ]),
    );

    expect(components).toHaveLength(2);
    expect(components).toContainEqual(['b1', 'b2']);
    expect(components).toContainEqual(['c1', 'c2']);
    expect(gaps.some((g) => g.kind === 'block-not-in-graph')).toBe(false);
  });

  it('failure path: a corrupt tile is a gap, distinguished from an untagged one', () => {
    // `parseTileMetadata` returns `{}` for a bad blob, which makes corruption
    // indistinguishable from a to-do. Both block the walk, so both fail safe —
    // but only one of them is something an operator can finish by drawing.
    const { gaps } = compileTrackGraph(
      input(pair(), { unreadable: [{ at: { x: 9, y: 9 }, raw: '{oops' }] }),
    );

    expect(gaps).toContainEqual({ kind: 'tile-metadata-unreadable', at: { x: 9, y: 9 } });
  });

  it('failure path: a tile naming a deleted block yields no edge naming that block', () => {
    // Left alone this becomes an `unknown-block` violation, which is fatal on
    // reload and Safe-Stops the layout. The compiler must never hand one over.
    const tiles = [tile(0, 0, inBlock('b1')), tile(1, 0, decorative), tile(2, 0, inBlock('ghost'))];
    const { edges, gaps } = compileTrackGraph({
      tiles,
      unreadable: [],
      blocks: [{ id: 'b1' }],
      sensors: [{ blockId: 'b1', inService: true }],
    });

    expect(gaps).toContainEqual({
      kind: 'dangling-block-reference',
      at: { x: 2, y: 0 },
      blockId: 'ghost',
    });
    expect(edges.some((e) => e.fromBlockId === 'ghost' || e.toBlockId === 'ghost')).toBe(false);
  });
});

describe('drawingFingerprint', () => {
  const base = () => ({ tiles: pair(), unreadable: [] as { at: { x: number; y: number }; raw: string }[] });

  it('is stable across input permutation', () => {
    // Otherwise a re-read that returns rows in a different order reads as a
    // drawing edit and refuses an apply that should have succeeded.
    const a = drawingFingerprint(base());
    const b = drawingFingerprint({ ...base(), tiles: [...pair()].reverse() });
    expect(a).toBe(b);
  });

  it.each([
    ['rotation', (t: GeometryTile[]) => [{ ...t[0], metadata: { ...t[0].metadata, rotation: 90 as const } }, ...t.slice(1)]],
    ['blockId', (t: GeometryTile[]) => [{ ...t[0], metadata: { blockId: 'other' } }, ...t.slice(1)]],
    ['trackRole', (t: GeometryTile[]) => [{ ...t[0], metadata: { ...t[0].metadata, trackRole: 'decorative' as const } }, ...t.slice(1)]],
    ['pointId', (t: GeometryTile[]) => [{ ...t[0], metadata: { ...t[0].metadata, pointId: 'p9' } }, ...t.slice(1)]],
    ['coordinate', (t: GeometryTile[]) => [{ ...t[0], x: 42 }, ...t.slice(1)]],
    ['tileType', (t: GeometryTile[]) => [{ ...t[0], tileType: 'curve' as const }, ...t.slice(1)]],
  ])('changes when %s changes', (_name, mutate) => {
    expect(drawingFingerprint({ ...base(), tiles: mutate(pair()) })).not.toBe(
      drawingFingerprint(base()),
    );
  });

  it('does NOT change when an annotation is added', () => {
    // The field list is a contract, not a convenience: the walk never reads
    // `annotations`, so placing a sensor marker must not invalidate a review
    // somebody is part-way through.
    const annotated = [
      { ...pair()[0], metadata: { ...pair()[0].metadata, annotations: [{ entityType: 'sensor', entityId: 's1' }] } },
      ...pair().slice(1),
    ];
    expect(drawingFingerprint({ ...base(), tiles: annotated })).toBe(drawingFingerprint(base()));
  });

  it('changes when an unreadable tile’s raw blob changes', () => {
    // So that repairing corruption moves the fingerprint like any other edit,
    // rather than leaving a reviewed graph looking current.
    const one = drawingFingerprint({ ...base(), unreadable: [{ at: { x: 1, y: 1 }, raw: '{a' }] });
    const two = drawingFingerprint({ ...base(), unreadable: [{ at: { x: 1, y: 1 }, raw: '{b' }] });
    expect(one).not.toBe(two);
  });
});
