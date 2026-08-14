/**
 * `diagramModel` (#75) — the pure functions two renderers (the editor today,
 * a monitor view later) both derive from `(tiles, openings)`.
 *
 * These had no direct coverage while they lived inline in `GridEditor.tsx`,
 * exercised only indirectly through the e2e specs. Now that a second
 * consumer is coming, wrong output here is wrong for both of them.
 */

import { describe, expect, it } from 'vitest';
import { CompiledOpening, GridTileRecord } from '../types';
import {
  MAX_COORDINATE,
  computeBlockRuns,
  computeExtent,
  computeOpeningsAtCell,
  computeOpeningsAtCursor,
  computePointLabelAt,
  computePortsAtCell,
  parseTileMetadata,
} from './diagramModel';

function tile(x: number, y: number, metadata: Record<string, unknown> = {}, tileType = 'straight-h'): GridTileRecord {
  return { id: `t-${x}-${y}`, layoutId: 'layout-1', x, y, tileType: tileType as GridTileRecord['tileType'], metadata: JSON.stringify(metadata) };
}

function grid(...tiles: GridTileRecord[]): Map<string, GridTileRecord> {
  return new Map(tiles.map((t) => [`${t.x},${t.y}`, t]));
}

describe('parseTileMetadata', () => {
  it('parses each tile once, keyed by coordinate', () => {
    const g = grid(tile(1, 2, { blockId: 'b1' }), tile(3, 4, { rotation: 90 }));
    const out = parseTileMetadata(g);
    expect(out.get('1,2')).toEqual({ blockId: 'b1' });
    expect(out.get('3,4')).toEqual({ rotation: 90 });
  });

  // docs/track-grid.md D10 / CLAUDE.md "Traps" — a tile decides nothing, so a
  // blob that fails to parse must not throw. Refusing to open the editor over
  // one legacy cell would remove the only tool that can fix it.
  it('reads an unparsable metadata blob as {} rather than throwing', () => {
    const bad: GridTileRecord = { id: 't-bad', layoutId: 'layout-1', x: 0, y: 0, tileType: 'straight-h', metadata: 'not json' };
    const out = parseTileMetadata(grid(bad));
    expect(out.get('0,0')).toEqual({});
  });
});

describe('computeExtent', () => {
  it('holds the empty-grid minimum', () => {
    const extent = computeExtent(grid());
    expect(extent).toEqual({ cols: 30, rows: 20 });
  });

  it('grows with the furthest tile plus the growth margin', () => {
    const extent = computeExtent(grid(tile(40, 5)));
    expect(extent.cols).toBe(40 + 1 + 6);
    expect(extent.rows).toBe(20); // unaffected axis stays at the minimum
  });

  it('caps at MAX_COORDINATE + 1 regardless of how far a tile sits', () => {
    const extent = computeExtent(grid(tile(MAX_COORDINATE, MAX_COORDINATE)));
    expect(extent.cols).toBe(MAX_COORDINATE + 1);
    expect(extent.rows).toBe(MAX_COORDINATE + 1);
  });
});

describe('computeBlockRuns', () => {
  it('groups tiles sharing a blockId into one run with one tint', () => {
    const g = grid(
      tile(0, 0, { blockId: 'b1' }),
      tile(1, 0, { blockId: 'b1' }),
      tile(5, 5, { blockId: 'b2' }),
    );
    const parsed = parseTileMetadata(g);
    const { runs, tintOf } = computeBlockRuns(g, parsed);

    expect(runs).toHaveLength(2);
    expect(tintOf.size).toBe(2);
    expect(tintOf.get('b1')).toBeDefined();
    expect(tintOf.get('b2')).toBeDefined();
  });
});

describe('computePointLabelAt', () => {
  it('anchors a point label at the point tile over its straight-45 companion', () => {
    const g = grid(
      tile(0, 0, { pointId: 'p1' }, 'point-left'),
      tile(0, -1, { pointId: 'p1' }, 'straight-45'),
    );
    const parsed = parseTileMetadata(g);
    const anchors = computePointLabelAt(g, parsed);

    expect(anchors.get('0,0')).toBe('p1');
    expect(anchors.has('0,-1')).toBe(false);
  });
});

function opening(over: Partial<CompiledOpening>): CompiledOpening {
  return {
    blockId: 'b1',
    label: 'north-1',
    at: { x: 0, y: 0 },
    terminated: false,
    ports: [{ x: 0, y: 0, edge: 'n' }],
    ...over,
  };
}

describe('computePortsAtCell', () => {
  it('keys every port by the cell its boundary sits on, not the label cell', () => {
    const o = opening({ at: { x: 0, y: 0 }, ports: [{ x: 1, y: 0, edge: 'w' }] });
    const out = computePortsAtCell([o]);

    expect(out.get('1,0')).toEqual([{ edge: 'w', label: 'north-1' }]);
    expect(out.has('0,0')).toBe(false);
  });
});

describe('computeOpeningsAtCell', () => {
  it('keys an opening by its label cell (opening.at)', () => {
    const o = opening({ at: { x: 2, y: 3 } });
    const out = computeOpeningsAtCell([o]);
    expect(out.get('2,3')).toEqual([o]);
  });
});

describe('computeOpeningsAtCursor', () => {
  it('separates the boundary cells from the label cell when they differ', () => {
    const o = opening({
      at: { x: 0, y: 0 },
      ports: [{ x: 1, y: 0, edge: 'w' }],
      label: 'east-1',
      terminated: true,
    });
    const out = computeOpeningsAtCursor([o]);

    expect(out.get('1,0')).toEqual([{ label: 'east-1', terminated: true, edges: ['w'] }]);
    expect(out.get('0,0')).toEqual([{ label: 'east-1', terminated: true, edges: [] }]);
  });

  it('does not duplicate the label sentence when the label cell is also a boundary cell', () => {
    const o = opening({ at: { x: 0, y: 0 }, ports: [{ x: 0, y: 0, edge: 'n' }], label: 'north-1' });
    const out = computeOpeningsAtCursor([o]);

    expect(out.get('0,0')).toEqual([{ label: 'north-1', terminated: false, edges: ['n'] }]);
  });
});
