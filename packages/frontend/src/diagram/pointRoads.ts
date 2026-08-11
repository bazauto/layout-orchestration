/**
 * Point roads — which drawn leg of a point tile each position selects (#73).
 *
 * ## The gap this closes
 *
 * A `point-left` tile draws a fixed through-line plus a fixed divergent leg.
 * The tile knows it has two legs. It did **not** know which leg corresponded
 * to the point's `normal` position and which to `reverse` — `PointState.
 * position` is `'normal' | 'reverse'` and carries no geometry, and `points`
 * has nothing spatial on it either. So a mimic could be told "point P is set
 * reverse" and still be unable to draw it. That is the whole feature.
 *
 * ## Rotation
 *
 * Legs are named in the tile's **unrotated** frame and `metadata.rotation` is
 * applied at render time, exactly as the drawing already is. Recording the
 * post-rotation edge instead would silently become wrong the moment the tile
 * was rotated — and rotation is a single keypress in this editor.
 *
 * ## What a drawn road is not
 *
 * A **commanded** position, not a confirmed one. There is no point-position
 * feedback channel (#25), and a point lock is an authority guarantee rather
 * than a physical-position guarantee. Everything here keeps that distinction
 * available: the road mapping is independent of where the position came from,
 * so when #25 lands, confirmed and commanded can be drawn differently without
 * re-modelling any of this.
 */

import { TileEdge, TilePointRoad, TileType } from '../types';

/** Where a named tile edge meets the tile boundary, for a tile of size `size`. Unrotated. */
export function edgeAnchor(edge: TileEdge, size: number): { x: number; y: number } {
  const h = size / 2;
  switch (edge) {
    case 'n':  return { x: h, y: 0 };
    case 'ne': return { x: size, y: 0 };
    case 'e':  return { x: size, y: h };
    case 'se': return { x: size, y: size };
    case 's':  return { x: h, y: size };
    case 'sw': return { x: 0, y: size };
    case 'w':  return { x: 0, y: h };
    case 'nw': return { x: 0, y: 0 };
  }
}

/**
 * The legs the palette's two point tiles actually draw.
 *
 * `TilePath` draws `point-left` as a through line west→east plus a divergent
 * leg from the west centre up to the north centre; `point-right` diverges
 * downward to the south instead. These constants have to track that geometry —
 * if the drawing changes, so does this.
 */
const DRAWN_LEGS: Partial<Record<TileType, { through: [TileEdge, TileEdge]; divergent: [TileEdge, TileEdge] }>> = {
  'point-left':  { through: ['w', 'e'], divergent: ['w', 'n'] },
  'point-right': { through: ['w', 'e'], divergent: ['w', 's'] },
};

/** Whether this tile type depicts something with a road mapping at all. */
export function isPointTile(tileType: TileType): boolean {
  return DRAWN_LEGS[tileType] !== undefined;
}

/**
 * The road mapping to write when a point tile is painted.
 *
 * Defaulted rather than left empty, because the alternative is an authoring
 * step nobody performs: the mapping is only cheap to capture *while the points
 * are being placed*, and a retrofit means revisiting every point tile by hand.
 * The default is the conventional one — the through road is `normal` — and
 * `divergentIsNormal` swaps it for the points wired the other way round.
 *
 * This is an author's assertion and cannot be checked against anything. There
 * is no independent source of truth for which way round a physical point is
 * wired, and it cannot be cross-checked against `block_edges` either, since
 * `pointConditions` names a required position with no geometric meaning. The
 * editor's job is to make it visible and easy to correct, not to validate it.
 */
export function defaultPointRoads(
  tileType: TileType,
  pointId: string,
  divergentIsNormal = false,
): TilePointRoad[] | undefined {
  const legs = DRAWN_LEGS[tileType];
  if (!legs) return undefined;

  const normalLegs = divergentIsNormal ? legs.divergent : legs.through;
  const reverseLegs = divergentIsNormal ? legs.through : legs.divergent;

  return [
    { when: [{ pointId, position: 'normal' }], legs: normalLegs },
    { when: [{ pointId, position: 'reverse' }], legs: reverseLegs },
  ];
}

/**
 * The road a given point stands to select, for labelling a tile in the editor.
 *
 * Returns the first road whose conditions are all satisfied by `positions`.
 * A road with several conditions (a slip, a three-way) only matches when every
 * one holds — which is why `when` is a list and not a single position.
 */
export function roadFor(
  roads: readonly TilePointRoad[] | undefined,
  positions: Readonly<Record<string, 'normal' | 'reverse' | 'unknown'>>,
): TilePointRoad | undefined {
  return roads?.find((road) => road.when.every((c) => positions[c.pointId] === c.position));
}

/**
 * The single-point label for a road, for the editor's static annotation: `N`,
 * `R`, or `N+R`-style for a multi-condition road.
 *
 * Deliberately a letter and not a colour. Colour is never the sole carrier of
 * meaning (#81), and this is the one thing on a point tile that tells you the
 * mapping is right before a train proves it wrong.
 */
export function roadLabel(road: TilePointRoad): string {
  return road.when.map((c) => (c.position === 'normal' ? 'N' : 'R')).join('+');
}
