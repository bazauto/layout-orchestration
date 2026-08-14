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
 * **The road is walked, not washed.** This used to light every leg of every
 * cell of every held block, and that over-draws in the ordinary case: a route
 * from Engine Shed 1 into Engine / Goods Transfer lit the three tiles between
 * that block's point and the Goods Shed — track the train will not run over,
 * on the far side of a point this very route is holding the other way.
 *
 * So the segments come from a walk over the cells the route may occupy: the
 * held blocks plus the resolved `via` cells, entered from the joins between
 * them and followed leg to leg. At a tile carrying point roads only the road
 * the route's own holds select is traversable — the same match `roadSelection`
 * performs, but against the positions this route *requires* rather than the
 * ones the points happen to be lying in, because the line shows the road the
 * route has claimed. A leg the walk never reaches is never drawn.
 *
 * Two deliberate fallbacks, both erring toward drawing *more*:
 *
 * - **A point tile no hold resolves stays fully traversable.** The route
 *   demonstrably runs through the cell, and an empty cell mid-line reads as a
 *   break in the road rather than as "the position is unclaimed".
 * - **A held block the walk never reaches is washed whole**, as before. That
 *   happens when the joins either side could not be resolved to cells — the
 *   same condition `hasGaps` already reports. The route holds that block, and
 *   a line that vanishes rather than being drawn imprecisely would understate
 *   what is locked. A single-block route has no join to enter by at all and
 *   takes this path every time.
 *
 * The first block is walked from its exit join like any other, so a fork it
 * cannot take is not drawn — but everything it *can* reach is, because the
 * train's position within a block is not modelled (`docs/braking.md` B7).
 */

import {
  BlockEdgeRecord,
  CompiledEdge,
  GridTileMetadata,
  GridTileRecord,
  LocoRecord,
  RouteReservation,
  RouteStatus,
  TileEdge,
  TileType,
} from '../types';
import { LiveBlock } from './liveState';
import {
  EDGE_OFFSET,
  chordPath,
  legPath,
  oppositeEdge,
  rotateEdge,
  trackLegs,
  trackStubs,
} from './trackGeometry';

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

    // Where the route may go: the cells of the blocks it still holds, plus the
    // cells between them. The walk below never leaves this set, which is what
    // stops a line running out along decorative track past the end of the road.
    const allowed = new Set<string>();
    for (let i = 0; i < route.path.length; i++) {
      if (!held[i]) continue;
      for (const key of cellsByBlock.get(route.path[i].blockId) ?? []) allowed.add(key);
    }

    const walk = new RoadWalk({ grid, parsedMeta, required, size, allowed });

    let hasGaps = false;
    for (let i = 1; i < route.path.length; i++) {
      // The join between step i-1 and step i: `edgeId` is the edge that leads
      // *into* step i (`routeLocking.ts#buildPath`). Only walked when both ends
      // are held — a join to a block the train has already released is not part
      // of the road ahead.
      if (!held[i - 1] || !held[i]) continue;

      const via = viaCells(route.path[i].edgeId, edgeById, viaByEdge);
      if (via === null) {
        hasGaps = true;
        continue;
      }

      // The connective cells belong to no block, so they join the walkable set
      // here rather than above — and only for a join both of whose ends are
      // still held.
      const viaKeys = via.map((cell) => `${cell.x},${cell.y}`);
      for (const key of viaKeys) allowed.add(key);

      walk.seedJoin(
        cellsByBlock.get(route.path[i - 1].blockId) ?? [],
        cellsByBlock.get(route.path[i].blockId) ?? [],
        viaKeys,
      );
    }

    walk.run();

    // A held block the walk never entered — no join either side of it resolved
    // — is washed whole rather than dropped. See the header: the route does
    // hold it, and drawing nothing understates that.
    for (let i = 0; i < route.path.length; i++) {
      if (!held[i]) continue;
      const cells = cellsByBlock.get(route.path[i].blockId) ?? [];
      if (cells.some((key) => walk.lit(key))) continue;
      for (const key of cells) walk.lightWhole(key);
    }

    const segments = walk.segments();

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
 * One piece of road through one cell: the two boundaries it joins, in the
 * **rotated** frame the walk steps in, and the path to stroke, in the
 * unrotated frame the renderer rotates.
 *
 * `terminal` is a buffer's stub — track that reaches a boundary without
 * continuing through the tile. A route ending at a buffer stop runs right up to
 * the stop block, so it is drawn; a walk must not step through it.
 */
interface Road {
  edges: readonly [TileEdge, TileEdge];
  d: string;
  terminal: boolean;
}

/**
 * The roads a cell offers this route.
 *
 * A tile carrying point roads offers only the one the route's own holds select.
 * When none of them resolves it, every leg is offered instead — see the
 * fallbacks in the header.
 */
function roadsOf(
  tileType: TileType,
  meta: GridTileMetadata,
  required: ReadonlyMap<string, 'normal' | 'reverse'>,
  size: number,
): Road[] {
  const rotation = typeof meta.rotation === 'number' ? meta.rotation : 0;
  const rotate = (legs: readonly [TileEdge, TileEdge]) =>
    [rotateEdge(legs[0], rotation), rotateEdge(legs[1], rotation)] as const;

  const roads = meta.pointRoads ?? [];
  if (roads.length > 0) {
    const match = roads.find(
      (r) => r.when.length > 0 && r.when.every((c) => required.get(c.pointId) === c.position),
    );
    if (match) {
      return [
        {
          edges: rotate(match.legs),
          d: legPath(tileType, match.legs, size) ?? chordPath(match.legs, size),
          terminal: false,
        },
      ];
    }
  }

  return [
    ...trackLegs(tileType, size).map((l) => ({
      edges: rotate(l.legs),
      d: l.d,
      terminal: false,
    })),
    ...trackStubs(tileType, size).map((s) => ({
      edges: rotate([s.edge, s.edge]),
      d: s.d,
      terminal: true,
    })),
  ];
}

/**
 * A walk along the road, lighting the legs it passes through.
 *
 * The state is a **port** — a cell and the boundary the walk entered it by —
 * not a cell, which is what lets a crossing be entered from the west and leave
 * only by the east (the same reason `tileGeometry.ts#exitsFrom` takes legs
 * rather than an edge set). A cell can therefore be lit on one road and not the
 * other.
 */
class RoadWalk {
  private readonly cells = new Map<string, { tile: GridTileRecord; roads: Road[] }>();
  private readonly litRoads = new Map<string, Set<number>>();
  private readonly visited = new Set<string>();
  private readonly queue: Array<{ key: string; edge: TileEdge }> = [];

  constructor(
    private readonly input: {
      grid: ReadonlyMap<string, GridTileRecord>;
      parsedMeta: ReadonlyMap<string, GridTileMetadata>;
      required: ReadonlyMap<string, 'normal' | 'reverse'>;
      size: number;
      allowed: ReadonlySet<string>;
    },
  ) {}

  /**
   * Starts the walk at a join between two held blocks.
   *
   * The seed is a **boundary**, never a cell: entering a cell through the
   * boundary the road arrives at is what makes a crossing between two blocks
   * carry the route across one road and not the other. Lighting the connective
   * cells outright would light both roads of that diamond, which is the
   * junction #26 says a plain diamond is not.
   *
   * With connective cells, both blocks are seeded into the chain, so the walk
   * covers it from either end even if one block turns out to be unreachable.
   * With none — two blocks drawn touching — the shared tile boundary is the
   * join itself.
   */
  seedJoin(from: readonly string[], to: readonly string[], via: readonly string[]): void {
    const target = new Set(via.length > 0 ? via : to);
    const sources = via.length > 0 ? [...from, ...to] : from;

    for (const key of sources) {
      const cell = this.cell(key);
      if (!cell) continue;
      for (const road of cell.roads) {
        for (const edge of road.edges) {
          const neighbour = this.neighbourKey(cell.tile, edge);
          if (!target.has(neighbour)) continue;
          this.enter(key, edge);
          this.enter(neighbour, oppositeEdge(edge));
        }
      }
    }
  }

  run(): void {
    while (this.queue.length > 0) {
      const { key, edge } = this.queue.pop()!;
      const cell = this.cell(key);
      if (!cell) continue;

      cell.roads.forEach((road, i) => {
        const exit =
          road.edges[0] === edge ? road.edges[1] : road.edges[1] === edge ? road.edges[0] : null;
        if (exit === null) return;

        this.light(key, i);
        if (road.terminal) return;
        this.enter(this.neighbourKey(cell.tile, exit), oppositeEdge(exit));
      });
    }
  }

  lit(key: string): boolean {
    return this.litRoads.has(key);
  }

  /** The whole-block fallback: every road of the cell, walked or not. */
  lightWhole(key: string): void {
    const cell = this.cell(key);
    if (!cell) return;
    cell.roads.forEach((_, i) => this.light(key, i));
  }

  segments(): RouteSegment[] {
    const out: RouteSegment[] = [];
    for (const [key, indices] of this.litRoads) {
      const cell = this.cell(key)!;
      const meta = this.input.parsedMeta.get(key) ?? {};
      const rotation = typeof meta.rotation === 'number' ? meta.rotation : 0;
      for (const i of indices) {
        out.push({ x: cell.tile.x, y: cell.tile.y, rotation, d: cell.roads[i].d });
      }
    }
    return out;
  }

  private cell(key: string): { tile: GridTileRecord; roads: Road[] } | undefined {
    const cached = this.cells.get(key);
    if (cached) return cached;

    const tile = this.input.grid.get(key);
    if (!tile) return undefined;
    const meta = this.input.parsedMeta.get(key) ?? {};
    const built = {
      tile,
      roads: roadsOf(tile.tileType as TileType, meta, this.input.required, this.input.size),
    };
    this.cells.set(key, built);
    return built;
  }

  private neighbourKey(tile: GridTileRecord, edge: TileEdge): string {
    const off = EDGE_OFFSET[edge];
    return `${tile.x + off.dx},${tile.y + off.dy}`;
  }

  private enter(key: string, edge: TileEdge): void {
    if (!this.input.allowed.has(key)) return;
    const port = `${key}|${edge}`;
    if (this.visited.has(port)) return;
    this.visited.add(port);
    this.queue.push({ key, edge });
  }

  private light(key: string, index: number): void {
    // A Set per cell, so a cell reached twice — a via cell that is also a block
    // cell, or a loop walked both ways — never stacks two strokes and reads as
    // heavier than the rest of the line.
    const set = this.litRoads.get(key);
    if (set) set.add(index);
    else this.litRoads.set(key, new Set([index]));
  }
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
