/**
 * Route lines (#129) — a set route drawn **along the track it runs over**.
 *
 * ## This replaces the lock outline; it is not a second layer
 *
 * `liveState.ts` rule 2 and `docs/liveness.md` M5 used to say, flatly, that
 * there is no route layer: every block on a granted route carries
 * `lockedByRoute`, so a route highlight would be a second mark for one fact,
 * competing for tiles that already carry occupancy and a dashed outline.
 *
 * That argument is sound, and this **inverts** it rather than contradicting it.
 * The outline is gone; the line takes its place. One mark, one fact, as before
 * — the mark moved from the perimeter to the track and gained the ability to
 * say *which* route. Two concurrent routes used to be two identical yellow
 * outlines, which could say "held" but never "held by which", and that is the
 * question an operator asks when a route will not set.
 *
 * The rule that keeps it honest: **a step is drawn only while its block still
 * reports `lockedByRoute === route.id`**. Locks release behind the train, so a
 * passed block genuinely is no longer held, and drawing it as route would
 * contradict the very field the outline used to read. Deriving the new mark
 * from the old mark's source is what makes this a replacement.
 *
 * ## Where the decorative cells come from
 *
 * A route's path is a list of *blocks*. The track between two blocks is
 * frequently drawn but tagged to neither — the Fiddle Yard reaches its sidings
 * through a feeder that is deliberately part of no block — and a highlight that
 * stopped at each block boundary would look like a broken line rather than a
 * road.
 *
 * `CompiledEdge.via` already carries exactly those cells, "in walk order". The
 * monitor reads `GET .../topology/compile` once and joins
 * `RoutePathStep.edgeId` → `BlockEdgeRecord` → `(from, fromEnd, to, toEnd)` →
 * `via`. Walking the drawing here instead would mean a third hand-maintained
 * copy of `TILE_LEGS` on the frontend, on the geometry side, which is the
 * duplicate `CLAUDE.md` already names twice.
 *
 * **A join that does not resolve draws a gap, never a guess.** If the compile
 * is stale relative to the applied graph the lookup misses, and a plausible
 * path through the wrong decorative tiles is exactly the failure #91 was about.
 * The gap is reported so the key can say so.
 *
 * ## Which legs light up
 *
 * On a tile carrying point roads, the leg is the one the route's own point
 * holds select — the same match `roadSelection` performs, against the
 * positions this route requires rather than against the live ones, because the
 * line shows the road the route has *claimed*, not the road the points happen
 * to be lying in. On every other tile, every leg it draws.
 *
 * A block containing a passing loop therefore lights both roads. Accepted: the
 * alternative is a walk through the block, which is the compiler's job and not
 * a display's.
 */

import {
  BlockEdgeRecord,
  CompiledEdge,
  GridTileMetadata,
  GridTileRecord,
  LocoRecord,
  RouteReservation,
  RouteStatus,
  TileType,
} from '../types';
import { LiveBlock } from './liveState';
import { chordPath, legPath, trackLegs, trackStubs } from './trackGeometry';

/** One piece of drawn road, in one cell. `d` is in the tile's unrotated frame. */
export interface RouteSegment {
  x: number;
  y: number;
  /** The tile's own rotation — the caller applies it, as everything else does. */
  rotation: number;
  d: string;
}

export interface RouteLine {
  routeId: string;
  status: RouteStatus;
  locoAddress: number;
  /** From the roster; `null` degrades to the address at the caller (naming.md D8). */
  locoName: string | null;
  /** Ordinal among the drawn routes. Colour and dash are derived from it. */
  styleIndex: number;
  segments: RouteSegment[];
  /** At least one join between two held blocks could not be resolved to cells. */
  hasGaps: boolean;
}

/** Only these two hold locks; the rest hold nothing and are not drawn. */
const DRAWN_STATUSES: ReadonlySet<RouteStatus> = new Set<RouteStatus>(['active', 'suspended']);

/**
 * Composite key for a connection.
 *
 * `\u0000` as the separator, and written as an **escape** — never as a literal
 * byte. It is the right separator, for the reason `domain/topology.ts` uses
 * one: block ids and end labels are both operator-supplied, so any printable
 * separator could be forged by a name containing it, and NUL cannot occur in
 * either. It is written escaped because a literal NUL makes git render every
 * diff of the file as `Binary files differ` and makes ripgrep skip it
 * entirely — which is what happened to `services/gridGeometry.ts` and is what
 * `sourceHygiene.test.ts` now catches. The escape produces a byte-identical
 * string at runtime, so there is never a reason to use the literal.
 */
const edgeKey = (from: string, fromEnd: string | null, to: string, toEnd: string | null) =>
  `${from}\u0000${fromEnd ?? ''}\u0000${to}\u0000${toEnd ?? ''}`;

export interface RoutePathInput {
  routes: Readonly<Record<string, RouteReservation>>;
  blocks: ReadonlyMap<string, LiveBlock>;
  grid: ReadonlyMap<string, GridTileRecord>;
  parsedMeta: ReadonlyMap<string, GridTileMetadata>;
  /** The applied graph — what `RoutePathStep.edgeId` refers to. */
  edges: readonly BlockEdgeRecord[];
  /** The compiled candidate graph, which is the only thing carrying `via`. */
  compiledEdges: readonly CompiledEdge[];
  locos: readonly LocoRecord[];
  /** Tile size in SVG units, so this module never imports the renderer's constant. */
  size: number;
}

/**
 * Builds one line per drawn route.
 *
 * Ordered by route id, and `styleIndex` assigned from that order, so a route
 * keeps its colour across renders. Assigning from object iteration order would
 * let a re-fetched snapshot swap two routes' colours, which on a mimic reads as
 * the routes themselves having swapped.
 */
export function buildRouteLines(input: RoutePathInput): RouteLine[] {
  const { routes, blocks, grid, parsedMeta, edges, compiledEdges, locos, size } = input;

  const locoNames = new Map(locos.map((l) => [l.address, l.name]));
  const edgeById = new Map(edges.map((e) => [e.id, e]));

  const viaByEdge = new Map<string, Array<{ x: number; y: number }>>();
  for (const c of compiledEdges) {
    viaByEdge.set(edgeKey(c.fromBlockId, c.fromEnd, c.toBlockId, c.toEnd), c.via);
  }

  const cellsByBlock = new Map<string, string[]>();
  for (const key of grid.keys()) {
    const blockId = parsedMeta.get(key)?.blockId;
    if (!blockId) continue;
    const list = cellsByBlock.get(blockId);
    if (list) list.push(key);
    else cellsByBlock.set(blockId, [key]);
  }

  const drawn = Object.values(routes)
    .filter((r) => DRAWN_STATUSES.has(r.status))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return drawn.map((route, styleIndex) => {
    // The positions this route has claimed. Released holds are dropped: a
    // released point is no longer this route's to describe.
    const required = new Map<string, 'normal' | 'reverse'>();
    for (const hold of route.holds) {
      if (hold.kind === 'point' && !hold.released && hold.requiredPosition) {
        required.set(hold.targetId, hold.requiredPosition);
      }
    }

    const held = route.path.map((step) => blocks.get(step.blockId)?.lockedByRoute === route.id);

    const segments: RouteSegment[] = [];
    const seen = new Set<string>();

    const pushCell = (key: string) => {
      const tile = grid.get(key);
      if (!tile) return;
      // A cell reached twice — a via cell that is also a block cell, or a block
      // visited twice — must not stack two strokes and read as heavier.
      if (seen.has(key)) return;
      seen.add(key);

      const meta = parsedMeta.get(key) ?? {};
      const rotation = typeof meta.rotation === 'number' ? meta.rotation : 0;
      for (const d of legsFor(tile.tileType as TileType, meta, required, size)) {
        segments.push({ x: tile.x, y: tile.y, rotation, d });
      }
    };

    for (let i = 0; i < route.path.length; i++) {
      if (!held[i]) continue;
      for (const key of cellsByBlock.get(route.path[i].blockId) ?? []) pushCell(key);
    }

    let hasGaps = false;
    for (let i = 1; i < route.path.length; i++) {
      // The join between step i-1 and step i: `edgeId` is the edge that leads
      // *into* step i (`routeLocking.ts#buildPath`). Only drawn when both ends
      // are — a join to a block the train has already released is not part of
      // the road ahead.
      if (!held[i - 1] || !held[i]) continue;

      const via = viaCells(route.path[i].edgeId, edgeById, viaByEdge);
      if (via === null) {
        hasGaps = true;
        continue;
      }
      for (const cell of via) pushCell(`${cell.x},${cell.y}`);
    }

    return {
      routeId: route.id,
      status: route.status,
      locoAddress: route.locoAddress,
      locoName: locoNames.get(route.locoAddress) ?? null,
      styleIndex,
      segments,
      hasGaps,
    };
  });
}

/**
 * The cells an edge crosses between its two blocks, or `null` when the join
 * cannot be resolved — an unknown edge id, or a compiled graph that no longer
 * contains the applied edge.
 *
 * The reversed tuple is tried as well: the compiler emits both directions of
 * every connection, and which one a `block_edges` row happens to name is not
 * something the drawing cares about. Walk order reverses with it, which does
 * not matter to a set of cells.
 */
function viaCells(
  edgeId: string | null,
  edgeById: ReadonlyMap<string, BlockEdgeRecord>,
  viaByEdge: ReadonlyMap<string, Array<{ x: number; y: number }>>,
): Array<{ x: number; y: number }> | null {
  if (!edgeId) return null;
  const edge = edgeById.get(edgeId);
  if (!edge) return null;

  return (
    viaByEdge.get(edgeKey(edge.fromBlockId, edge.fromEnd, edge.toBlockId, edge.toEnd)) ??
    viaByEdge.get(edgeKey(edge.toBlockId, edge.toEnd, edge.fromBlockId, edge.fromEnd)) ??
    null
  );
}

/**
 * The paths to stroke in one cell.
 *
 * A point tile whose roads none of this route's requirements resolve falls
 * through to every leg rather than drawing nothing: the route demonstrably runs
 * through the cell — it is in a held block — so saying "some road here" is
 * true, where an empty cell in the middle of a line would read as a break in
 * the road.
 */
function legsFor(
  tileType: TileType,
  meta: GridTileMetadata,
  required: ReadonlyMap<string, 'normal' | 'reverse'>,
  size: number,
): string[] {
  const roads = meta.pointRoads ?? [];
  if (roads.length > 0) {
    const match = roads.find(
      (r) => r.when.length > 0 && r.when.every((c) => required.get(c.pointId) === c.position),
    );
    if (match) return [legPath(tileType, match.legs, size) ?? chordPath(match.legs, size)];
  }

  return [
    ...trackLegs(tileType, size).map((l) => l.d),
    ...trackStubs(tileType, size).map((s) => s.d),
  ];
}

/**
 * Route segments keyed by cell, which is the shape the renderer wants: the
 * halo is drawn **inside each tile's group**, under the track and over the
 * occupancy wash. It cannot be one layer beneath all the tiles, because every
 * tile paints an opaque background rect of its own.
 */
export function routeSegmentsAtCell(
  lines: readonly RouteLine[],
): Map<string, Array<{ line: RouteLine; segment: RouteSegment }>> {
  const out = new Map<string, Array<{ line: RouteLine; segment: RouteSegment }>>();
  for (const line of lines) {
    for (const segment of line.segments) {
      const key = `${segment.x},${segment.y}`;
      const list = out.get(key);
      if (list) list.push({ line, segment });
      else out.set(key, [{ line, segment }]);
    }
  }
  return out;
}
