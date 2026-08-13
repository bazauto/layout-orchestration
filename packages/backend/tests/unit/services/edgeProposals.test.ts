/**
 * `services/edgeProposals` — candidate `block_edges` derived from the drawing (#78).
 *
 * Two properties are defended above all others. The walk must **under**-propose:
 * a missing candidate is a minute of typing, and a wrong one is a route granted
 * over track that is not there. And it must refuse *audibly* — every place it
 * declines to guess leaves a note naming the cell, because silence and refusal
 * are indistinguishable from the outside.
 *
 * Openings come from the real `generateBlockEnds` rather than hand-built
 * `BlockOpening`s, so these fixtures exercise the same geometry the live layout
 * does.
 */

import { describe, expect, it } from 'vitest';
import { generateBlockEnds, GeometryTile } from '../../../src/services/gridGeometry';
import {
  ProposalLimitExceededError,
  proposeEdges,
  reconcileProposals,
} from '../../../src/services/edgeProposals';
import { BlockEdge, BlockEnd, GridTileMetadata, TileType } from '../../../src/domain/types';

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

/** Runs the whole pure pipeline the way `GridService` does. */
const propose = (tiles: GeometryTile[]) =>
  proposeEdges({ tiles, openings: generateBlockEnds(tiles).openings });

/** A point drawn as decorative track, which is how Westgate Hollow's points are authored. */
const pointTile = (
  x: number,
  y: number,
  pointId: string,
  tileType: TileType,
  divergent: 'n' | 's',
  rotation: GridTileMetadata['rotation'] = 0,
): GeometryTile => ({
  x,
  y,
  tileType,
  metadata: {
    ...decorative,
    pointId,
    rotation,
    pointRoads: [
      { when: [{ pointId, position: 'normal' }], legs: ['w', 'e'] },
      { when: [{ pointId, position: 'reverse' }], legs: ['w', divergent] },
    ],
  },
});

describe('proposeEdges — what it refuses to find', () => {
  it('proposes nothing between two roads that merely run alongside each other', () => {
    // The #91 shape from this side, and the single most important test here: a
    // cell-adjacency walk proposes an edge between every pair of parallel
    // sidings on the layout. A port walk proposes none, because neither tile
    // draws anything across the shared boundary.
    const { proposals } = propose([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, inBlock('b1')),
      tile(0, 1, inBlock('b2')),
      tile(1, 1, inBlock('b2')),
    ]);

    expect(proposals).toEqual([]);
  });

  it('stops at an unclassified tile and says which one', () => {
    // Walking through untagged track finds wrong things confidently. Stopping
    // silently looks identical to "there is no connection" — the note is the
    // difference, and it says classifying one cell unlocks the proposal.
    const { proposals, notes } = propose([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, {}),
      tile(2, 0, inBlock('b2')),
    ]);

    expect(proposals).toEqual([]);
    expect(notes).toContainEqual({ kind: 'blocked-by-unclassified', at: { x: 1, y: 0 } });
  });

  it('refuses to guess the conditions for a point with no leg mapping', () => {
    // The walk knows it crossed a point but not which position selects which
    // road. `pointConditions` is the field whose errors are least visible, so
    // this is the one place guessing would be worst.
    const { proposals, notes } = propose([
      tile(0, 0, inBlock('b1')),
      { x: 1, y: 0, tileType: 'point-left', metadata: { ...decorative, pointId: 'p1' } },
      tile(2, 0, inBlock('b2')),
    ]);

    expect(proposals).toEqual([]);
    expect(notes).toContainEqual({
      kind: 'blocked-by-unmapped-point',
      at: { x: 1, y: 0 },
      pointId: 'p1',
    });
  });

  it('can never propose an edge into a buffered end, structurally', () => {
    // A siding reached through a feeder, buffered at its far end. The connection
    // at the near end is real and is proposed; the buffered end has no port for
    // a walk to arrive at, so no proposal can name it however the drawing is
    // arranged. #91's geometry gives a terminating tile a terminus on its
    // *closed* side with no port, which is what makes this a guarantee rather
    // than a check that could be forgotten.
    // The buffer's stub faces west, into the run it terminates — the way a stop
    // block is actually drawn at the east end of a siding.
    const tiles = [
      tile(0, 0, inBlock('b1')),
      tile(1, 0, decorative),
      tile(2, 0, inBlock('b2')),
      tile(3, 0, inBlock('b2'), 'buffer'),
    ];

    const { proposals } = propose(tiles);

    const toB2 = proposals.filter((p) => p.toBlockId === 'b2');
    expect(toB2).toHaveLength(1);
    expect(toB2[0].fromBlockId).toBe('b1');

    // The buffered end is a real `block_ends` row, and nothing proposes against it.
    const terminated = generateBlockEnds(tiles).openings.filter((o) => o.terminated);

    expect(terminated.length).toBeGreaterThan(0);
    expect(terminated.every((o) => o.ports.length === 0)).toBe(true);

    // Compared as (block, label): an end label is only unique within its block,
    // and `east` on one block is a different place from `east` on another.
    const terminatedKeys = new Set(terminated.map((t) => `${t.blockId} ${t.label}`));
    expect(proposals.some((p) => terminatedKeys.has(`${p.toBlockId} ${p.toEnd}`))).toBe(false);
    expect(proposals.some((p) => terminatedKeys.has(`${p.fromBlockId} ${p.fromEnd}`))).toBe(false);
  });

  it('does not join two blocks that hang off the same decorative point’s diverging legs', () => {
    // Westgate Hollow's fiddle yard: P1's toe faces the layout, and its two
    // diverging legs carry Fiddle Yard 1 and Fiddle Yard 2. The two yards meet
    // only at the toe — there is no P1 setting that joins them. An early version
    // proposed exactly that, which as an authored edge is a route through a
    // point that does not physically exist.
    //
    // The point is decorative here, which is the case where the two yards are
    // genuinely not adjacent. Tinting it as one of them is a different question
    // and is #104's, below.
    const { proposals } = propose([
      tile(0, 0, inBlock('fy1')),
      pointTile(1, 0, 'p1', 'point-left', 'n', 180),
      tile(1, 1, inBlock('fy2'), 'straight-45'),
      tile(0, 1, inBlock('fy2')),
    ]);

    const pairs = proposals.map((p) => [p.fromBlockId, p.toBlockId].sort().join('-'));
    expect(pairs).not.toContain('fy1-fy2');
  });

  it('never mirrors an arrival into a departure the drawing refuses (#104)', () => {
    // The same fiddle yard with P1's tile tinted `fy1` — which is how a throat
    // is routinely drawn, and which used to delete edges wholesale.
    //
    // Both halves of #104 are asserted here, because either alone is a bug:
    //
    //   fy2 → fy1  is real. The tile *is* fy1, so a train that has reached it
    //              has arrived, and P1 reverse is what carries it there.
    //   fy1 → fy2  is not. A train in fy1 proper approaches through P1's west
    //              leg, which no road joins to the south one; authored as an
    //              edge it is a route that trails through blades set against it.
    //
    // Synthesising the reverse of every connection produced exactly that edge,
    // which is why `assemble` no longer does it.
    const { proposals, notes } = propose([
      tile(0, 0, inBlock('fy1')),
      // The point, tinted as fy1 and rotated so its toe faces east.
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
    ]);

    const inbound = proposals.filter((p) => p.fromBlockId === 'fy2' && p.toBlockId === 'fy1');
    expect(inbound).toHaveLength(1);
    expect(inbound[0].pointConditions).toEqual([{ pointId: 'p1', requiredPosition: 'reverse' }]);

    expect(proposals.some((p) => p.fromBlockId === 'fy1' && p.toBlockId === 'fy2')).toBe(false);

    // The one-way-ness is stated, not left as an absence: the direction that is
    // missing is missing because fy1 has no road out through that boundary.
    expect(notes).toContainEqual({
      kind: 'no-road-out-of-block',
      at: { x: 1, y: 0 },
      blockId: 'fy1',
      edge: 's',
    });
  });

  it('reports a drawn leg the point’s mapping does not cover', () => {
    // An incomplete mapping, not an absent one — so neither
    // `blocked-by-unmapped-point` (there is a mapping) nor silence (the track is
    // drawn and goes somewhere). Guessing which position selects a leg nobody
    // mapped is the one guess this walk must never make.
    const { proposals, notes } = propose([
      tile(0, 0, inBlock('b1')),
      {
        x: 1,
        y: 0,
        tileType: 'point-right',
        metadata: {
          ...decorative,
          pointId: 'p1',
          // The tile draws a south leg; no road uses it.
          pointRoads: [{ when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'e'] }],
        },
      },
      tile(2, 0, inBlock('b2')),
      tile(1, 1, inBlock('b3'), 'straight-v'),
    ]);

    // The mapped road still works.
    expect(proposals.some((p) => p.fromBlockId === 'b1' && p.toBlockId === 'b2')).toBe(true);
    // The unmapped leg does not, and says so.
    expect(proposals.some((p) => [p.fromBlockId, p.toBlockId].includes('b3'))).toBe(false);
    expect(notes).toContainEqual({
      kind: 'leg-not-covered-by-road',
      at: { x: 1, y: 0 },
      edge: 's',
    });
  });

  it('never proposes past the first block it reaches', () => {
    // A—decorative—B—decorative—C proposes A↔B and B↔C and never A↔C. An edge
    // spanning an intermediate block would let a route plan straight through
    // occupancy it never reserved.
    const { proposals } = propose([
      tile(0, 0, inBlock('a')),
      tile(1, 0, decorative),
      tile(2, 0, inBlock('b')),
      tile(3, 0, decorative),
      tile(4, 0, inBlock('c')),
    ]);

    const pairs = proposals.map((p) => [p.fromBlockId, p.toBlockId].sort().join('-'));
    expect(new Set(pairs)).toEqual(new Set(['a-b', 'b-c']));
  });
});

describe('proposeEdges — what it finds', () => {
  /** b1 — decorative point (P1) — b2 on the through road, b3 on the divergent one. */
  const throat = (): GeometryTile[] => [
    tile(0, 0, inBlock('b1')),
    tile(1, 0, inBlock('b1')),
    pointTile(2, 0, 'p1', 'point-right', 's'),
    tile(3, 0, inBlock('b2')),
    tile(2, 1, inBlock('b3'), 'straight-v'),
  ];

  it('proposes one connection per road, carrying that road’s point condition', () => {
    const { proposals } = propose(throat());

    const from = proposals.filter((p) => p.fromBlockId === 'b1');
    expect(from).toHaveLength(2);

    const toB2 = from.find((p) => p.toBlockId === 'b2')!;
    const toB3 = from.find((p) => p.toBlockId === 'b3')!;

    expect(toB2.pointConditions).toEqual([{ pointId: 'p1', requiredPosition: 'normal' }]);
    expect(toB3.pointConditions).toEqual([{ pointId: 'p1', requiredPosition: 'reverse' }]);
    expect(toB2.via).toEqual([{ x: 2, y: 0 }]);
  });

  it('offers both directions of every connection, paired and identical in conditions', () => {
    // Both directions come out of the **walk**, from each block's own opening —
    // nothing is mirrored (#104). Ordinary track is symmetric and yields the
    // pair for free, which is what makes a one-way proposal elsewhere a
    // statement about the drawing rather than a gap in the search.
    const { proposals } = propose(throat());

    for (const p of proposals) {
      const reverse = proposals.find(
        (r) => r.fromBlockId === p.toBlockId && r.toBlockId === p.fromBlockId,
      );
      expect(reverse, `no reverse for ${p.fromBlockId}->${p.toBlockId}`).toBeDefined();
      expect(reverse!.pairId).toBe(p.pairId);
      expect(reverse!.pointConditions).toEqual(p.pointConditions);
    }
  });

  it('never supplies a length, on any path', () => {
    // Tile count bears no relation to physical extent. Asserted over every
    // proposal rather than one, so a future field cannot slip past a single case.
    for (const p of propose(throat()).proposals) {
      expect(p.lengthMm).toBeNull();
    }
  });

  it('honours rotation, because roads are stored unrotated', () => {
    // The same throat turned 90°: b1 above, b2 below, b3 to the west. If the
    // rotation were ignored the walk would find nothing at all.
    const { proposals } = propose([
      tile(0, 0, { blockId: 'b1', rotation: 90 }),
      tile(0, 1, { blockId: 'b1', rotation: 90 }),
      pointTile(0, 2, 'p1', 'point-right', 's', 90),
      tile(0, 3, { blockId: 'b2', rotation: 90 }),
      tile(-1, 2, inBlock('b3')),
    ]);

    const from = proposals.filter((p) => p.fromBlockId === 'b1');
    expect(from.map((p) => p.toBlockId).sort()).toEqual(['b2', 'b3']);
  });

  it('keeps a diamond’s two roads apart, and flags the blind spot', () => {
    // Entering a plain diamond from the west arrives opposite, never on the
    // crossing road. The proposal still carries the #26 warning, because the
    // edge it would author sits in a blind spot the safety model cannot see.
    const { proposals } = propose([
      tile(0, 0, inBlock('b1')),
      tile(1, 0, decorative, 'crossing'),
      tile(2, 0, inBlock('b2')),
      tile(1, -1, inBlock('b3'), 'straight-v'),
      tile(1, 1, inBlock('b4'), 'straight-v'),
    ]);

    const fromB1 = proposals.filter((p) => p.fromBlockId === 'b1');
    expect(fromB1.map((p) => p.toBlockId)).toEqual(['b2']);
    expect(fromB1[0].crossesDiamond).toBe(true);

    // The other road is its own connection and does not touch the first.
    const fromB3 = proposals.filter((p) => p.fromBlockId === 'b3');
    expect(fromB3.map((p) => p.toBlockId)).toEqual(['b4']);
  });

  it('charges the condition of a point the block’s own opening sits on', () => {
    // The throat tile is tagged to the block it serves, so the block's opening
    // is *on* the point. Leaving through the toe costs P1 normal, because the
    // west leg is the one inside b1 — an early version emitted no condition
    // here, which as an authored edge is usable with the point set against it.
    const { proposals } = propose([
      tile(0, 0, inBlock('b1')),
      {
        x: 1,
        y: 0,
        tileType: 'point-left',
        metadata: {
          blockId: 'b1',
          rotation: 180,
          pointId: 'p1',
          pointRoads: [
            { when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'e'] },
            { when: [{ pointId: 'p1', position: 'reverse' }], legs: ['w', 'n'] },
          ],
        },
      },
      tile(2, 0, decorative),
      tile(3, 0, inBlock('b2')),
    ]);

    const out = proposals.filter((p) => p.fromBlockId === 'b1' && p.toBlockId === 'b2');
    expect(out).toHaveLength(1);
    expect(out[0].pointConditions).toEqual([{ pointId: 'p1', requiredPosition: 'normal' }]);
  });

  it('accumulates the conditions of every point on the path', () => {
    // Two points in series: reaching the far siding needs both set, and that
    // falls out of merging each road's `when` with no special casing.
    const { proposals } = propose([
      tile(0, 0, inBlock('b1')),
      pointTile(1, 0, 'p1', 'point-right', 's'),
      pointTile(2, 0, 'p2', 'point-right', 's'),
      tile(3, 0, inBlock('b2')),
      tile(2, 1, inBlock('b3'), 'straight-v'),
    ]);

    const toB2 = proposals.find((p) => p.fromBlockId === 'b1' && p.toBlockId === 'b2')!;
    expect(toB2.pointConditions).toEqual([
      { pointId: 'p1', requiredPosition: 'normal' },
      { pointId: 'p2', requiredPosition: 'normal' },
    ]);

    const toB3 = proposals.find((p) => p.fromBlockId === 'b1' && p.toBlockId === 'b3')!;
    expect(toB3.pointConditions).toEqual([
      { pointId: 'p1', requiredPosition: 'normal' },
      { pointId: 'p2', requiredPosition: 'reverse' },
    ]);
  });

  it('refuses a run whose drawing produces more candidates than a person can review', () => {
    // Admission control in the spirit of MAX_EDGES_PER_LAYOUT. A wall of
    // candidates is not a reviewable list, so the honest answer is to refuse.
    const tiles: GeometryTile[] = [];
    for (let i = 0; i < 120; i++) {
      tiles.push(tile(0, i * 2, inBlock(`a${i}`)));
      tiles.push(tile(1, i * 2, decorative));
      tiles.push(tile(2, i * 2, inBlock(`b${i}`)));
    }

    expect(() => propose(tiles)).toThrow(ProposalLimitExceededError);
  });
});

describe('reconcileProposals', () => {
  const base = {
    pairId: 'pair',
    fromBlockId: 'b1',
    fromEnd: 'east' as string | null,
    toBlockId: 'b2',
    toEnd: 'west' as string | null,
    pointConditions: [],
    lengthMm: null as null,
    via: [],
    crossesDiamond: false,
    status: 'new' as const,
  };

  const ends: BlockEnd[] = [
    { id: 'e1', layoutId: 'l1', blockId: 'b1', label: 'east', pinned: false },
    { id: 'e2', layoutId: 'l1', blockId: 'b2', label: 'west', pinned: false },
  ];

  const edge = (over: Partial<BlockEdge> = {}): BlockEdge => ({
    id: 'edge-1',
    layoutId: 'l1',
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [],
    lengthMm: null,
    ...over,
  });

  it('reports a connection the graph already has, rather than hiding it', () => {
    // Silence is indistinguishable from "not found". "The graph agrees with the
    // drawing" is the most valuable thing this surface can say about a layout
    // that is partly authored.
    const [out] = reconcileProposals([base], [edge()], ends);
    expect(out).toMatchObject({ status: 'existing', existingEdgeId: 'edge-1' });
  });

  it('flags a connection the graph has with different point conditions', () => {
    const [out] = reconcileProposals(
      [{ ...base, pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }] }],
      [edge()],
      ends,
    );
    expect(out).toMatchObject({ status: 'conflicting', existingEdgeId: 'edge-1' });
  });

  it('does not care about the order conditions are written in', () => {
    const [out] = reconcileProposals(
      [
        {
          ...base,
          pointConditions: [
            { pointId: 'p2', requiredPosition: 'normal' },
            { pointId: 'p1', requiredPosition: 'reverse' },
          ],
        },
      ],
      [
        edge({
          pointConditions: [
            { pointId: 'p1', requiredPosition: 'reverse' },
            { pointId: 'p2', requiredPosition: 'normal' },
          ],
        }),
      ],
      ends,
    );
    expect(out.status).toBe('existing');
  });

  it('never compares length', () => {
    // An authored measurement against a proposal's `null` is not a
    // disagreement — it is something the drawing could never have supplied.
    const [out] = reconcileProposals([base], [edge({ lengthMm: 1200 })], ends);
    expect(out.status).toBe('existing');
  });

  it('keys on the whole connection, not on (fromBlockId, fromEnd)', () => {
    // That pair is deliberately not unique: one opening fans out to several
    // blocks through a point. Keying on it collapses every fan-out into a false
    // conflict, which would make the feature useless at exactly the throats it
    // exists for.
    const out = reconcileProposals(
      [base, { ...base, toBlockId: 'b3', toEnd: 'north' }],
      [edge()],
      [...ends, { id: 'e3', layoutId: 'l1', blockId: 'b3', label: 'north', pinned: false }],
    );

    expect(out.map((p) => p.status)).toEqual(['existing', 'new']);
  });

  it('clears an end label no block_ends row carries, and says so', () => {
    // It must never invent a name, and must not read as `new` — accepting it
    // would author an edge referencing an end that does not exist.
    const [out] = reconcileProposals([base], [edge()], [ends[0]]);
    expect(out).toMatchObject({ status: 'needs-end-label', toEnd: null, fromEnd: 'east' });
    expect(out.existingEdgeId).toBeUndefined();
  });
});
