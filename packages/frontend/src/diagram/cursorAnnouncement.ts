/**
 * The single string behind the Track Editor's cursor readout (#94) — the
 * visible "where am I" line under the canvas *and* the `aria-live`
 * announcement a screen reader gets when the cursor moves. One
 * implementation, not two: keeping a separate prose string for each
 * audience is exactly how they drift apart, and the visible readout is the
 * only way a sighted keyboard user can tell the announcement is accurate.
 *
 * Pure and separate from the component for the same reason as
 * `diagram/diagnostics.ts` — testable without rendering an SVG, and this is
 * where the id-to-name resolution already lives (`DiagnosticNames`).
 */

import { GridTileMetadata, TileAnnotation, TileType, classifyTile } from '../types';
import { DiagnosticNames } from './diagnostics';

/**
 * Readable names for every tile type the editor can draw, including the
 * legacy `straight-v` / named-curve entries `TileType` keeps for
 * already-authored grids (#70) — the cursor can land on any of them.
 */
const TILE_TYPE_LABEL: Record<TileType, string> = {
  'straight-h': 'Straight tile',
  'straight-v': 'Straight tile',
  'straight-45': 'Corner tile',
  curve: 'Curve tile',
  'curve-ne': 'Curve tile',
  'curve-nw': 'Curve tile',
  'curve-se': 'Curve tile',
  'curve-sw': 'Curve tile',
  'point-left': 'Point tile',
  'point-right': 'Point tile',
  buffer: 'Buffer tile',
  platform: 'Platform tile',
  crossing: 'Crossing tile',
};

/** A block end whose geometry sits at this cell — mirrors the shape `GridEditor` already builds for drawing them (#72). */
export interface CursorEnd {
  label: string;
  pinned: boolean;
  terminated: boolean;
}

/** What sits at the cursor's cell, already resolved from the grid and its parsed metadata. */
export interface CursorTile {
  tileType: TileType;
  metadata: GridTileMetadata;
  ends: CursorEnd[];
}

/**
 * Builds the one sentence describing where the cursor is and what is on it,
 * e.g. `"Column 11, row 3. Point tile, Yard Throat, block Fiddle Yard 1."`
 *
 * `tile: null` is a real, announceable state — an empty cell — not the
 * absence of an announcement, so it still gets a sentence rather than
 * nothing.
 */
export function describeCursor(
  cursor: { x: number; y: number },
  tile: CursorTile | null,
  names: DiagnosticNames,
): string {
  const where = `Column ${cursor.x}, row ${cursor.y}.`;
  if (!tile) return `${where} Empty.`;

  const parts: string[] = [TILE_TYPE_LABEL[tile.tileType]];

  if (tile.metadata.pointId) {
    parts.push(names.points.get(tile.metadata.pointId) ?? tile.metadata.pointId);
  }

  // Mirrors `classifyTile`'s three-way split (#71): a block, a deliberate
  // decorative marking, or genuinely not tagged yet. All three are worth
  // saying — silence here would read as "nothing to report" rather than
  // "not classified", which is the exact ambiguity #71 exists to remove.
  const classification = classifyTile(tile.metadata);
  if (classification === 'block' && tile.metadata.blockId) {
    parts.push(`block ${names.blocks.get(tile.metadata.blockId) ?? tile.metadata.blockId}`);
  } else if (classification === 'decorative') {
    parts.push('decorative');
  } else {
    parts.push('not classified');
  }

  if (tile.metadata.annotations?.length) {
    parts.push(describeAnnotations(tile.metadata.annotations, names));
  }

  for (const end of tile.ends) {
    parts.push(describeEnd(end));
  }

  return `${where} ${parts.join(', ')}.`;
}

function describeAnnotations(annotations: TileAnnotation[], names: DiagnosticNames): string {
  return annotations
    .map((a) =>
      a.entityType === 'sensor'
        ? `sensor ${names.sensors.get(a.entityId) ?? a.entityId}`
        : `${a.entityType} ${a.entityId}`,
    )
    .join(', ');
}

function describeEnd(end: CursorEnd): string {
  // Bracketed/plain mirrors exactly how the end label is drawn on the
  // canvas (#72) — the readout must not imply a distinction the diagram
  // does not also show, or say nothing about one it does.
  const label = end.pinned ? `[${end.label}]` : end.label;
  return `end ${label}${end.terminated ? ' (buffer)' : ''}`;
}
