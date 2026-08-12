/**
 * `services/tileGeometry` — the per-tile track model (#91).
 *
 * This table is the thing #91's fix rests on: it is what lets "these two cells
 * touch" be distinguished from "these two cells are joined". Every row is
 * asserted literally, because the table's only correctness condition is that it
 * matches what `TilePath` draws, and nothing can check that automatically.
 */

import { describe, expect, it } from 'vitest';
import {
  EDGE_OFFSET,
  TILE_DRAWN_EDGES,
  TILE_LEGS,
  drawnEdges,
  oppositeEdge,
  rotateEdge,
  terminatesTrack,
  tileLegs,
} from '../../../src/services/tileGeometry';
import { TILE_EDGES, TILE_TYPES, TileEdge } from '../../../src/domain/types';

const sorted = (edges: Iterable<TileEdge>) => [...edges].sort();

describe('the table covers the palette', () => {
  it('has a row for every tile type', () => {
    // Iterating the constant is what catches the next palette addition: a new
    // tile type with no row draws nothing, so it would silently sever the track
    // it was drawn to join.
    for (const type of TILE_TYPES) {
      expect(TILE_LEGS[type], `no legs row for ${type}`).toBeDefined();
      expect(TILE_DRAWN_EDGES[type], `no drawn-edge row for ${type}`).toBeDefined();
    }
  });

  it('derives the drawn edges from the legs, so the two cannot drift', () => {
    for (const type of TILE_TYPES) {
      for (const leg of TILE_LEGS[type]) {
        for (const edge of leg) {
          expect(TILE_DRAWN_EDGES[type], `${type} leg ${edge} missing from edges`).toContain(edge);
        }
      }
    }
  });
});

describe('TILE_LEGS', () => {
  it('joins the two ends of each straight', () => {
    expect(TILE_LEGS['straight-h']).toEqual([['w', 'e']]);
    expect(TILE_LEGS['straight-v']).toEqual([['n', 's']]);
    expect(TILE_LEGS.platform).toEqual([['w', 'e']]);
  });

  it('joins two orthogonal edge midpoints for the 45° corner, not the tile corners', () => {
    // `TilePath` draws `straight-45` as (0,H)→(H,0) — the palette calls it
    // "Corner". Reading it as a `nw`–`se` diagonal would connect it to the wrong
    // two cells and is the easiest mistake to make from the name alone.
    expect(TILE_LEGS['straight-45']).toEqual([['w', 'n']]);
  });

  it('gives every curve its two drawn ends', () => {
    expect(TILE_LEGS.curve).toEqual([['w', 's']]);
    expect(TILE_LEGS['curve-ne']).toEqual([['s', 'e']]);
    // Same pair as `curve`, drawn the other way round. Both are legacy names
    // that must keep round-tripping (docs/track-grid.md D2).
    expect(TILE_LEGS['curve-nw']).toEqual([['s', 'w']]);
    expect(TILE_LEGS['curve-se']).toEqual([['n', 'e']]);
    expect(TILE_LEGS['curve-sw']).toEqual([['n', 'w']]);
  });

  it('gives a point a through road and a divergent one', () => {
    // Must stay equal to `DRAWN_LEGS` in the frontend's diagram/pointRoads.ts,
    // which is what a point's authored road mapping is expressed against.
    expect(TILE_LEGS['point-left']).toEqual([
      ['w', 'e'],
      ['w', 'n'],
    ]);
    expect(TILE_LEGS['point-right']).toEqual([
      ['w', 'e'],
      ['w', 's'],
    ]);
  });

  it('keeps a crossing’s two roads apart', () => {
    // The whole reason legs are the primitive. As a bare four-edge set a plain
    // diamond would read as a junction where any road reaches any other, which
    // is a worse version of the blind spot #26 already records.
    expect(TILE_LEGS.crossing).toEqual([
      ['w', 'e'],
      ['n', 's'],
    ]);
  });

  it('gives a buffer no leg at all, because nothing passes through it', () => {
    expect(TILE_LEGS.buffer).toEqual([]);
    // It still touches its west edge — it joins the track it is drawn against.
    expect(TILE_DRAWN_EDGES.buffer).toEqual(['w']);
  });
});

describe('EDGE_OFFSET', () => {
  it('puts north at the top of the diagram', () => {
    // Screen convention, not mathematical. Inverting it would name every
    // generated end its own opposite.
    expect(EDGE_OFFSET.n).toEqual({ dx: 0, dy: -1 });
    expect(EDGE_OFFSET.s).toEqual({ dx: 0, dy: 1 });
    expect(EDGE_OFFSET.e).toEqual({ dx: 1, dy: 0 });
    expect(EDGE_OFFSET.w).toEqual({ dx: -1, dy: 0 });
    expect(EDGE_OFFSET.ne).toEqual({ dx: 1, dy: -1 });
    expect(EDGE_OFFSET.sw).toEqual({ dx: -1, dy: 1 });
  });
});

describe('oppositeEdge', () => {
  it('faces back across the shared boundary', () => {
    expect(oppositeEdge('n')).toBe('s');
    expect(oppositeEdge('e')).toBe('w');
    expect(oppositeEdge('ne')).toBe('sw');
    expect(oppositeEdge('nw')).toBe('se');
  });

  it('is its own inverse for every edge', () => {
    for (const edge of TILE_EDGES) {
      expect(oppositeEdge(oppositeEdge(edge))).toBe(edge);
    }
  });
});

describe('rotateEdge', () => {
  it('turns clockwise, matching the SVG the editor draws', () => {
    expect(rotateEdge('n', 90)).toBe('e');
    expect(rotateEdge('w', 180)).toBe('e');
    expect(rotateEdge('n', 45)).toBe('ne');
    // Three quarter-turns clockwise: w → n → e → s.
    expect(rotateEdge('w', 270)).toBe('s');
  });

  it('wraps all the way round to the identity', () => {
    for (const edge of TILE_EDGES) {
      expect(rotateEdge(edge, 315)).toBe(rotateEdge(rotateEdge(edge, 270), 45));
    }
  });

  it('is the identity at zero and when rotation is absent', () => {
    expect(rotateEdge('e', 0)).toBe('e');
    expect(rotateEdge('e')).toBe('e');
  });
});

describe('drawnEdges', () => {
  it('applies the tile’s rotation', () => {
    expect(sorted(drawnEdges('straight-h', { rotation: 90 }))).toEqual(['n', 's']);
    expect(sorted(drawnEdges('straight-45', { rotation: 90 }))).toEqual(['e', 'n']);
    expect(sorted(drawnEdges('buffer', { rotation: 180 }))).toEqual(['e']);
  });

  it('produces diagonal edges from a 45° rotation', () => {
    // No type touches a diagonal unrotated, but a 45° turn produces them and
    // all eight edges must behave identically from there on.
    expect(sorted(drawnEdges('straight-h', { rotation: 45 }))).toEqual(['nw', 'se']);
  });

  it('treats absent metadata as unrotated', () => {
    expect(sorted(drawnEdges('straight-h'))).toEqual(['e', 'w']);
    expect(sorted(drawnEdges('straight-h', {}))).toEqual(['e', 'w']);
  });

  it('gives an unrecognised tile type no edges, and does not throw', () => {
    // A legacy value the closed enum does not know. It draws nothing, so it
    // joins nothing and leaves its neighbours' ends open — visible, rather than
    // silently absorbing them.
    expect(drawnEdges('not-a-real-tile').size).toBe(0);
    expect(tileLegs('not-a-real-tile')).toEqual([]);
  });
});

describe('tileLegs', () => {
  it('rotates both ends of every leg', () => {
    expect(tileLegs('point-left', { rotation: 180 })).toEqual([
      ['e', 'w'],
      ['e', 's'],
    ]);
  });

  it('keeps a crossing’s roads separate through a rotation', () => {
    expect(tileLegs('crossing', { rotation: 90 })).toEqual([
      ['n', 's'],
      ['e', 'w'],
    ]);
  });
});

describe('terminatesTrack', () => {
  it('is true only for a buffer', () => {
    expect(terminatesTrack('buffer')).toBe(true);
    expect(terminatesTrack('platform')).toBe(false);
    expect(terminatesTrack('crossing')).toBe(false);
    expect(terminatesTrack('not-a-real-tile')).toBe(false);
  });
});
