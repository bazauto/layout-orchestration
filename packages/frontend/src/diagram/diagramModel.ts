/**
 * diagramModel — the pieces every renderer of the grid derives from (tiles,
 * openings), pulled out of `GridEditor.tsx` by #75: parsed tile metadata,
 * block runs and their tints, where a point's name is drawn, and the
 * per-cell view of the compiled openings.
 *
 * Pure functions plus a thin memoising hook. Exactly what the control view
 * (#63/#82) also needs — none of it reads live state, and `useDiagramModel`
 * takes nothing but the drawing.
 */

import { useMemo } from 'react';
import { CompiledOpening, GridTileMetadata, GridTileRecord, TileEdge } from '../types';
import { assignRunTints, BlockRun, findBlockRuns } from './blockRuns';
import { BLOCK_TINTS } from './encoding';
import { pointLabelAnchors } from './pointLabels';
import { CursorOpening } from './cursorAnnouncement';

/**
 * The canvas the editor draws when the grid is empty. **Not a limit** — the
 * drawn extent grows with the content (`computeExtent`), which is what #69
 * asked for in preference to a bigger constant. Westgate Hollow already
 * reached column 29 of the old fixed 30, and raising the number would only
 * have moved the wall.
 */
const MIN_COLS = 30;
const MIN_ROWS = 20;

/** Blank columns/rows kept beyond the furthest tile, so there is always room to draw on. */
const GROWTH_MARGIN = 6;

/**
 * Hard upper bound on a coordinate.
 *
 * Admission control against a fat finger or a stray script creating a tile
 * nothing can ever scroll to — not a canvas size. It deliberately matches the
 * bound the backend validates against (`MAX_TILE_COORDINATE`, #70); if that
 * one changes, change this with it. A layout ~1000 tiles across is already far
 * beyond anything a physical railway needs.
 */
export const MAX_COORDINATE = 999;

export interface DiagramExtent {
  cols: number;
  rows: number;
}

/**
 * The drawn canvas: big enough for the content plus room to keep drawing.
 *
 * Derived rather than fixed (#69). The old constants silently dropped any
 * paint beyond column 30 / row 20, with no indication that painting further
 * right simply did nothing — and Westgate Hollow was already at column 29.
 * Growing with the content removes the ceiling rather than moving it.
 */
export function computeExtent(grid: ReadonlyMap<string, GridTileRecord>): DiagramExtent {
  let cols = MIN_COLS;
  let rows = MIN_ROWS;
  for (const t of grid.values()) {
    cols = Math.max(cols, t.x + 1 + GROWTH_MARGIN);
    rows = Math.max(rows, t.y + 1 + GROWTH_MARGIN);
  }
  return {
    cols: Math.min(cols, MAX_COORDINATE + 1),
    rows: Math.min(rows, MAX_COORDINATE + 1),
  };
}

/**
 * Every tile's metadata, parsed once per grid change rather than per tile per
 * render — the render loop used to `JSON.parse` on every frame, and the run
 * detection, the write path and the diagnostics overlay all want the same
 * parse.
 *
 * Tolerant, like the backend's own read path: a blob that will not parse
 * reads as `{}` so the tile still draws. Refusing to open the editor over a
 * legacy cell would take away the only tool that can fix it. The backend
 * reports those cells as `tile-metadata-unreadable` so they are visible
 * rather than merely survived.
 */
export function parseTileMetadata(
  grid: ReadonlyMap<string, GridTileRecord>,
): Map<string, GridTileMetadata> {
  const out = new Map<string, GridTileMetadata>();
  for (const tile of grid.values()) {
    try {
      out.set(`${tile.x},${tile.y}`, JSON.parse(tile.metadata) as GridTileMetadata);
    } catch {
      out.set(`${tile.x},${tile.y}`, {});
    }
  }
  return out;
}

/** Block runs, and the tint assigned to each, from the parsed metadata's `blockId`s. */
export function computeBlockRuns(
  grid: ReadonlyMap<string, GridTileRecord>,
  parsedMeta: ReadonlyMap<string, GridTileMetadata>,
): { runs: BlockRun[]; tintOf: Map<string, number> } {
  const runs = findBlockRuns(
    Array.from(grid.values()).map((t) => ({
      x: t.x,
      y: t.y,
      blockId: parsedMeta.get(`${t.x},${t.y}`)?.blockId,
    })),
  );
  const tintOf = assignRunTints(runs, BLOCK_TINTS.length);
  return { runs, tintOf };
}

/**
 * The one tile per point that carries its name (#93).
 *
 * A point is drawn as two tiles — the point tile and the `straight-45`
 * companion carrying the divergent road to the next row — and both are tagged
 * with the same `pointId`, so labelling per tile drew every name twice.
 */
export function computePointLabelAt(
  grid: ReadonlyMap<string, GridTileRecord>,
  parsedMeta: ReadonlyMap<string, GridTileMetadata>,
): Map<string, string> {
  return pointLabelAnchors(
    Array.from(grid.values()).flatMap((t) => {
      const pointId = parsedMeta.get(`${t.x},${t.y}`)?.pointId;
      return pointId ? [{ x: t.x, y: t.y, tileType: t.tileType, pointId }] : [];
    }),
  );
}

/**
 * Every compiled opening touching a cell, in the shape a readout wants: the
 * boundaries it crosses *here*, and separately the cell that carries its
 * label.
 *
 * Two maps rather than one because they answer different questions — a
 * multi-cell opening has one label cell and several boundary cells — and this
 * is the join between them. It exists so a keyboard user hears what a sighted
 * user sees: step 6.1 made the boundary tick the primary mark, and a readout
 * that only knew about the label cell would be the old, weaker diagram.
 */
export function computeOpeningsAtCursor(
  openings: readonly CompiledOpening[],
): Map<string, CursorOpening[]> {
  const out = new Map<string, CursorOpening[]>();

  const push = (k: string, entry: CursorOpening) => {
    const list = out.get(k);
    if (list) list.push(entry);
    else out.set(k, [entry]);
  };

  for (const o of openings) {
    const byCell = new Map<string, TileEdge[]>();
    for (const port of o.ports) {
      const k = `${port.x},${port.y}`;
      const edges = byCell.get(k);
      if (edges) edges.push(port.edge);
      else byCell.set(k, [port.edge]);
    }
    for (const [k, edges] of byCell) {
      push(k, { label: o.label, terminated: o.terminated, edges });
    }
    // The label cell, unless it is already one of the boundary cells above —
    // saying "at the north boundary" and "labelled here" about one opening at
    // one cell is two sentences for one fact.
    const labelKey = `${o.at.x},${o.at.y}`;
    if (!byCell.has(labelKey)) {
      push(labelKey, { label: o.label, terminated: o.terminated, edges: [] });
    }
  }

  return out;
}

/** The full derived model — what every renderer of the grid needs. */
export interface DiagramModel {
  parsedMeta: Map<string, GridTileMetadata>;
  runs: BlockRun[];
  tintOf: Map<string, number>;
  pointLabelAt: Map<string, string>;
  /**
   * Openings survive here for the **keyboard readout only**. Nothing draws
   * them on the canvas any more — the ticks, the `⊣` and the label all went
   * (`docs/track-editor.md` D15) — so this is the one remaining consumer, and
   * `openings` stays an input to the model purely to feed it.
   */
  openingsAtCursor: Map<string, CursorOpening[]>;
  extent: DiagramExtent;
}

/**
 * Memoises the model above against `(grid, openings)` — the same two inputs
 * the editor already recomputes on every stroke end, and what the control view
 * will read from a snapshot instead. No live state: this is geometry, not
 * occupancy, and stays that way (see `TrackDiagram`'s extension-point note).
 */
export function useDiagramModel(
  grid: ReadonlyMap<string, GridTileRecord>,
  openings: readonly CompiledOpening[],
): DiagramModel {
  const parsedMeta = useMemo(() => parseTileMetadata(grid), [grid]);
  const { runs, tintOf } = useMemo(() => computeBlockRuns(grid, parsedMeta), [grid, parsedMeta]);
  const pointLabelAt = useMemo(() => computePointLabelAt(grid, parsedMeta), [grid, parsedMeta]);
  const openingsAtCursor = useMemo(() => computeOpeningsAtCursor(openings), [openings]);
  const extent = useMemo(() => computeExtent(grid), [grid]);

  return { parsedMeta, runs, tintOf, pointLabelAt, openingsAtCursor, extent };
}
