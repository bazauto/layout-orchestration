/**
 * Compiling the track graph from the drawing (#103,
 * `docs/track-graph-compilation.md`).
 *
 * ## What this is, and why it is not #78's proposals
 *
 * #78 proposed *candidate rows* for an operator to accept one at a time. This
 * emits a **whole candidate graph** plus the gaps in it, for an operator to
 * review as a diff and apply in one transaction (D1). The difference is not
 * ergonomic. A proposal that goes missing costs you a row you might notice; a
 * compiled graph that goes missing a row is a railway the pathfinder believes
 * is disconnected, and the only thing that can tell you so is an assertion over
 * the whole output — which is what `compileTrackGraph` adds on top of the walk.
 *
 * Nothing here writes. `compileTrackGraph` is pure: tiles in, candidate graph
 * out. `TopologyService` remains the only thing that writes `block_edges`.
 *
 * ## Both directions come from the walk; neither is mirrored (#104)
 *
 * `block_edges` is directional and a physical connection is two rows, so it is
 * tempting to walk one way and mirror the result. That is a bug, and a fixed
 * one — see `dedupeConnections` below. Departing a block through a point tile
 * tinted as that block requires a road leading back into the block's interior;
 * arriving at the same tile does not, because the tile *is* the block. Mirror
 * the arrival and you manufacture a departure the drawing refuses, and a route
 * planned over it runs a train through blades set against it.
 *
 * It matters more here than it did under #78. There, a bad row sat in a review
 * list with an operator's eye on it. Here the compiler owns the whole edge set
 * (D3), so nothing stands between a mirrored false edge and the graph the
 * pathfinder plans on.
 *
 * ## What is a gap, and what is not
 *
 * A gap is something the compiler is **not confident about**, recorded outside
 * the graph rather than inside it wearing a badge (D6). An uncertain edge is
 * precisely what this design exists to prevent, so uncertainty never becomes a
 * row.
 *
 * Gaps come in two kinds, and the distinction is the whole of D7:
 *
 * - **Graph-level assertions** — `block-not-in-graph`,
 *   `block-without-detection`, `opening-unresolved`. These are primary. A walk
 *   can stop somewhere harmless, and a walk can succeed everywhere while a
 *   block still ends up isolated. "Fiddle Yard 2 has no connections" is the
 *   sentence that matters; "no road into block at (11,3)" reads as authoring
 *   noise.
 * - **Per-cell walk notes** — supporting evidence, telling you *where* to go
 *   and look once an assertion has told you *what* is wrong.
 *
 * `stopped-in-own-block` is deliberately **not** a gap. Since #104 it is an
 * ordinary walk outcome rather than a symptom, and the consequence that
 * actually matters — a block nothing reaches — is `block-not-in-graph`.
 *
 * ## What is never derived
 *
 * Distance. Length lives on `blocks.length_mm` (D4, #105) and nothing in this
 * file has any business computing one: tile count bears no relation to physical
 * extent. There is no length field on `CompiledEdge` to tempt anyone.
 */

import { createHash } from 'crypto';
import {
  BlockId,
  GridTileMetadata,
  PointCondition,
  PointId,
  TileEdge,
  TilePointRoad,
  classifyTile,
  depictsPoint,
} from '../domain/types';
import { Coordinate, GeometryTile, compileOpenings } from './gridGeometry';
import {
  EDGE_OFFSET,
  Port,
  drawnEdges,
  exitsFrom,
  opposingPort,
  oppositeEdge,
  portKey,
  rotateEdge,
  tileLegs,
} from './tileGeometry';

/** A single path may cross this many tiles before the branch is abandoned. */
export const MAX_COMPILED_PATH_TILES = 32;

/** Live branches from one opening. A fan of points multiplies quickly; this bounds it. */
export const MAX_BRANCHES_PER_OPENING = 64;

/**
 * Admission control on the whole compiled graph, in the spirit of
 * `MAX_EDGES_PER_LAYOUT`. A drawing that produces more edges than this is not
 * one an operator can review as a diff, and D1's safety argument rests entirely
 * on the diff being reviewable — so the honest answer is to refuse rather than
 * render a wall of rows nobody will read.
 */
export const MAX_COMPILED_EDGES = 200;

/**
 * The shape the walk needs of an opening.
 *
 * Structural rather than a concrete type so both callers fit: `BlockOpening`
 * (#72, whose `label` is a `CardinalEndLabel`) and `CompiledOpening` (#103,
 * whose label is a disambiguated `string`). One walk, two vocabularies — which
 * is what stops this file becoming the third hand-maintained duplicate in this
 * area, after `findBlockRuns` and `TILE_LEGS`.
 */
export interface WalkableOpening {
  blockId: BlockId;
  label: string;
  at: Coordinate;
  terminated: boolean;
  ports: Port[];
}

/**
 * One directed connection the drawing implies.
 *
 * No `id` and no `lengthMm`: this is a candidate, and distance is on the block
 * (D4). `via` and `crossesDiamond` are review aids that are never persisted —
 * they exist so an operator reading the diff can find the connection on the
 * drawing and see the #26 blind spot.
 */
export interface CompiledEdge {
  fromBlockId: BlockId;
  /**
   * `null` only when the walk arrived at a boundary no supplied opening covers.
   * Under `compileOpenings` that cannot happen — every boundary port of every
   * drawn block belongs to exactly one opening — but the walk is shared with
   * #72's `generateBlockEnds`, which *does* drop openings it refuses to name.
   * `compileTrackGraph` turns any such connection into a gap rather than an
   * edge, so a nameless end can never reach `block_edges`.
   */
  fromEnd: string | null;
  toBlockId: BlockId;
  toEnd: string | null;
  pointConditions: PointCondition[];
  /** Review aid, never persisted: cells crossed between the two blocks, in walk order. */
  via: Coordinate[];
  /** Review aid, never persisted: the path crosses a plain diamond (#26). */
  crossesDiamond: boolean;
}

/** Why the walk stopped somewhere. Supporting evidence for a graph-level gap, never a finding on its own. */
export type WalkNote =
  | { kind: 'blocked-by-unclassified'; at: Coordinate }
  | { kind: 'blocked-by-unmapped-point'; at: Coordinate; pointId: PointId }
  | { kind: 'stopped-in-own-block'; blockId: BlockId; at: Coordinate }
  | { kind: 'leg-not-covered-by-road'; at: Coordinate; edge: TileEdge }
  | { kind: 'no-road-out-of-block'; at: Coordinate; blockId: BlockId; edge: TileEdge }
  | { kind: 'search-truncated'; blockId: BlockId; at: Coordinate };

/**
 * Something the compiler is not confident about, recorded outside the graph.
 *
 * The first three are D7's graph-level assertions and are the primary findings.
 * The rest are walk notes carried through as supporting evidence — note that
 * `stopped-in-own-block` is **not** among them, deliberately (see the header).
 */
export type CompileGap =
  /** D7 — a drawn block that appears in no edge. The assertion a per-cell note cannot make. */
  | { kind: 'block-not-in-graph'; blockId: BlockId }
  /**
   * D7/D9 — a block in the graph with no in-service sensor. Load-bearing rather
   * than tidy: the argument that a mis-mapped point is caught on first movement
   * depends entirely on the wrong block being *detected*.
   */
  | { kind: 'block-without-detection'; blockId: BlockId }
  /** D7 — an opening that produced no edge and no buffer terminates it. */
  | { kind: 'opening-unresolved'; blockId: BlockId; label: string; at: Coordinate }
  /** A tile names a block that no longer exists — an `unknown-block` violation waiting to happen. */
  | { kind: 'dangling-block-reference'; at: Coordinate; blockId: BlockId }
  /** D9 — a corrupt metadata blob, distinguished from a merely untagged tile. */
  | { kind: 'tile-metadata-unreadable'; at: Coordinate }
  /** The walk found an end it could not name. Never becomes an edge. */
  | { kind: 'opening-unnamed'; blockId: BlockId; at: Coordinate }
  | { kind: 'blocked-by-unclassified'; at: Coordinate }
  | { kind: 'blocked-by-unmapped-point'; at: Coordinate; pointId: PointId }
  | { kind: 'leg-not-covered-by-road'; at: Coordinate; edge: TileEdge }
  | { kind: 'no-road-out-of-block'; at: Coordinate; blockId: BlockId; edge: TileEdge }
  | { kind: 'search-truncated'; blockId: BlockId; at: Coordinate };

/** A `CompiledEdge` whose ends are both named — the only shape that may become a row. */
export type NamedCompiledEdge = CompiledEdge & { fromEnd: string; toEnd: string };

export interface CompileReport {
  /** SHA-256 hex over exactly what the walk reads, and nothing else (D10). */
  fingerprint: string;
  edges: NamedCompiledEdge[];
  gaps: CompileGap[];
  /**
   * Connected components of the candidate graph, treated as undirected, each
   * sorted. More than one is **reported, never gated**: two legitimate railways
   * in one layout would otherwise refuse `auto` forever with nothing to
   * acknowledge.
   */
  components: BlockId[][];
}

export interface CompileInput {
  tiles: readonly GeometryTile[];
  /** Cells whose metadata blob failed to parse, with the raw string, so the fingerprint moves when corruption is fixed. */
  unreadable: readonly { at: Coordinate; raw: string }[];
  blocks: readonly { id: BlockId }[];
  sensors: readonly { blockId: string | null; inService: boolean }[];
}

export class CompileLimitExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly found: number,
  ) {
    super(`Drawing compiles to ${found} edges, above the ${limit} this surface will render`);
    this.name = 'CompileLimitExceededError';
  }
}

/**
 * `^@` for the same reason `domain/topology.ts` uses it: it cannot occur in a
 * block id or an end label, so a composite key cannot be forged by a name.
 */
const SEP = '^@';

const conditionKey = (conditions: readonly PointCondition[]): string =>
  conditions
    .map((c) => `${c.pointId}:${c.requiredPosition}`)
    .sort()
    .join(',');


/** One live path, mid-walk. */
interface Branch {
  /** The port the walk is arriving *at* — already on the far side of the last boundary. */
  at: Port;
  conditions: PointCondition[];
  via: Coordinate[];
  crossesDiamond: boolean;
  visited: Set<string>;
}

/**
 * Walks the drawing from every opening and returns the connections it finds, in
 * both directions.
 *
 * Pure, and deliberately ignorant of the stored graph. `compileTrackGraph`
 * layers the D7 assertions on top and `reconcileProposals` compares against
 * what is authored; keeping all three apart is what lets the walk be tested
 * against a hand-built tile array with no repository at all.
 */
export function compileConnections(input: {
  tiles: readonly GeometryTile[];
  openings: readonly WalkableOpening[];
}): { connections: CompiledEdge[]; notes: WalkNote[] } {
  const byKey = new Map<string, GeometryTile>();
  for (const t of input.tiles) byKey.set(`${t.x},${t.y}`, t);

  /** Which opening each boundary belongs to, so an arrival can be named. */
  const openingByPort = new Map<string, WalkableOpening>();
  for (const o of input.openings) {
    for (const p of o.ports) openingByPort.set(portKey(p), o);
  }

  const notes: WalkNote[] = [];
  const found: CompiledEdge[] = [];

  for (const opening of input.openings) {
    if (opening.terminated) continue; // nothing leaves a buffered end

    for (const port of opening.ports) {
      // The departing tile may itself be a point, and frequently is: a throat
      // tile is tagged to the block it serves, so the block's opening sits *on*
      // the point. Leaving through that port costs whatever the road using it
      // requires, and missing it was worth catching — the Westgate Hollow fiddle
      // yard proposed `Fiddle Yard 1 ↔ Fiddle Yard 2` with no condition at all,
      // which as an authored edge would let a route plan across P1 set against
      // it. Conditions on arrival were never the whole story.
      const from = byKey.get(`${port.x},${port.y}`);
      if (!from) continue;

      const roads = from.metadata.pointRoads ?? [];

      // Gated on the tile *type*, as #92 established: a point is drawn as two
      // tiles and only the point tile has legs to map, so a `straight-45`
      // companion carrying a `pointId` is not an unmapped point.
      if (depictsPoint(from.tileType) && roads.length === 0) {
        notes.push({
          kind: 'blocked-by-unmapped-point',
          at: { x: port.x, y: port.y },
          pointId: from.metadata.pointId!,
        });
        continue;
      }

      const ctx = { byKey, openingByPort, notes, found };

      if (roads.length === 0) {
        walkFrom(opening, port, [], ctx);
        continue;
      }

      const along = roadsAlong(from, port.edge, roads);

      if (along.length === 0) {
        notes.push({ kind: 'leg-not-covered-by-road', at: { x: port.x, y: port.y }, edge: port.edge });
        continue;
      }

      // Departure, not arrival: the train reaching this boundary came from
      // somewhere inside the block, so the road's other leg has to lead back
      // into it. See the header — the mirror-image test on arrival is #104.
      const seeds = along.filter((road) =>
        leadsIntoBlock(from, otherLeg(road.legs, port.edge), opening.blockId, byKey),
      );

      if (seeds.length === 0) {
        notes.push({
          kind: 'no-road-out-of-block',
          at: { x: port.x, y: port.y },
          blockId: opening.blockId,
          edge: port.edge,
        });
        continue;
      }

      for (const seed of seeds) walkFrom(opening, port, seed.conditions, ctx);
    }
  }

  return { connections: dedupeConnections(found), notes: sortWalkNotes(notes) };
}

/** One authored road that uses `edge` as a leg, rotated onto the drawing. */
interface RoadAlongLeg {
  legs: [TileEdge, TileEdge];
  conditions: PointCondition[];
}

/**
 * The drawn roads that use `edge`, and what each costs.
 *
 * Empty with roads authored means the tile draws a leg its mapping does not
 * cover — an incomplete mapping, reported as `leg-not-covered-by-road` wherever
 * this is called, never treated as "no connection here".
 */
function roadsAlong(
  tile: GeometryTile,
  edge: TileEdge,
  roads: readonly TilePointRoad[],
): RoadAlongLeg[] {
  const out: RoadAlongLeg[] = [];

  for (const road of roads) {
    const legs = rotatedLegs(road, tile.metadata);
    if (!legs.includes(edge)) continue;

    out.push({
      legs,
      conditions: road.when.map((w) => ({ pointId: w.pointId, requiredPosition: w.position })),
    });
  }

  return out;
}

const otherLeg = (legs: readonly [TileEdge, TileEdge], edge: TileEdge): TileEdge =>
  legs[0] === edge ? legs[1] : legs[0];

/**
 * Whether `leg` of `from` opens onto a tile of `blockId` that draws track back
 * across the same boundary. Coupling is mutual (#91), so a same-tinted tile
 * butted alongside without track meeting the boundary does not count.
 */
function leadsIntoBlock(
  from: GeometryTile,
  leg: TileEdge,
  blockId: BlockId,
  byKey: ReadonlyMap<string, GeometryTile>,
): boolean {
  const offset = EDGE_OFFSET[leg];
  const neighbour = byKey.get(`${from.x + offset.dx},${from.y + offset.dy}`);
  if (!neighbour || neighbour.metadata.blockId !== blockId) return false;
  return drawnEdges(neighbour.tileType, neighbour.metadata).has(oppositeEdge(leg));
}

/**
 * What it costs to *arrive* in a block at its boundary tile, one entry per way
 * of doing it (#104).
 *
 * On an ordinary tile: one way, no conditions.
 *
 * On a point tile, every road along the arriving leg counts, and the road's own
 * `when` is the whole cost. There is deliberately no test that the road's other
 * leg leads further into the block, because **the tile is the block**: a tile
 * tinted `Fiddle Yard 1` is part of Fiddle Yard 1's detection section, so a
 * train that has reached it has arrived. Requiring the road to carry on inward
 * is what silently deleted three blocks' connectivity on Westgate Hollow when
 * P1's tile was tinted as the yard it serves.
 *
 * Requiring the road to *exist along the leg* is what remains, and it is the
 * load-bearing half: it is what stops the walk reading a point as "any leg
 * reaches any other" and proposing a conditionless arrival over blades set
 * against it.
 */
function arrivalConditions(
  tile: GeometryTile,
  edge: TileEdge,
  roads: readonly TilePointRoad[],
): PointCondition[][] {
  if (roads.length === 0) return [[]];
  return roadsAlong(tile, edge, roads).map((road) => road.conditions);
}

function walkFrom(
  opening: WalkableOpening,
  start: Port,
  seed: PointCondition[],
  ctx: {
    byKey: ReadonlyMap<string, GeometryTile>;
    openingByPort: ReadonlyMap<string, WalkableOpening>;
    notes: WalkNote[];
    found: CompiledEdge[];
  },
): void {
  const queue: Branch[] = [
    {
      at: opposingPort(start),
      conditions: seed,
      via: [],
      crossesDiamond: false,
      visited: new Set([portKey(start)]),
    },
  ];

  let expanded = 0;

  while (queue.length > 0) {
    const branch = queue.pop()!;

    if (expanded++ > MAX_BRANCHES_PER_OPENING) {
      ctx.notes.push({ kind: 'search-truncated', blockId: opening.blockId, at: opening.at });
      return;
    }

    const here = { x: branch.at.x, y: branch.at.y };
    const tile = ctx.byKey.get(`${here.x},${here.y}`);
    if (!tile) continue; // open air: the line simply ends

    // Coupling is mutual. A tile drawn alongside without any track meeting this
    // boundary is not connected to it — the whole reason this can only exist
    // after #91, and the reason two parallel yard roads yield nothing. `#91`'s
    // `track-not-joined` already reports the drawing fault, so this is silent.
    if (!drawnEdges(tile.tileType, tile.metadata).has(branch.at.edge)) continue;

    const classification = classifyTile(tile.metadata);

    if (classification === 'unclassified') {
      // Walking through untagged track finds wrong things confidently; stopping
      // silently is indistinguishable from "there is no connection". The note is
      // the difference, and it tells the operator that classifying one cell
      // unlocks the proposal.
      ctx.notes.push({ kind: 'blocked-by-unclassified', at: here });
      continue;
    }

    if (classification === 'block') {
      const arrived = ctx.openingByPort.get(portKey(branch.at));

      if (tile.metadata.blockId === opening.blockId) {
        // A block reachable from itself is not a connection to author, and the
        // schema refuses `from_block_id = to_block_id` anyway. Worth a note
        // because a point tile tinted as its own approach block terminates here,
        // and an unexplained absence would look like a bug.
        ctx.notes.push({ kind: 'stopped-in-own-block', blockId: opening.blockId, at: here });
        continue;
      }

      // No check is needed here for arriving at a buffered end, and that is a
      // structural guarantee rather than an omission.
      //
      // #91 gives a terminating tile two contributions: a connection opening for
      // its *stub*, which is the way in, and a terminus on its **closed** side
      // with no port at all — because a closed side is not a boundary anything
      // can cross. A terminated opening therefore has nothing to arrive at, so
      // the walk cannot propose an edge into one however hard it tries.
      //
      // Which is also the right answer physically. A buffer says track goes no
      // further; it does not say the block is unreachable. Arriving through the
      // stub is how you get to the siding. Going *past* it never arises, since
      // the first block always terminates the branch.

      // Arriving *at* a block's point tile costs whatever road carries the
      // arriving leg — and nothing more. Not the mirror of the departure above:
      // the tile is the block, so reaching it is arriving (#104).
      const arrivalRoads = tile.metadata.pointRoads ?? [];
      if (depictsPoint(tile.tileType) && arrivalRoads.length === 0) {
        ctx.notes.push({
          kind: 'blocked-by-unmapped-point',
          at: here,
          pointId: tile.metadata.pointId!,
        });
        continue;
      }

      const entries = arrivalConditions(tile, branch.at.edge, arrivalRoads);

      if (entries.length === 0) {
        // Track reaches this cell and the tile's mapping does not cover the leg
        // it reaches it by. That is an incomplete mapping, not an absent
        // connection, and guessing which position selects a leg nobody mapped is
        // the one guess this walk must never make.
        ctx.notes.push({ kind: 'leg-not-covered-by-road', at: here, edge: branch.at.edge });
        continue;
      }

      for (const entry of entries) {
        const conditions = mergeConditions(branch.conditions, entry);
        if (!conditions) continue; // one path cannot need a point both ways

        ctx.found.push({
          fromBlockId: opening.blockId,
          fromEnd: opening.label,
          toBlockId: tile.metadata.blockId!,
          toEnd: arrived?.label ?? null,
          pointConditions: conditions,
          via: branch.via,
          crossesDiamond: branch.crossesDiamond,
        });
      }
      continue; // first block wins — never continue past it
    }

    // Decorative: traversable, and the case that motivates the feature. The
    // Fiddle Yard reaches the sidings through the entry feeder, which is
    // deliberately part of no block.
    if (branch.via.length >= MAX_COMPILED_PATH_TILES) {
      ctx.notes.push({ kind: 'search-truncated', blockId: opening.blockId, at: here });
      continue;
    }

    const roads = tile.metadata.pointRoads ?? [];
    if (depictsPoint(tile.tileType) && roads.length === 0) {
      // The walk knows it crossed a point but not which position selects which
      // road, and `pointConditions` is the field whose errors are least visible.
      //
      // Gated on tile type for #92's reason: the `straight-45` companion of a
      // point carries the same `pointId` and cannot hold a mapping, so treating
      // it as unmapped would refuse every point on the layout.
      ctx.notes.push({
        kind: 'blocked-by-unmapped-point',
        at: here,
        pointId: tile.metadata.pointId!,
      });
      continue;
    }

    const exits = exitsOf(tile, branch.at.edge, roads);

    if (exits.length === 0 && roads.length > 0) {
      // Same incompleteness as on arrival, met while passing through: the tile
      // draws a leg no road maps. Reported rather than dropped, because a branch
      // that dies here is indistinguishable from a drawing with no connection.
      ctx.notes.push({ kind: 'leg-not-covered-by-road', at: here, edge: branch.at.edge });
      continue;
    }

    for (const exit of exits) {
      const merged = mergeConditions(branch.conditions, exit.conditions);
      if (!merged) continue; // one path cannot need a point both ways

      const exitPort: Port = { x: here.x, y: here.y, edge: exit.edge };
      if (branch.visited.has(portKey(exitPort))) continue;

      queue.push({
        at: opposingPort(exitPort),
        conditions: merged,
        via: [...branch.via, here],
        crossesDiamond: branch.crossesDiamond || tile.tileType === 'crossing',
        visited: new Set([...branch.visited, portKey(branch.at), portKey(exitPort)]),
      });
    }
  }
}

/**
 * The ways out of a tile entered through `entry`, and what each costs in point
 * conditions.
 *
 * Where `pointRoads` is authored it **governs**: the generic leg table is not
 * consulted, because the roads are the statement of which legs exist and which
 * position selects them. A slip or three-way falls out with no special case,
 * since `when` is a list — which is exactly why it was modelled as a position
 * tuple rather than a boolean (`docs/track-grid.md` D9).
 */
function exitsOf(
  tile: GeometryTile,
  entry: TileEdge,
  roads: readonly TilePointRoad[],
): { edge: TileEdge; conditions: PointCondition[] }[] {
  if (roads.length === 0) {
    return exitsFrom(tileLegs(tile.tileType, tile.metadata), entry).map((edge) => ({
      edge,
      conditions: [],
    }));
  }

  const out: { edge: TileEdge; conditions: PointCondition[] }[] = [];

  for (const road of roads) {
    // Roads are stored unrotated, like every leg on the drawing (#73).
    const legs = rotatedLegs(road, tile.metadata);
    for (const exit of exitsFrom([legs], entry)) {
      out.push({
        edge: exit,
        conditions: road.when.map((w) => ({
          pointId: w.pointId,
          requiredPosition: w.position,
        })),
      });
    }
  }

  return out;
}

function rotatedLegs(road: TilePointRoad, metadata: GridTileMetadata): [TileEdge, TileEdge] {
  const rotation = metadata.rotation ?? 0;
  return [rotateEdge(road.legs[0], rotation), rotateEdge(road.legs[1], rotation)];
}

/** `null` when the two sets disagree about a point — no path needs P1 both normal and reverse. */
function mergeConditions(
  existing: readonly PointCondition[],
  added: readonly PointCondition[],
): PointCondition[] | null {
  const byPoint = new Map(existing.map((c) => [c.pointId, c]));

  for (const c of added) {
    const held = byPoint.get(c.pointId);
    if (held && held.requiredPosition !== c.requiredPosition) return null;
    byPoint.set(c.pointId, c);
  }

  return [...byPoint.values()].sort((a, b) => a.pointId.localeCompare(b.pointId));
}

/**
 * Dedupes and pairs the two directions of each connection.
 *
 * **The reverse is never synthesised** (#104). Ordinary track is walked from
 * both blocks' openings and yields both directions on its own, so mirroring
 * would be redundant everywhere it is harmless — and wrong exactly where it is
 * not. Departing a block through a point tile tinted as that block costs a road
 * leading back into the block's interior, which arriving does not; mirroring an
 * arrival into a departure manufactures an edge the drawing refuses, and a route
 * planned over it runs a train through blades set against it.
 *
 * So a one-way row here is a statement, not an oversight: the drawing supports
 * that direction and not the other. Both directions are still offered wherever
 * both exist, and either may be declined.
 */
function dedupeConnections(found: readonly CompiledEdge[]): CompiledEdge[] {
  const best = new Map<string, CompiledEdge>();

  const keyOf = (p: CompiledEdge) =>
    [
      p.fromBlockId,
      p.fromEnd ?? '',
      p.toBlockId,
      p.toEnd ?? '',
      conditionKey(p.pointConditions),
    ].join(SEP);

  const keep = (p: CompiledEdge) => {
    const k = keyOf(p);
    const held = best.get(k);
    // Shortest path wins: the same two blocks reached the long way round is the
    // same connection, and the short `via` is the one that helps an operator
    // find it on the drawing.
    if (!held || p.via.length < held.via.length) best.set(k, p);
  };

  for (const p of found) keep(p);

  // No admission-control check here. The limit belongs to the whole compiled
  // graph, not to the walk's intermediate result, and `compileTrackGraph`
  // applies it — which is where it always should have been: a cap on what an
  // operator can review is a statement about the output, and this function has
  // no idea whether its caller is the compiler or the proposal shim.
  return [...best.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

function sortWalkNotes(notes: readonly WalkNote[]): WalkNote[] {
  const seen = new Set<string>();
  return [...notes]
    .filter((n) => {
      const k = JSON.stringify(n);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
}


// ─── The graph-level layer (D7) ───────────────────────────────────────────────

/**
 * Compiles the whole candidate graph and asserts over its **output**, not over
 * the walk.
 *
 * This ordering is the third instance of the pattern the whole design is built
 * against — a local check standing in for a global property, after the
 * label-as-join-key and the bearing collision. When P1's tile was tinted
 * `Fiddle Yard 1`, the walk emitted three cell-level notes and no statement at
 * all that Fiddle Yard 2, Engine Shed 1 and Siding 3 had become unreachable.
 * The notes were necessary and nowhere near sufficient.
 */
export function compileTrackGraph(input: CompileInput): CompileReport {
  const gaps: CompileGap[] = [];

  for (const u of input.unreadable) {
    // Distinguished from an untagged tile on purpose (D9). `parseTileMetadata`
    // returns `{}` for a corrupt blob, which makes corruption look identical to
    // a to-do. Both block the walk, so both fail safe — but only one of them is
    // something the operator can finish by drawing.
    gaps.push({ kind: 'tile-metadata-unreadable', at: u.at });
  }

  const knownBlocks = new Set(input.blocks.map((b) => b.id));
  const drawnBlocks = new Set<BlockId>();

  for (const tile of input.tiles) {
    const blockId = tile.metadata.blockId;
    if (blockId === undefined) continue;
    if (knownBlocks.has(blockId)) {
      drawnBlocks.add(blockId);
      continue;
    }
    // A tile naming a deleted block. Left in the drawing it is harmless; turned
    // into an edge it becomes an `unknown-block` violation, which is fatal on
    // reload and Safe-Stops the layout. Reported here and excluded below.
    gaps.push({ kind: 'dangling-block-reference', at: { x: tile.x, y: tile.y }, blockId });
  }

  const openings = compileOpenings(input.tiles).filter((o) => knownBlocks.has(o.blockId));
  const { connections, notes } = compileConnections({ tiles: input.tiles, openings });

  for (const note of notes) {
    // `stopped-in-own-block` is dropped rather than carried: since #104 it is an
    // ordinary walk outcome, and the consequence worth reporting is caught by
    // `block-not-in-graph` below.
    if (note.kind === 'stopped-in-own-block') continue;
    gaps.push(note);
  }

  const edges: NamedCompiledEdge[] = [];
  for (const c of connections) {
    if (c.fromEnd === null || c.toEnd === null) {
      // Cannot happen with `compileOpenings`, which names every opening. Kept
      // as a refusal rather than an assertion because the type permits it and a
      // nameless end in `block_edges` is exactly the unreferenceable opening
      // this design exists to abolish.
      const blockId = c.fromEnd === null ? c.fromBlockId : c.toBlockId;
      gaps.push({ kind: 'opening-unnamed', blockId, at: c.via[0] ?? { x: 0, y: 0 } });
      continue;
    }
    if (!knownBlocks.has(c.fromBlockId) || !knownBlocks.has(c.toBlockId)) continue;
    edges.push(c as NamedCompiledEdge);
  }

  if (edges.length > MAX_COMPILED_EDGES) {
    throw new CompileLimitExceededError(MAX_COMPILED_EDGES, edges.length);
  }

  // ── D7's assertions, over the emitted graph ──

  const inGraph = new Set<BlockId>();
  for (const e of edges) {
    inGraph.add(e.fromBlockId);
    inGraph.add(e.toBlockId);
  }

  for (const blockId of [...drawnBlocks].sort()) {
    // "at least one edge", not two: a dead-end siding is a complete railway.
    if (!inGraph.has(blockId)) gaps.push({ kind: 'block-not-in-graph', blockId });
  }

  const detected = new Set(
    input.sensors.filter((s) => s.inService && s.blockId !== null).map((s) => s.blockId as string),
  );
  for (const blockId of [...inGraph].sort()) {
    if (!detected.has(blockId)) gaps.push({ kind: 'block-without-detection', blockId });
  }

  const edgedOpenings = new Set<string>();
  for (const e of edges) {
    edgedOpenings.add(`${e.fromBlockId}${SEP}${e.fromEnd}`);
    edgedOpenings.add(`${e.toBlockId}${SEP}${e.toEnd}`);
  }
  for (const o of openings) {
    if (o.terminated) continue; // a buffer is an answer, not an omission
    if (edgedOpenings.has(`${o.blockId}${SEP}${o.label}`)) continue;
    gaps.push({ kind: 'opening-unresolved', blockId: o.blockId, label: o.label, at: o.at });
  }

  return {
    fingerprint: drawingFingerprint(input),
    edges,
    gaps: sortGaps(gaps),
    components: connectedComponents(drawnBlocks, edges),
  };
}

/**
 * Connected components over the candidate edges, treated as **undirected**.
 *
 * Undirected because the question this answers is "is this railway one piece",
 * and a one-way connection still joins two blocks physically. Reported, never
 * gated: a layout may legitimately hold two separate railways, and gating on it
 * would refuse `auto` forever with nothing for the operator to acknowledge.
 */
function connectedComponents(
  blocks: ReadonlySet<BlockId>,
  edges: readonly NamedCompiledEdge[],
): BlockId[][] {
  const adjacency = new Map<BlockId, Set<BlockId>>();
  for (const b of blocks) adjacency.set(b, new Set());
  for (const e of edges) {
    adjacency.get(e.fromBlockId)?.add(e.toBlockId);
    adjacency.get(e.toBlockId)?.add(e.fromBlockId);
  }

  const seen = new Set<BlockId>();
  const components: BlockId[][] = [];

  for (const start of [...blocks].sort()) {
    if (seen.has(start)) continue;
    const component: BlockId[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const here = stack.pop()!;
      component.push(here);
      for (const next of adjacency.get(here) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    components.push(component.sort());
  }

  return components.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Deterministic order, so a diff between two compiles is a diff in content and never in ordering. */
function sortGaps(gaps: readonly CompileGap[]): CompileGap[] {
  const seen = new Set<string>();
  return [...gaps]
    .filter((g) => {
      const k = JSON.stringify(g);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * A hash over **exactly what the walk reads, and nothing else** (D10).
 *
 * The point is not integrity, it is time-of-check/time-of-use: `apply` carries
 * the fingerprint that was reviewed and is refused if the drawing has moved
 * since. Reviewing one graph and applying another is precisely the shape this
 * design exists to eliminate.
 *
 * So the field list is a contract, not a convenience. `annotations` is excluded
 * because the walk never reads it — placing a sensor marker must not invalidate
 * a review. Coordinates *are* included, though D10's prose omits them: the walk
 * is structured entirely by position, and moving a tile changes what it
 * connects to. An unreadable tile contributes its raw blob, so that repairing
 * corruption moves the fingerprint like any other edit.
 */
export function drawingFingerprint(input: {
  tiles: readonly GeometryTile[];
  unreadable: readonly { at: Coordinate; raw: string }[];
}): string {
  const rows: string[] = [];

  for (const t of [...input.tiles].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const m = t.metadata;
    const roads = [...(m.pointRoads ?? [])]
      .map((r) => {
        const when = [...r.when]
          .sort((a, b) => a.pointId.localeCompare(b.pointId))
          .map((w) => `${w.pointId}=${w.position}`)
          .join(',');
        return `${r.legs[0]}>${r.legs[1]}:${when}`;
      })
      .sort();

    rows.push(
      [
        t.x,
        t.y,
        t.tileType,
        m.rotation ?? 0,
        m.blockId ?? '',
        m.trackRole ?? '',
        m.pointId ?? '',
        roads.join(';'),
      ].join('|'),
    );
  }

  for (const u of [...input.unreadable].sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x)) {
    rows.push(`${u.at.x}|${u.at.y}|!raw:${u.raw}`);
  }

  return createHash('sha256').update(rows.join('\n')).digest('hex');
}
