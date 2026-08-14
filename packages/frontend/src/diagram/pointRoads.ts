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

import { TilePointRoad, TileType } from '../types';
import { pointLegs } from './trackGeometry';

/**
 * `edgeAnchor` moved to `diagram/trackGeometry.ts`, which owns tile geometry
 * now. Re-exported here because a road *is* a pair of anchors and every caller
 * that wants one wants the other — and because the alternative was a cycle,
 * since that module derives this one's legs.
 */
export { edgeAnchor } from './trackGeometry';

/**
 * Whether this tile type depicts something with a road mapping at all.
 *
 * Derived from `trackGeometry`'s table rather than from a local copy of two of
 * its rows, which is what this file used to hold. Those two rows were a
 * *fragment* of the backend's `TILE_LEGS` and drifted independently of the
 * paths `TilePath` drew from — the divergence #75's argument is about.
 */
export function isPointTile(tileType: TileType): boolean {
  return pointLegs(tileType) !== undefined;
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
  const legs = pointLegs(tileType);
  if (!legs) return undefined;

  const normalLegs = divergentIsNormal ? legs.divergent : legs.through;
  const reverseLegs = divergentIsNormal ? legs.through : legs.divergent;

  return [
    { when: [{ pointId, position: 'normal' }], legs: [...normalLegs] },
    { when: [{ pointId, position: 'reverse' }], legs: [...reverseLegs] },
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
