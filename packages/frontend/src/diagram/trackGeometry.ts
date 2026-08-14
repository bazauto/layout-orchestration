/**
 * Track geometry — the one description of what shape each drawn leg is.
 *
 * ## Why this exists
 *
 * `TilePath` drew a `point-left`'s divergent leg as a straight diagonal from
 * the west edge to the north edge. The live road overlay in `TrackDiagram`
 * drew *the same leg* as a polyline through the tile centre — a 90° corner
 * where the tile underneath showed a diagonal. Two drawings of one leg, in one
 * component, disagreeing about its shape.
 *
 * That is #75's failure mode arrived at from the inside: the editor and the
 * monitor share a renderer, but the renderer had the geometry written out
 * twice. So the shape of a leg lives here, once, and everything that draws
 * along the track reads it:
 *
 * - `TilePath` renders these paths as the track itself.
 * - The live point-road overlay strokes the selected road along them.
 * - A route highlight strokes the road a route holds along them.
 *
 * A chord between the two edge anchors would have fixed the point tiles and
 * nothing else: `w`↔`s` is a straight line on `straight-45` and a quarter-arc
 * on `curve`, the same edge pair with two different shapes. Only a per-tile
 * table can answer "what shape is this leg", which is why this is a table and
 * not a formula.
 *
 * ## Frames
 *
 * Everything here is in the tile's **unrotated** frame, exactly as
 * `metadata.rotation` expects — the caller applies the rotation, the same way
 * the drawing already does (`diagram/pointRoads.ts`). Legs are named by their
 * unrotated edges for the same reason: recording a post-rotation edge would go
 * silently wrong the moment someone pressed the rotate key.
 *
 * ## The duplicate this is half of
 *
 * The leg *pairs* below must equal `TILE_LEGS` in the backend's
 * `packages/backend/src/services/tileGeometry.ts` — a known backend↔frontend
 * duplicate (`CLAUDE.md`, "Open limits"), needing a shared workspace package
 * spanning a CommonJS backend and an ESM frontend to close properly. This file
 * at least makes the frontend's half *complete* and in one place: `DRAWN_LEGS`
 * in `diagram/pointRoads.ts` used to carry two rows of the same table
 * separately, and now derives from here.
 */

import { TileEdge, TileType } from '../types';

/**
 * Where a named tile edge meets the tile boundary. Unrotated.
 *
 * Lives here rather than in `diagram/pointRoads.ts`, where it used to: this is
 * the geometry module, and having the road-mapping module own the anchors
 * while this one owns the paths would make the dependency point the wrong way
 * round — `pointRoads` derives its legs from the table below.
 */
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

/** One drawn leg: the two edges it joins, and the path it is drawn along. */
export interface TrackLeg {
  /** The two edges this leg joins, in the tile's unrotated frame. */
  legs: readonly [TileEdge, TileEdge];
  /** SVG path data, in the tile's local unrotated frame. */
  d: string;
  /**
   * A point's divergent leg — the one that forks away from the through road.
   * Drawn differently by `TilePath`, and the only thing here that is about
   * presentation rather than geometry, because it is what tells an author at a
   * glance which leg a `reverse` command will select.
   */
  divergent?: boolean;
}

/** A drawn edge that track reaches but does not pass through — a buffer's stub. */
export interface TrackStub {
  edge: TileEdge;
  d: string;
}

/**
 * Order-insensitive key for a leg. `['w','n']` and `['n','w']` are one leg —
 * a road authored either way round must find the same path.
 */
export function legKey(a: TileEdge, b: TileEdge): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/**
 * Every leg a tile type draws, at the given tile size.
 *
 * Not memoised: the caller is a render loop that already rebuilds its tiles
 * per frame, and this is a dozen string concatenations. Measure before adding
 * a cache.
 */
export function trackLegs(type: TileType, size: number): readonly TrackLeg[] {
  const t = size;
  const h = size / 2;

  const straightH: TrackLeg = { legs: ['w', 'e'], d: `M 0 ${h} L ${t} ${h}` };
  const straightV: TrackLeg = { legs: ['n', 's'], d: `M ${h} 0 L ${h} ${t}` };

  switch (type) {
    case 'straight-h':
      return [straightH];
    case 'straight-v':
      return [straightV];
    // The palette calls this "Corner". It joins the west and north edge
    // *midpoints* — it does not run corner to corner, which is why its legs
    // are two orthogonal edges and not `nw`/`se`.
    case 'straight-45':
      return [{ legs: ['w', 'n'], d: `M 0 ${h} L ${h} 0` }];
    // `curve` and `curve-nw` draw the same edge pair the opposite way round.
    // Both are legacy names that must keep round-tripping
    // (`docs/track-grid.md` D2), so both survive here with the arc each one
    // has always drawn — the sweep flags differ and are not interchangeable.
    case 'curve':
      return [{ legs: ['w', 's'], d: `M 0 ${h} A ${h} ${h} 0 0 0 ${h} ${t}` }];
    case 'curve-ne':
      return [{ legs: ['s', 'e'], d: `M ${h} ${t} A ${h} ${h} 0 0 1 ${t} ${h}` }];
    case 'curve-nw':
      return [{ legs: ['s', 'w'], d: `M ${h} ${t} A ${h} ${h} 0 0 0 0 ${h}` }];
    case 'curve-se':
      return [{ legs: ['n', 'e'], d: `M ${h} 0 A ${h} ${h} 0 0 0 ${t} ${h}` }];
    case 'curve-sw':
      return [{ legs: ['n', 'w'], d: `M ${h} 0 A ${h} ${h} 0 0 1 0 ${h}` }];
    case 'point-left':
      return [straightH, { legs: ['w', 'n'], d: `M 0 ${h} L ${h} 0`, divergent: true }];
    case 'point-right':
      return [straightH, { legs: ['w', 's'], d: `M 0 ${h} L ${h} ${t}`, divergent: true }];
    // Two roads crossing, deliberately NOT interconnecting. A four-edge set
    // would make a plain diamond read as a junction — see #26.
    case 'crossing':
      return [straightH, straightV];
    case 'platform':
      return [straightH];
    // No leg: nothing passes through a buffer. Its one drawn edge is a stub.
    case 'buffer':
      return [];
    default:
      return [];
  }
}

/**
 * Edges a tile draws track to without that track continuing through — today
 * only a buffer's west stub, which reaches the boundary (so it joins whatever
 * is drawn there) while asserting that nothing continues beyond it.
 *
 * Separate from `trackLegs` because a stub is not traversable: anything
 * walking the drawing must not treat it as a way through. A route highlight,
 * on the other hand, does want it — a route ending at a buffer stop runs right
 * up to the stop block.
 */
export function trackStubs(type: TileType, size: number): readonly TrackStub[] {
  const h = size / 2;
  return type === 'buffer' ? [{ edge: 'w', d: `M 0 ${h} L ${h} ${h}` }] : [];
}

/**
 * The path a named leg is drawn along, or `null` if this tile type draws no
 * such leg.
 *
 * `null` is a real answer, not a failure: `metadata.pointRoads` is authored
 * data and can name a leg the tile does not draw (an author remapped a point
 * and then changed the tile type under it). The caller decides what to do with
 * it — `TrackDiagram` falls back to a straight chord, which is visibly wrong
 * in the same way the authoring is, rather than silently drawing nothing.
 */
export function legPath(
  type: TileType,
  legs: readonly [TileEdge, TileEdge],
  size: number,
): string | null {
  const want = legKey(legs[0], legs[1]);
  return trackLegs(type, size).find((l) => legKey(l.legs[0], l.legs[1]) === want)?.d ?? null;
}

/**
 * A tile size to ask the table about legs at, when only the *edges* are wanted
 * and the drawn path is irrelevant. Any positive number gives the same leg
 * pairs; the paths it produces are discarded.
 */
const LEG_PROBE_SIZE = 2;

/**
 * A point tile's two roads, named: the through leg and the divergent one.
 *
 * `undefined` for anything that is not drawn as a point, which is what makes
 * this the single test for "does this tile type have a road mapping at all".
 */
export function pointLegs(
  type: TileType,
): { through: readonly [TileEdge, TileEdge]; divergent: readonly [TileEdge, TileEdge] } | undefined {
  const legs = trackLegs(type, LEG_PROBE_SIZE);
  const through = legs.find((l) => !l.divergent);
  const divergent = legs.find((l) => l.divergent);
  return through && divergent ? { through: through.legs, divergent: divergent.legs } : undefined;
}

/**
 * A straight line between two edge anchors — the fallback for a leg no tile
 * type draws.
 *
 * Deliberately not the old behaviour. The polyline this replaces bent through
 * the tile centre, which drew a plausible-looking right-angled road that no
 * tile has ever depicted; a chord at least lands on the two boundaries the
 * road actually claims to join.
 */
export function chordPath(legs: readonly [TileEdge, TileEdge], size: number): string {
  const a = edgeAnchor(legs[0], size);
  const b = edgeAnchor(legs[1], size);
  return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
}
