/**
 * Proposing candidate `block_edges` from the drawing (#78).
 *
 * ## What a proposal is, and what it is not
 *
 * A **candidate row**, for an operator to accept or reject. Nothing here writes.
 * Accepting a proposal means posting it to the ordinary `POST .../edges`, which
 * `TopologyService` validates exactly as it validates a hand-authored edge —
 * there is deliberately no accept endpoint, so no bypass can exist by
 * construction.
 *
 * This does not make the track graph derived. `block_edges` remains authored;
 * this feature only stops the authoring being transcription. The drawing already
 * describes the railway, and typing it out a second time by hand is where the
 * two representations drift apart.
 *
 * ## Why it can only exist after #91
 *
 * The walk moves over tile **ports** — `(x, y, edge)` on a shared boundary — and
 * couples two tiles only when *both* have a leg endpoint there. Under the old
 * adjacency model two yard roads drawn on adjacent rows touched along their
 * whole length, so a cell-based walk would have proposed an edge between every
 * pair of parallel sidings on the layout. A port walk proposes none, because
 * neither tile draws anything across that boundary.
 *
 * ## What is never derived
 *
 * `lengthMm`. Tile count bears no relation to physical extent, so the field is
 * typed as the literal `null` rather than `number | null` — a later change that
 * tries to compute a distance from geometry fails to compile instead of shipping
 * a number the braking model would believe (`docs/topology.md`,
 * `docs/braking.md` B4).
 *
 * ## What is refused rather than guessed
 *
 * A point tile with no leg mapping, a leg no road covers, an unclassified tile,
 * and an opening a buffer has terminated. Each stops the walk and emits a note
 * naming the cell. Silence and refusal look identical from the outside — "no
 * connection found" — so the note is the whole difference between a to-do and a
 * mystery.
 *
 * ## Departing a block and arriving at one are different questions (#104)
 *
 * Both directions of a connection are found by the walk itself, and neither is
 * synthesised from the other, because **they do not cost the same**. Crossing a
 * point tile that carries a `blockId` is asymmetric: leaving the block through
 * it means you came from the block's interior, so the road must join the
 * boundary to a leg leading back into the block; arriving at it means you are in
 * the block the moment you are on the tile, so any road along the arriving leg
 * will do.
 *
 * Treating those as the same question is what made a point tinted as one of its
 * neighbouring blocks delete edges — on Westgate Hollow, three blocks lost their
 * entire connectivity with only cell-level notes to show for it. Mirroring one
 * direction into the other is the same mistake wearing the opposite sign: it
 * manufactures a departure the drawing refuses, which is an edge a route would
 * plan over and a train would run through the blades of.
 *
 * The leg mapping itself is unverifiable authored data (`docs/track-grid.md`
 * D9). Nothing can check which way round a physical point is wired, and a
 * proposal inherits that uncertainty exactly. This feature does not make point
 * wiring checkable; it makes the drawing and the graph state the same thing
 * rather than two different things.
 */

import {
  BlockEdge,
  BlockEnd,
  BlockId,
  GridTileMetadata,
  PointCondition,
  PointId,
  TileEdge,
  TilePointRoad,
  classifyTile,
  depictsPoint,
} from '../domain/types';
import { BlockOpening, Coordinate, GeometryTile } from './gridGeometry';
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
export const MAX_PROPOSAL_PATH_TILES = 32;

/** Live branches from one opening. A fan of points multiplies quickly; this bounds it. */
export const MAX_BRANCHES_PER_OPENING = 64;

/**
 * Admission control on the whole run, in the spirit of `MAX_EDGES_PER_LAYOUT`.
 * A drawing that produces more than this is not one an operator can review, so
 * the honest answer is to refuse rather than render a wall of candidates.
 */
export const MAX_EDGE_PROPOSALS = 200;

export type EdgeProposalStatus = 'new' | 'needs-end-label' | 'existing' | 'conflicting';

export interface EdgeProposal {
  /** Stable within one response; pairs the two directions of one physical connection. */
  pairId: string;
  fromBlockId: BlockId;
  /** `null` when no `block_ends` row names this opening. Never a guessed label. */
  fromEnd: string | null;
  toBlockId: BlockId;
  toEnd: string | null;
  pointConditions: PointCondition[];
  /** Always `null`. The literal type is the guard: geometry can never supply distance. */
  lengthMm: null;
  /** Cells crossed between the two blocks, in walk order, so the operator can find it on the drawing. */
  via: Coordinate[];
  /** The path crosses a plain diamond, whose route conflicts are not detected (#26). */
  crossesDiamond: boolean;
  status: EdgeProposalStatus;
  existingEdgeId?: string;
}

/** Why a connection that looks drawn produced no proposal. Each names a cell to go and look at. */
export type ProposalNote =
  | { kind: 'blocked-by-unclassified'; at: Coordinate }
  | { kind: 'blocked-by-unmapped-point'; at: Coordinate; pointId: PointId }
  | { kind: 'stopped-in-own-block'; blockId: BlockId; at: Coordinate }
  /**
   * The tile draws track on this side, but none of its authored roads use that
   * leg — so the walk cannot say which point position selects it. An incomplete
   * mapping rather than a missing one, which is why it is not
   * `blocked-by-unmapped-point`.
   */
  | { kind: 'leg-not-covered-by-road'; at: Coordinate; edge: TileEdge }
  /**
   * The point offers no road from inside this block out through this boundary
   * (#104). The way in may still exist: arriving is a different question, and a
   * one-way connection is a real thing to report rather than to mirror.
   */
  | { kind: 'no-road-out-of-block'; at: Coordinate; blockId: BlockId; edge: TileEdge }
  | { kind: 'search-truncated'; blockId: BlockId; at: Coordinate };

export interface EdgeProposalReport {
  proposals: EdgeProposal[];
  notes: ProposalNote[];
}

export class ProposalLimitExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly found: number,
  ) {
    super(`Drawing produces ${found} candidate edges, above the ${limit} this surface will render`);
    this.name = 'ProposalLimitExceededError';
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

const endKey = (blockId: string, end: string | null): string => `${blockId}${SEP}${end ?? ''}`;

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
 * Pure, and deliberately ignorant of existing edges — `reconcileProposals` is
 * what compares the result against the graph. Splitting them keeps the walk
 * testable against a hand-built tile array with no repository at all.
 */
export function proposeEdges(input: {
  tiles: readonly GeometryTile[];
  openings: readonly BlockOpening[];
}): EdgeProposalReport {
  const byKey = new Map<string, GeometryTile>();
  for (const t of input.tiles) byKey.set(`${t.x},${t.y}`, t);

  /** Which opening each boundary belongs to, so an arrival can be named. */
  const openingByPort = new Map<string, BlockOpening>();
  for (const o of input.openings) {
    for (const p of o.ports) openingByPort.set(portKey(p), o);
  }

  const notes: ProposalNote[] = [];
  const found: Omit<EdgeProposal, 'pairId' | 'status'>[] = [];

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

  return { proposals: assemble(found), notes: sortNotes(notes) };
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
  opening: BlockOpening,
  start: Port,
  seed: PointCondition[],
  ctx: {
    byKey: ReadonlyMap<string, GeometryTile>;
    openingByPort: ReadonlyMap<string, BlockOpening>;
    notes: ProposalNote[];
    found: Omit<EdgeProposal, 'pairId' | 'status'>[];
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
          lengthMm: null,
          via: branch.via,
          crossesDiamond: branch.crossesDiamond,
        });
      }
      continue; // first block wins — never continue past it
    }

    // Decorative: traversable, and the case that motivates the feature. The
    // Fiddle Yard reaches the sidings through the entry feeder, which is
    // deliberately part of no block.
    if (branch.via.length >= MAX_PROPOSAL_PATH_TILES) {
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
function assemble(found: readonly Omit<EdgeProposal, 'pairId' | 'status'>[]): EdgeProposal[] {
  const best = new Map<string, Omit<EdgeProposal, 'pairId' | 'status'>>();

  const keyOf = (p: Omit<EdgeProposal, 'pairId' | 'status'>) =>
    [
      p.fromBlockId,
      p.fromEnd ?? '',
      p.toBlockId,
      p.toEnd ?? '',
      conditionKey(p.pointConditions),
    ].join(SEP);

  const keep = (p: Omit<EdgeProposal, 'pairId' | 'status'>) => {
    const k = keyOf(p);
    const held = best.get(k);
    // Shortest path wins: the same two blocks reached the long way round is the
    // same connection, and the short `via` is the one that helps an operator
    // find it on the drawing.
    if (!held || p.via.length < held.via.length) best.set(k, p);
  };

  for (const p of found) keep(p);

  if (best.size > MAX_EDGE_PROPOSALS) {
    throw new ProposalLimitExceededError(MAX_EDGE_PROPOSALS, best.size);
  }

  return [...best.values()]
    .map((p) => ({
      ...p,
      pairId: [endKey(p.fromBlockId, p.fromEnd), endKey(p.toBlockId, p.toEnd)]
        .sort()
        .join(SEP)
        .concat(SEP, conditionKey(p.pointConditions)),
      status: 'new' as const,
    }))
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

function sortNotes(notes: readonly ProposalNote[]): ProposalNote[] {
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

/**
 * Sets each proposal's status against the graph as it stands.
 *
 * Existing edges are **reported, not filtered out**. Silence is
 * indistinguishable from "not found", and "the graph already agrees with the
 * drawing" is the most valuable thing this surface can tell an operator about a
 * layout that is partly authored.
 *
 * Note the order: end labels with no `block_ends` row are cleared *first*, so a
 * proposal naming an end nobody has stored can never match an existing edge and
 * lands as `needs-end-label` rather than `new`.
 */
export function reconcileProposals(
  proposals: readonly EdgeProposal[],
  existingEdges: readonly BlockEdge[],
  ends: readonly BlockEnd[],
): EdgeProposal[] {
  const stored = new Set(ends.map((e) => `${e.blockId} ${e.label}`));

  const byConnection = new Map<string, BlockEdge>();
  for (const edge of existingEdges) {
    byConnection.set(
      [edge.fromBlockId, edge.fromEnd, edge.toBlockId, edge.toEnd].join(SEP),
      edge,
    );
  }

  return proposals.map((p) => {
    const fromEnd = p.fromEnd && stored.has(`${p.fromBlockId} ${p.fromEnd}`) ? p.fromEnd : null;
    const toEnd = p.toEnd && stored.has(`${p.toBlockId} ${p.toEnd}`) ? p.toEnd : null;
    const next = { ...p, fromEnd, toEnd };

    if (fromEnd === null || toEnd === null) {
      return { ...next, status: 'needs-end-label' as const };
    }

    // Keyed on the full four-part tuple, never on `(fromBlockId, fromEnd)` —
    // that pair is deliberately not unique, because one opening fans out to
    // several blocks through a point, and keying on it would collapse every
    // point fan-out into a single false conflict.
    const existing = byConnection.get([p.fromBlockId, fromEnd, p.toBlockId, toEnd].join(SEP));
    if (!existing) return { ...next, status: 'new' as const };

    const sameConditions =
      conditionKey(existing.pointConditions) === conditionKey(p.pointConditions);

    return {
      ...next,
      // Length is never part of the comparison: an authored `lengthMm` against a
      // proposal's `null` is not a disagreement, it is measurement the drawing
      // could never have supplied.
      status: sameConditions ? ('existing' as const) : ('conflicting' as const),
      existingEdgeId: existing.id,
    };
  });
}
