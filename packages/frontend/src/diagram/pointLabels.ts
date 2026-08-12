/**
 * Where a point's name is drawn on the diagram, and what of it is drawn (#93).
 *
 * ## Why a point needs choosing a tile at all
 *
 * A point is usually **two** tiles: the `point-left`/`point-right` tile that
 * draws the through and divergent roads, and a `straight-45` companion carrying
 * the divergent road across to the adjacent row. Both are tagged with the same
 * `pointId`, because both depict part of that point — which is correct, and is
 * also why drawing the name per *tile* rendered it twice, once directly beneath
 * itself.
 *
 * So the name is drawn once per **point**, at one chosen tile. The point tile
 * wins over its companion: it is where the roads and their `N`/`R` letters
 * already are, so the name lands with the rest of the point's annotation rather
 * than on a plain diagonal some distance away.
 *
 * ## Why the name is abbreviated
 *
 * A tile is 40px. `P1 - Fiddle Yard` at the label's font size is about 67px, so
 * every point name overflowed its cell by most of a tile in each direction —
 * enough that `P5 - Goods Shed` and `P6 - Engine Shed`, one cell apart, rendered
 * as a single unreadable run of text.
 *
 * The convention the layout already uses is `P1 - Fiddle Yard`: an identifier,
 * then what it serves. That first part is the operator-facing name of the point
 * in every other context — a lever number on a real diagram — so it is what the
 * diagram draws, and the full name goes in a `<title>` where hover and assistive
 * technology both reach it. Nothing is hidden; it is moved to where there is
 * room for it.
 */

import { TileType } from '../types';
import { isPointTile } from './pointRoads';

/**
 * How much of a point name fits a tile before it starts colliding with its
 * neighbours. Roughly one cell's width at the label's font size, and the reason
 * a bare truncation still beats overflowing: an abbreviated label is ambiguous
 * only until you hover it, an overlapping one is unreadable for both points.
 */
export const MAX_POINT_LABEL_CHARS = 8;

/** The separator the layout's naming convention uses: `P1 - Fiddle Yard`. */
const CODE_SEPARATOR = /^(.*?)\s+-\s+\S/;

/**
 * The part of a point's name to draw on the tile.
 *
 * Prefers the identifier before the ` - ` separator. Falls back to a truncation
 * for a name that does not follow the convention, rather than assuming one —
 * a point called `Yard Throat` is legal and must still render something a person
 * can match against the full name in the tooltip.
 */
export function shortPointLabel(name: string, max = MAX_POINT_LABEL_CHARS): string {
  const code = CODE_SEPARATOR.exec(name)?.[1]?.trim();
  const text = code && code.length > 0 ? code : name.trim();

  // Truncate the code too: `Down Yard Throat - Siding 3` has a prefix that is
  // itself too wide, and a rule that only applies to the fallback would let
  // that one through.
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The minimum a tile must expose to be considered for a point's label. */
export interface PointTileRef {
  x: number;
  y: number;
  tileType: TileType;
  pointId: string;
}

/**
 * Chooses the one tile per point that carries its name.
 *
 * Keyed by `"x,y"` so the render loop can ask "is this cell the anchor for the
 * point it depicts?" without scanning. The value is the `pointId`, so a cell
 * that has since been repainted to a different point does not match stale.
 *
 * Ordering is fully determined — point tile first, then lowest `y`, then lowest
 * `x` — because a label that moved between renders of an unchanged drawing
 * would look like the drawing had changed.
 */
export function pointLabelAnchors(tiles: readonly PointTileRef[]): Map<string, string> {
  const best = new Map<string, PointTileRef>();

  for (const tile of tiles) {
    const current = best.get(tile.pointId);
    if (!current || preferred(tile, current)) best.set(tile.pointId, tile);
  }

  return new Map([...best.values()].map((t) => [`${t.x},${t.y}`, t.pointId]));
}

function preferred(candidate: PointTileRef, incumbent: PointTileRef): boolean {
  const a = isPointTile(candidate.tileType);
  const b = isPointTile(incumbent.tileType);
  if (a !== b) return a;
  return candidate.y < incumbent.y || (candidate.y === incumbent.y && candidate.x < incumbent.x);
}
