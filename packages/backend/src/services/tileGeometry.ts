/**
 * Tile geometry — what track a tile actually draws, and which of its edges that
 * track touches (#91).
 *
 * ## The question this answers
 *
 * "Are these two cells connected?" Before #91, block-end generation answered it
 * with cell adjacency: if a neighbouring cell belonged to another block, the
 * block opened toward it. That is wrong in the most ordinary shape a model
 * railway has — two parallel roads of a yard, drawn on adjacent rows, touch
 * along their entire length and connect nowhere. Every tile of both read as an
 * opening, and the whole siding fused into one phantom end at its middle.
 *
 * Connectivity is a property of the **drawing**, not of the grid: a tile is
 * joined to its neighbour when the track each draws meets at their shared
 * boundary. That is what this module models.
 *
 * ## Legs are the primitive; the edge set is derived
 *
 * A **leg** is a pair of tile edges the drawn track joins — `point-left` has
 * two (`w–e` through, `w–n` divergent), and a `crossing` has two that
 * deliberately do **not** interconnect (`w–e` and `n–s`). Block-end generation
 * only needs the set of edges track touches, and could have been built on that
 * alone; legs are modelled instead because the set cannot express a crossing.
 * Two roads over one cell would read as one four-way junction, which is exactly
 * the mis-reading #26 is about, and #78's walk from one block to another has to
 * follow a road *through* a tile rather than merely arrive at it.
 *
 * So: `TILE_LEGS` is authored, `TILE_DRAWN_EDGES` is computed from it, and the
 * two cannot drift.
 *
 * ## What is unrotated, and what is not
 *
 * Legs are named in the tile's **unrotated** frame; `metadata.rotation` is
 * applied at derivation time. This is #73's rule for `pointRoads`, for the same
 * reason: rotation is a single keypress in the editor, and a stored
 * post-rotation edge is wrong the moment the tile turns.
 *
 * ## Why this is in `services/` and not `domain/`
 *
 * `domain/types.ts` owns the *vocabulary* — `TILE_TYPES`, `TILE_EDGES`,
 * `TileRotation` — and keeps it. What must not go there is this mapping, from a
 * tile to the track it depicts, because that is the first step of reading a
 * tile. The guardrail recorded in `gridGeometry.ts` and `docs/track-grid.md` is
 * that nothing in `domain/` reads one, and putting this table beside
 * `TILE_TYPES` would invite precisely the import that guardrail exists to
 * prevent: a routing decision reaching for drawn geometry.
 *
 * ## Known duplicate
 *
 * `DRAWN_LEGS` in `packages/frontend/src/diagram/pointRoads.ts` is two rows of
 * `TILE_LEGS`, maintained by hand on the other side of the wire — the same
 * situation as `findBlockRuns` existing twice. #75 unifies both.
 *
 * **This table tracks `TilePath` in `packages/frontend/src/components/GridEditor.tsx`.
 * If the drawing changes, this changes with it.**
 */

import { GridTileMetadata, TILE_EDGES, TileEdge, TileRotation, TileType } from '../domain/types';

export interface EdgeOffset {
  dx: number;
  dy: number;
}

/**
 * Which neighbouring cell each tile edge faces.
 *
 * `y` increases **downward** — north is the top of the diagram, which is the
 * screen convention and not the mathematical one. Inverting it would name every
 * generated end its own opposite.
 */
export const EDGE_OFFSET: Readonly<Record<TileEdge, EdgeOffset>> = {
  n: { dx: 0, dy: -1 },
  ne: { dx: 1, dy: -1 },
  e: { dx: 1, dy: 0 },
  se: { dx: 1, dy: 1 },
  s: { dx: 0, dy: 1 },
  sw: { dx: -1, dy: 1 },
  w: { dx: -1, dy: 0 },
  nw: { dx: -1, dy: -1 },
};

/** A pair of tile edges the drawn track joins, in the tile's unrotated frame. */
export type TileLeg = readonly [TileEdge, TileEdge];

/**
 * The legs each tile type draws, unrotated.
 *
 * Read against `TilePath`. The one worth pausing on is `straight-45` — the
 * palette calls it "Corner" and it draws `(0,H)→(H,0)`, joining the **west and
 * north edge midpoints**. It does not run corner to corner, so its legs are two
 * orthogonal edges and not `nw`/`se`.
 *
 * `curve` and `curve-nw` draw the same pair the opposite way round; both are
 * legacy names that must keep round-tripping (`docs/track-grid.md` D2).
 *
 * `buffer` has **no leg**: nothing passes through it. Its one drawn edge is a
 * stub, below.
 */
export const TILE_LEGS: Readonly<Record<TileType, readonly TileLeg[]>> = {
  'straight-h': [['w', 'e']],
  'straight-v': [['n', 's']],
  'straight-45': [['w', 'n']],
  curve: [['w', 's']],
  'curve-ne': [['s', 'e']],
  'curve-nw': [['s', 'w']],
  'curve-se': [['n', 'e']],
  'curve-sw': [['n', 'w']],
  // The union of these two must equal `DRAWN_LEGS` in the frontend's
  // `diagram/pointRoads.ts`, which is where a point's road mapping is authored.
  'point-left': [
    ['w', 'e'],
    ['w', 'n'],
  ],
  'point-right': [
    ['w', 'e'],
    ['w', 's'],
  ],
  // Two roads crossing, deliberately NOT interconnecting. Modelling this as a
  // four-edge set would make a plain diamond read as a junction — see #26.
  crossing: [
    ['w', 'e'],
    ['n', 's'],
  ],
  platform: [['w', 'e']],
  buffer: [],
};

/**
 * Edges a tile draws track to without that track continuing through the tile.
 *
 * Only `buffer`, which draws a stub from its west edge to a stop block at the
 * centre. It touches the west boundary — so it joins whatever is drawn there —
 * and asserts that nothing continues beyond.
 */
const TILE_STUB_EDGES: Partial<Readonly<Record<TileType, readonly TileEdge[]>>> = {
  buffer: ['w'],
};

/** Tile types whose drawing asserts "track ends here, nothing continues beyond". */
export const TERMINATING_TILE_TYPES: ReadonlySet<TileType> = new Set<TileType>(['buffer']);

/**
 * The edges each tile type's drawn track touches, unrotated.
 *
 * Derived from `TILE_LEGS` plus the stubs rather than authored, so a leg added
 * to the table cannot be forgotten here.
 */
function deriveDrawnEdges(): Record<TileType, readonly TileEdge[]> {
  const out = {} as Record<TileType, readonly TileEdge[]>;
  for (const type of Object.keys(TILE_LEGS) as TileType[]) {
    out[type] = [
      ...new Set<TileEdge>([...TILE_LEGS[type].flat(), ...(TILE_STUB_EDGES[type] ?? [])]),
    ];
  }
  return out;
}

export const TILE_DRAWN_EDGES: Readonly<Record<TileType, readonly TileEdge[]>> =
  Object.freeze(deriveDrawnEdges());

/** The edge facing back from the neighbour across a shared boundary. */
export function oppositeEdge(edge: TileEdge): TileEdge {
  return TILE_EDGES[(TILE_EDGES.indexOf(edge) + 4) % TILE_EDGES.length];
}

/**
 * Rotates an edge **clockwise in screen coordinates**, matching the SVG
 * `rotate(deg, H, H)` the editor draws with. `n` at 90° is `e`.
 *
 * `TILE_EDGES` is ordered clockwise from north, so this is an index step of
 * `rotation / 45`.
 */
export function rotateEdge(edge: TileEdge, rotation: TileRotation = 0): TileEdge {
  const steps = Math.round(rotation / 45);
  return TILE_EDGES[(TILE_EDGES.indexOf(edge) + steps) % TILE_EDGES.length];
}

/**
 * `tileType` is a bare string, not `TileType`: it comes from a DB column that
 * predates the closed enum, and an unrecognised legacy value must be tolerated
 * rather than throw.
 *
 * Such a tile draws nothing and therefore joins nothing — so it *creates* open
 * ends in its neighbours rather than silently absorbing them. Fail-visible, the
 * same posture as `docs/track-grid.md` D10 takes for unreadable metadata.
 */
export function tileLegs(tileType: string, metadata: GridTileMetadata = {}): TileLeg[] {
  const legs = TILE_LEGS[tileType as TileType];
  if (!legs) return [];
  const rotation = metadata.rotation ?? 0;
  return legs.map(([a, b]) => [rotateEdge(a, rotation), rotateEdge(b, rotation)] as TileLeg);
}

/** The rotated set of edges this tile's drawn track touches. */
export function drawnEdges(tileType: string, metadata: GridTileMetadata = {}): ReadonlySet<TileEdge> {
  const edges = TILE_DRAWN_EDGES[tileType as TileType];
  if (!edges) return new Set<TileEdge>();
  const rotation = metadata.rotation ?? 0;
  return new Set(edges.map((e) => rotateEdge(e, rotation)));
}

export function terminatesTrack(tileType: string): boolean {
  return TERMINATING_TILE_TYPES.has(tileType as TileType);
}

/**
 * One side of one tile — a place track can cross a cell boundary.
 *
 * `edge` is in the **rotated** (screen) frame, unlike everything in `TILE_LEGS`.
 * A port is a position on the drawing, so it has already been placed; a leg is a
 * property of the tile's shape, so it has not. Keeping the two frames distinct
 * is what stops a rotation being applied twice.
 */
export interface Port {
  x: number;
  y: number;
  edge: TileEdge;
}

export const portKey = (p: Port): string => `${p.x},${p.y},${p.edge}`;

/**
 * The port on the far side of the same boundary.
 *
 * Pure arithmetic — it does not check that a tile is actually there. A walk
 * steps to `opposingPort` and *then* asks what it found, because "nothing there"
 * is a legitimate answer that means the line ends.
 */
export function opposingPort(port: Port): Port {
  const offset = EDGE_OFFSET[port.edge];
  return { x: port.x + offset.dx, y: port.y + offset.dy, edge: oppositeEdge(port.edge) };
}

/**
 * The edges a walk entering through `edge` can leave by.
 *
 * The point of taking legs rather than an edge set: entering a `crossing` from
 * the west offers only the east, never the north. A junction that let any road
 * reach any other would propose track connections that do not exist.
 */
export function exitsFrom(legs: readonly TileLeg[], edge: TileEdge): TileEdge[] {
  const out: TileEdge[] = [];
  for (const [a, b] of legs) {
    if (a === edge) out.push(b);
    else if (b === edge) out.push(a);
  }
  return out;
}
