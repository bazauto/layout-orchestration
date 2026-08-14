/**
 * Tile paths — the SVG for each `TileType`.
 *
 * Pure per-tile drawing: no state, no viewport, no knowledge of the grid it
 * sits in. Extracted from `GridEditor.tsx` by #75 so the editor and the
 * monitor view (#63/#82) draw exactly the same track — a second, subtly
 * different renderer of the same railway is the whole risk that issue names.
 *
 * The **shapes** are no longer here. `diagram/trackGeometry.ts` owns them, and
 * this module renders them with the sleepers, stop blocks and platform edging
 * that make a track drawing readable. That split is what stopped the live road
 * overlay in `TrackDiagram` drawing a point's divergent leg as a right angle
 * while this module drew it as a diagonal: same railway, same component, two
 * descriptions of one leg. Everything that strokes along the track — the road
 * overlay, a route highlight — now reads the same table this does.
 */

import { TileType } from '../types';
import { trackLegs, trackStubs } from './trackGeometry';

export const TILE_SIZE = 40;

const TRACK_COLOUR = '#89b4fa';
const SLEEPER_COLOUR = '#585b70';
/**
 * The divergent leg of a point, drawn distinctly so an author can see which
 * leg a `reverse` will select without reading the `N`/`R` letters.
 *
 * This is `POINT_POSITION.reverse.colour` by coincidence rather than by
 * meaning — the divergent leg is geometry, and which position selects it is
 * `metadata.pointRoads`, which can map it either way round
 * (`defaultPointRoads(…, divergentIsNormal)`). Deliberately left as it was: it
 * reads well and the stroke weight, not the hue, is what carries the
 * distinction.
 */
const DIVERGENT_COLOUR = '#cba6f7';
const T = TILE_SIZE;
const H = T / 2; // half tile

// ─── SVG per tile type ───────────────────────────────────────────────────────

export function TilePath({ type, sleepers = true }: { type: TileType; sleepers?: boolean }) {
  const stroke = {
    stroke: TRACK_COLOUR,
    strokeWidth: 4,
    fill: 'none',
    strokeLinecap: 'round' as const,
  };
  const sleeper = { stroke: SLEEPER_COLOUR, strokeWidth: 2, fill: 'none' };

  // Sleeper marks across the track. Only the two straights carry them: on a
  // curve or a point they collide with the leg they are meant to sit under.
  //
  // `sleepers={false}` is for a cell a route line runs through (#129). The
  // halo is drawn under the track but *over* the tile, so four grey ticks per
  // tile cut a continuous highlight into short blocks — the operator's words
  // were "it looks like a lot of carriages are on the track". Sleepers are
  // texture on plain track; where a route is drawn, the route is what the cell
  // is saying.
  const sleeperMarks = (positions: number[], vertical = false) =>
    (sleepers ? positions : []).map((p, i) =>
      vertical ? (
        <line key={i} x1={H - 7} y1={p} x2={H + 7} y2={p} {...sleeper} />
      ) : (
        <line key={i} x1={p} y1={H - 7} x2={p} y2={H + 7} {...sleeper} />
      ),
    );

  const legs = trackLegs(type, T).map((leg, i) => (
    <path
      key={`leg-${i}`}
      d={leg.d}
      {...stroke}
      {...(leg.divergent ? { stroke: DIVERGENT_COLOUR, strokeWidth: 3 } : {})}
    />
  ));

  const stubs = trackStubs(type, T).map((stub, i) => (
    <path key={`stub-${i}`} d={stub.d} {...stroke} />
  ));

  switch (type) {
    case 'straight-h':
      return (
        <>
          {sleeperMarks([8, 16, 24, 32])}
          {legs}
        </>
      );
    case 'straight-v':
      return (
        <>
          {sleeperMarks([8, 16, 24, 32], true)}
          {legs}
        </>
      );
    case 'buffer':
      return (
        <>
          {stubs}
          <rect x={H - 2} y={H - 8} width={10} height={16} fill={TRACK_COLOUR} rx={2} />
        </>
      );
    case 'platform':
      return (
        <>
          {legs}
          <rect x={4} y={H - 12} width={T - 8} height={8} fill="#a6e3a1" rx={2} opacity={0.7} />
        </>
      );
    default:
      return <>{legs}</>;
  }
}
