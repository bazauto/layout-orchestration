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

import {
  GridTileMetadata,
  SensorObservationView,
  TileAnnotation,
  TileEdge,
  TileType,
  classifyTile,
} from '../types';
import { DiagnosticNames } from './diagnostics';
import { sensorGlyphStateOf, SENSOR_OBSERVATION } from './encoding';

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

/**
 * A compiled opening (#103) touching this cell — the announceable half of the
 * boundary marks and labels the canvas draws.
 *
 * This replaced `CursorEnd`, which described a `block_ends` row, when those
 * controls were removed (#103 PR 6.2). The swap is not cosmetic: an end was a
 * stored name that might or might not still match the drawing, and an opening
 * *is* the drawing. There is no `pinned`, because a compiled label is never
 * authored — it is regenerated on every compile and referenced by nothing (D8).
 *
 * `edges` is what keeps the readout level with what is drawn. Step 6.1 moved
 * the visual from a word at a nearby cell to a tick at the boundary the opening
 * occupies, precisely because the word could sit plausibly beside the wrong
 * place (#91's fused siding). A readout that still said only "there is an
 * opening here" would hand a keyboard user the version of the diagram that was
 * wrong. **Empty means this cell carries the label and no boundary** — an
 * opening several cells wide has one label cell and several boundary cells.
 */
export interface CursorOpening {
  label: string;
  terminated: boolean;
  /** Boundaries of *this* cell the opening crosses; empty when the cell only carries the label. */
  edges: TileEdge[];
}

/** What sits at the cursor's cell, already resolved from the grid and its parsed metadata. */
export interface CursorTile {
  tileType: TileType;
  metadata: GridTileMetadata;
  openings: CursorOpening[];
}

/**
 * Builds the one sentence describing where the cursor is and what is on it,
 * e.g. `"Column 11, row 3. Point tile, Yard Throat, block Fiddle Yard 1."`
 *
 * `tile: null` is a real, announceable state — an empty cell — not the
 * absence of an announcement, so it still gets a sentence rather than
 * nothing.
 *
 * `sensorState` (#76) is optional and keyed like `LiveDiagramState.sensors` —
 * omitted by every caller today (the Track Editor draws no live state at
 * all, `docs/liveness.md` M2), so a sensor annotation still names itself and
 * nothing else. It exists so the same one-sentence-for-two-audiences
 * discipline this module holds extends to sensor state the moment a live
 * cursor readout wants it, rather than that surface inventing its own prose.
 */
export function describeCursor(
  cursor: { x: number; y: number },
  tile: CursorTile | null,
  names: DiagnosticNames,
  sensorState?: ReadonlyMap<string, SensorObservationView>,
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
    parts.push(describeAnnotations(tile.metadata.annotations, names, sensorState));
  }

  for (const opening of tile.openings) {
    parts.push(describeOpening(opening));
  }

  return `${where} ${parts.join(', ')}.`;
}

function describeAnnotations(
  annotations: TileAnnotation[],
  names: DiagnosticNames,
  sensorState?: ReadonlyMap<string, SensorObservationView>,
): string {
  return annotations
    .map((a) => {
      if (a.entityType !== 'sensor') return `${a.entityType} ${a.entityId}`;
      const name = names.sensors.get(a.entityId) ?? a.entityId;
      const observation = sensorState?.get(a.entityId);
      // #76: the state is a parenthetical on the same sentence, not a
      // separate announcement — matching how `<title>`/tooltip carries it on
      // the canvas (D-c: subordinate to, and never confused with, derived
      // block occupancy, which `classifyTile`'s block/decorative/not
      // classified split above already covers).
      if (!observation) return `sensor ${name}`;
      const label = SENSOR_OBSERVATION[sensorGlyphStateOf(observation)].label;
      return `sensor ${name} (${label})`;
    })
    .join(', ');
}

/** Spelled out, matching `describeDiagnostic` — `nw` mid-sentence reads as a typo rather than a direction. */
const EDGE_NAMES: Record<TileEdge, string> = {
  n: 'north',
  ne: 'north-east',
  e: 'east',
  se: 'south-east',
  s: 'south',
  sw: 'south-west',
  w: 'west',
  nw: 'north-west',
};

function describeOpening(opening: CursorOpening): string {
  const buffered = opening.terminated ? ', buffered' : '';

  // Two sentences for two different things the canvas draws, said apart on
  // purpose: a tick on a boundary is *where the railway leaves*, and a label is
  // only where the name happens to be written. Conflating them would announce
  // one opening identically at cells that are not the same place, which is the
  // failure mode step 6.1 removed from the visual.
  if (opening.edges.length === 0) {
    return `opening ${opening.label} labelled here${buffered}`;
  }

  const sides = opening.edges.map((e) => EDGE_NAMES[e]).join(' and ');
  const noun = opening.edges.length === 1 ? 'boundary' : 'boundaries';
  return `opening ${opening.label} at the ${sides} ${noun}${buffered}`;
}
