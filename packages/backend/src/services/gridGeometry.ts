/**
 * Grid geometry — deriving where a block's openings are, and what to call them
 * (#72), from the Track Editor's drawing.
 *
 * ## Why this lives in `services/` and not `domain/`
 *
 * `domain/` depends on nothing and decides everything that matters: routes,
 * occupancy, Safe-Stop. #84 states the rule outright — *nothing in `domain/`
 * should start reading tiles*. These functions read tiles, so they stay out,
 * even though they are pure and would otherwise look at home there. The
 * separation is the guardrail: a later change cannot accidentally wire drawn
 * geometry into a routing decision, because the routing code cannot import
 * this file's neighbourhood.
 *
 * Pure regardless — plain data in, plain data out, no repository, no I/O — so
 * it is unit-testable without a database and reusable by the shared renderer
 * when #75 lands.
 *
 * ## What an opening is
 *
 * A place the block's **drawn track leaves the run** — through a tile edge the
 * drawing touches, given tile type and rotation (`./tileGeometry`). Not a place
 * a neighbouring cell happens to belong to something else.
 *
 * That distinction is #91. Two parallel roads of a yard touch along their whole
 * length and connect nowhere; under the old adjacency rule every tile of both
 * read as an opening, the whole siding fused into one phantom end at its middle,
 * and the two real ends vanished. Connectivity is mutual — the neighbour's own
 * drawn edges must include the opposite edge — so track butted against a tile
 * that draws nothing back is an end, reported by `findUnjoinedEdges`.
 *
 * ## What a generated label means, and what it does not
 *
 * A cardinal end label **describes the diagram, not the railway**. The drawing
 * is explicitly not to scale (#71) and "north at the top" is a drawing
 * convention, not a compass reading. If the diagram is ever re-laid or
 * rotated, a *generated* label regenerates to match — but a *pinned* one does
 * not, and neither do the `block_edges` rows referencing either.
 *
 * That is correct: an end label is a name, and once an edge references it, its
 * meaning is frozen. The consequence is that a block end called `north` can
 * end up pointing east on the drawing. Do not "fix" that — rewriting the label
 * rewrites the track graph as a side effect.
 *
 * ## What is never derived from here
 *
 * Length. Tile count bears no relation to physical extent — the Westgate
 * Hollow entry feeder is drawn long and is short in reality. `block_edges.
 * lengthMm` stays authored and nullable-means-unmeasured (`docs/braking.md`
 * B4). Geometry can propose *connectivity*; it can never supply *distance*.
 *
 * ## The walk and the naming policy are separate (#103)
 *
 * `rawOpenings` is the walk; what happens when a bearing collides or comes
 * back `null` is a decision for the caller, not the walk. There were two such
 * policies. `generateBlockEnds` **refused** — a `block_ends` row was an
 * identifier a later edge could be typed against wrong, so guessing was never
 * safe — and `compileOpenings` **disambiguates**, per D-I of
 * `docs/track-graph-compilation.md`. The first is deleted (#103 PR 7), and the
 * split is why replacing it touched no geometry at all: an end
 * label is disposable compiler output under D8, referenced by nothing between
 * compiles, so the one thing that made refusal necessary is gone. It never
 * refuses and never drops an opening.
 */

import {
  BlockId,
  CARDINAL_END_LABELS,
  CardinalEndLabel,
  GridTileMetadata,
  TileEdge,
  TileType,
  classifyTile,
} from '../domain/types';
import { EDGE_OFFSET, Port, drawnEdges, oppositeEdge, terminatesTrack } from './tileGeometry';
import { parseTileMetadata } from './validation';

/** The minimum a tile must expose for any of this. Parsed metadata, not the raw JSON column. */
export interface GeometryTile {
  x: number;
  y: number;
  tileType: TileType;
  metadata: GridTileMetadata;
}

export interface Coordinate {
  x: number;
  y: number;
}

/**
 * One place a block opens.
 *
 * Was the disposable-output twin of `BlockOpening`, which #72 used for a
 * `block_ends` row and which is deleted (#103 PR 7). The difference between
 * them was the whole issue: that one **refused** a name it could not resolve
 * uniquely, because the name was an identifier a later edge would be typed
 * against; this one never refuses and never drops an opening, because nothing
 * references a label across a redraw (D8). `GET
 * .../grid/openings` (D-H) returns these directly — pure geometry, no walk.
 */
export interface CompiledOpening {
  blockId: BlockId;
  /** Disposable compiler output (D8). 8-point cardinal, suffixed `-1`…`-n` when a block has several facing the same way. */
  label: string;
  /** A tile of the block, where a label may be drawn. */
  at: Coordinate;
  terminated: boolean;
  /** The tile boundaries this opening covers. Empty for a buffer's closed side. */
  ports: Port[];
}

/** 8-connected, matching `findBlockRuns` in the frontend: a 45° run of track is one block, not a chain of islands. */
const NEIGHBOURS: readonly Coordinate[] = [
  { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
  { x: -1, y: 0 },                   { x: 1, y: 0 },
  { x: -1, y: 1 },  { x: 0, y: 1 },  { x: 1, y: 1 },
];

const key = (x: number, y: number) => `${x},${y}`;

/**
 * The 8-point label a vector points in, with **north at the top of the
 * diagram** — so `y` decreasing is north, which is screen convention, not
 * mathematical convention.
 *
 * Returns `null` for a zero vector, which the caller must handle rather than
 * be handed an arbitrary direction: a zero bearing means the opening sits
 * exactly on the run's centroid, and inventing "north" for it would put a
 * wrong name on an edge.
 */
export function bearingLabel(dx: number, dy: number): CardinalEndLabel | null {
  if (dx === 0 && dy === 0) return null;
  // atan2(east, north) — 0 = north, +π/2 = east, matching the clockwise order
  // of CARDINAL_END_LABELS so the index is the compass point.
  const angle = Math.atan2(dx, -dy);
  const step = (2 * Math.PI) / CARDINAL_END_LABELS.length;
  const index = ((Math.round(angle / step) % 8) + 8) % 8;
  return CARDINAL_END_LABELS[index];
}

/** Contiguous stretches of one block, 8-connected. A block drawn in two disconnected places yields two runs — and each has its own ends. */
export interface BlockRun {
  blockId: BlockId;
  tiles: Coordinate[];
}

/**
 * Groups block-classified tiles into runs.
 *
 * Only tiles that `classifyTile` calls `block` take part. A decorative tile
 * (#71) is deliberately not part of any block and must not extend one; an
 * unclassified tile is unfinished and must not either — silently absorbing it
 * would hide it from the very to-do list the classification exists to produce.
 */
export function findBlockRuns(tiles: readonly GeometryTile[]): BlockRun[] {
  const members = new Map<string, GeometryTile>();
  for (const t of tiles) {
    if (classifyTile(t.metadata) === 'block') members.set(key(t.x, t.y), t);
  }

  const seen = new Set<string>();
  const runs: BlockRun[] = [];

  for (const [startKey, start] of members) {
    if (seen.has(startKey)) continue;
    const blockId = start.metadata.blockId!;
    const group: Coordinate[] = [];
    const queue: GeometryTile[] = [start];
    seen.add(startKey);

    while (queue.length > 0) {
      const tile = queue.pop()!;
      group.push({ x: tile.x, y: tile.y });
      for (const d of NEIGHBOURS) {
        const nKey = key(tile.x + d.x, tile.y + d.y);
        if (seen.has(nKey)) continue;
        const neighbour = members.get(nKey);
        if (!neighbour || neighbour.metadata.blockId !== blockId) continue;
        seen.add(nKey);
        queue.push(neighbour);
      }
    }

    group.sort((a, b) => a.y - b.y || a.x - b.x);
    runs.push({ blockId, tiles: group });
  }

  return runs.sort(
    (a, b) => a.blockId.localeCompare(b.blockId) || a.tiles[0].y - b.tiles[0].y || a.tiles[0].x - b.tiles[0].x,
  );
}

/**
 * One place drawn track leaves a run, clustered and bearing-labelled, before
 * disambiguation.
 *
 * `label` is nullable — a cluster sitting exactly on its run's centroid has no
 * honest bearing (`bearingLabel` says so). `generateBlockEnds` used to drop
 * those, refusing rather than guessing at an identifier; `compileOpenings`
 * (D-I) falls back instead, because once a label is disposable compiler output
 * there is no reason left to throw away a real, trafficable opening for want of
 * a name.
 */
interface RawOpening {
  blockId: BlockId;
  at: Coordinate;
  label: CardinalEndLabel | null;
  terminated: boolean;
  ports: Port[];
}

/**
 * One place drawn track leaves a run, before it has been named.
 *
 * **One per drawn tile edge, not one per tile** (#91). The previous model
 * produced one per tile, on the reasoning that a junction cell touches its
 * neighbour on up to three of eight *sides* — but that was a consequence of
 * counting adjacency. Under connectivity the unit is a leg, and two legs
 * leading to two different blocks are two different places the block opens.
 * Adjacent openings facing the same way are still fused into one end below.
 */
interface RunOpening {
  at: Coordinate;
  /** Half a cell toward what lies beyond, so the bearing maths downstream is unchanged. */
  outward: Coordinate;
  /** Only a terminating tile sets this (see the buffer rule in `runOpenings`). */
  terminated: boolean;
  /** The boundary this opening is at. `null` for a buffer's closed side, which has no boundary (#78). */
  port: Port | null;
}

/**
 * Every place drawn track leaves a run, clustered by direction and
 * bearing-labelled, before either caller decides what to do with a collision
 * or a zero bearing.
 *
 * An opening is a place **drawn track leaves the run** — see `runOpenings` for
 * the rule. Adjacency plays no part: two blocks drawn side by side touch along
 * their whole length and connect nowhere.
 *
 * The bearing runs from the *run's* centroid, not the block's: a block drawn
 * in two disconnected places has two centroids, and averaging them puts the
 * origin in the gap between, which points every opening the wrong way.
 *
 * Kept separate from `compileOpenings` below even though that is now its only
 * caller: the walk that finds an opening is one thing, and what is done with a
 * name it cannot resolve is a policy. There were two such policies — refuse
 * (#72) and disambiguate (#103) — and the split is why replacing one with the
 * other touched no geometry at all.
 */
function rawOpenings(tiles: readonly GeometryTile[]): RawOpening[] {
  const byKey = new Map<string, GeometryTile>();
  const edgesByKey = new Map<string, ReadonlySet<TileEdge>>();
  for (const t of tiles) {
    byKey.set(key(t.x, t.y), t);
    // Rotation applied once, here. Every question below is asked of the tile as
    // drawn, not as authored.
    edgesByKey.set(key(t.x, t.y), drawnEdges(t.tileType, t.metadata));
  }

  const raw: RawOpening[] = [];

  for (const run of findBlockRuns(tiles)) {
    const memberKeys = new Set(run.tiles.map((t) => key(t.x, t.y)));
    const cx = run.tiles.reduce((s, t) => s + t.x, 0) / run.tiles.length;
    const cy = run.tiles.reduce((s, t) => s + t.y, 0) / run.tiles.length;

    const openings = runOpenings(run, memberKeys, byKey, edgesByKey, { x: cx, y: cy });

    // Adjacent openings facing the same way are ONE opening. A block meeting
    // its neighbour along a three-cell face has one end there, not three — and
    // three generated labels for one physical opening is worse than none,
    // because an edge then references a name for a place that does not exist.
    //
    // Facing the same way is not optional: on a two-tile block the west end
    // and the east end are adjacent cells, and adjacency alone would fuse the
    // two opposite ends of the block into a single mid-pointing one.
    for (const cluster of clusterTiles(openings, sameDirection)) {
      const px =
        cluster.reduce((s, o) => s + o.at.x + o.outward.x, 0) / cluster.length;
      const py =
        cluster.reduce((s, o) => s + o.at.y + o.outward.y, 0) / cluster.length;

      raw.push({
        blockId: run.blockId,
        at: representative(cluster.map((o) => o.at)),
        // `null` when the cluster sits exactly on the centroid — see
        // `RawOpening`. Left in rather than filtered here, because only the
        // caller knows whether that is a refusal or a fallback chain.
        label: bearingLabel(px - cx, py - cy),
        terminated: allTerminated(cluster),
        ports: cluster.map((o) => o.port).filter((p): p is Port => p !== null),
      });
    }
  }

  return raw;
}

/**
 * The `TileEdge` a `CompiledOpening`'s ports use most, named by its
 * positional `CardinalEndLabel` — D-I's second fallback rung, for a cluster
 * whose bearing is `null`.
 *
 * Object key order below **is** `TILE_EDGES`' clockwise order, which is what
 * makes it double as `portDerivedLabel`'s tie-break: deterministic is all
 * D-I asks for, and the drawing has no opinion about which of two equally
 * common edges should win.
 */
const EDGE_CARDINAL: Readonly<Record<TileEdge, CardinalEndLabel>> = {
  n: 'north',
  ne: 'northeast',
  e: 'east',
  se: 'southeast',
  s: 'south',
  sw: 'southwest',
  w: 'west',
  nw: 'northwest',
};

function portDerivedLabel(ports: readonly Port[]): CardinalEndLabel | null {
  if (ports.length === 0) return null; // a buffer's closed side — nothing to derive from

  const counts = new Map<TileEdge, number>();
  for (const p of ports) counts.set(p.edge, (counts.get(p.edge) ?? 0) + 1);

  let best: TileEdge | null = null;
  let bestCount = 0;
  for (const edge of Object.keys(EDGE_CARDINAL) as TileEdge[]) {
    const count = counts.get(edge) ?? 0;
    if (count > bestCount) {
      best = edge;
      bestCount = count;
    }
  }

  return best && EDGE_CARDINAL[best];
}

/**
 * D-I's fallback chain, collapsed to the single string two openings are
 * compared by before disambiguation: the generated bearing, or — for the
 * openings `generateBlockEnds` used to drop — the cardinal name of the
 * boundary its ports mostly use, or, failing that (no ports at all: a
 * terminated opening sitting on its own run's centroid), the literal
 * `opening`. All three satisfy `blockEndLabelSchema`.
 */
function openingBaseLabel(raw: RawOpening): string {
  return raw.label ?? portDerivedLabel(raw.ports) ?? 'opening';
}

/**
 * One place drawn track leaves a block, named and never dropped (D8, D-I).
 *
 * `generateBlockEnds` refused a bearing collision and silently lost a
 * zero-bearing opening, because a `block_ends` row was an *identifier* a
 * later edge could be typed against wrong — guessing was the one thing it
 * must never do. Under #103 a label is disposable compiler output with
 * nothing referencing it between compiles (D8), so the same guess that used
 * to be a hazard is now merely cosmetic, and refusing to name a real,
 * trafficable opening only throws away information this walk already has.
 *
 * So: every raw opening is named. A collision within one `(blockId,
 * baseLabel)` is resolved with a stable `-1`…`-n` suffix, ordered by the
 * cluster's own `(y, x)` so a redraw that does not move these openings does
 * not renumber them either.
 */
/** A stored tile row, as both readers of the drawing receive it. */
export interface StoredTileRow {
  x: number;
  y: number;
  tileType: string;
  metadata: string;
}

/**
 * Turns stored tile rows into the shape the geometry works on, reporting the
 * ones whose metadata would not parse.
 *
 * Lived in `BlockEndService` until #103 PR 7 deleted it, and was open-coded a
 * second and third time in `GridService.diagnose` and `CompileService`. It is
 * geometry — it was only in the service because that is where it was first
 * needed — and the two surviving callers want exactly the same two things out
 * of it.
 *
 * Metadata is parsed **tolerantly** (`docs/track-grid.md` D10): a blob that
 * predates #70's closed schema reads as `{}` and takes no part in run
 * detection, rather than making the whole screen 500. That is why `unreadable`
 * is returned rather than thrown — the tile still draws, and both callers
 * report it rather than swallowing it. `raw` rides along so the compile
 * fingerprint moves when corruption is repaired (D-G); the diagnostics ignore
 * it and want only the coordinate.
 */
export function readDrawing(rows: readonly StoredTileRow[]): {
  tiles: GeometryTile[];
  unreadable: { at: Coordinate; raw: string }[];
} {
  const tiles: GeometryTile[] = [];
  const unreadable: { at: Coordinate; raw: string }[] = [];

  for (const row of rows) {
    const parsed = parseTileMetadata(row.metadata);
    // `ok`, not a catch: `parseTileMetadata` degrades rather than throwing, so
    // a `try` here would never fire and every tile would read as fine.
    if (!parsed.ok) unreadable.push({ at: { x: row.x, y: row.y }, raw: row.metadata });
    tiles.push({
      x: row.x,
      y: row.y,
      tileType: row.tileType as GeometryTile['tileType'],
      metadata: parsed.metadata,
    });
  }

  return { tiles, unreadable };
}

export function compileOpenings(tiles: readonly GeometryTile[]): CompiledOpening[] {
  const groups = new Map<string, RawOpening[]>();

  for (const raw of rawOpenings(tiles)) {
    const k = `${raw.blockId}\u0000${openingBaseLabel(raw)}`;
    const list = groups.get(k);
    if (list) list.push(raw);
    else groups.set(k, [raw]);
  }

  const out: CompiledOpening[] = [];

  for (const group of groups.values()) {
    // (y, x), the same tie-break `representative` and `findBlockRuns` use, so
    // the same drawing always numbers a collision the same way.
    const ordered = [...group].sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x);
    const base = openingBaseLabel(ordered[0]);

    ordered.forEach((raw, index) => {
      out.push({
        blockId: raw.blockId,
        label: ordered.length === 1 ? base : `${base}-${index + 1}`,
        at: raw.at,
        terminated: raw.terminated,
        ports: raw.ports,
      });
    });
  }

  return out.sort(
    (a, b) => a.blockId.localeCompare(b.blockId) || a.label.localeCompare(b.label),
  );
}

/**
 * Every place drawn track leaves one run, one per drawn tile edge.
 *
 * The rule, per member tile, per edge its track touches:
 *
 * | the drawn edge faces | result |
 * |---|---|
 * | a tile of this run whose own track meets it | internal — nothing |
 * | a tile of another run whose own track meets it | a **connection** opening |
 * | an empty cell | a **terminus** opening (open air) |
 * | an occupied cell whose track does *not* meet it | a **terminus** opening |
 *
 * "Meets it" is mutual: the neighbour's own rotated edge set must contain the
 * opposite edge. A tile that merely sits alongside another asserts nothing,
 * which is the whole of #91.
 *
 * The last row is the case an operator would not predict from looking at the
 * drawing, so `findUnjoinedEdges` reports it separately as `track-not-joined`.
 *
 * **The buffer rule.** A `buffer` draws a stub to one edge and a stop block at
 * the centre, asserting that track ends here. So it contributes a connection
 * opening if its stub joins another run's track, and then exactly one terminus
 * on its *closed* side — but never an open-air opening from the stub itself. It
 * cannot both end the track and have track leaving both ways.
 */
function runOpenings(
  run: BlockRun,
  memberKeys: ReadonlySet<string>,
  byKey: ReadonlyMap<string, GeometryTile>,
  edgesByKey: ReadonlyMap<string, ReadonlySet<TileEdge>>,
  centroid: Coordinate,
): RunOpening[] {
  const out: RunOpening[] = [];

  for (const m of run.tiles) {
    const tile = byKey.get(key(m.x, m.y))!;
    const edges = edgesByKey.get(key(m.x, m.y))!;
    const terminating = terminatesTrack(tile.tileType);

    for (const edge of edges) {
      const offset = EDGE_OFFSET[edge];
      const nKey = key(m.x + offset.dx, m.y + offset.dy);
      const neighbourEdges = edgesByKey.get(nKey);
      const joins = neighbourEdges?.has(oppositeEdge(edge)) ?? false;

      if (joins && memberKeys.has(nKey)) continue; // stays inside the block

      // A terminating tile's stub never opens into open air or into a wall.
      if (!joins && terminating) continue;

      out.push({
        at: m,
        // Half a cell toward the neighbouring cell: the midpoint of the
        // handover, which points outward whichever side the neighbour is on.
        outward: { x: offset.dx / 2, y: offset.dy / 2 },
        terminated: false,
        port: { x: m.x, y: m.y, edge },
      });
    }

    if (!terminating) continue;

    // The closed side is the direction the stop block faces: away from the mean
    // of the edges the stub touches.
    const closed = meanOffset(edges);
    out.push({
      at: m,
      outward:
        closed === null
          ? // No drawn edge at all — only reachable for a terminating type with
            // an empty edge set, which nothing in the palette produces today.
            // Fall back to the old dead-end vector rather than inventing one.
            { x: m.x - centroid.x, y: m.y - centroid.y }
          : { x: -closed.x / 2, y: -closed.y / 2 },
      terminated: true,
      // The closed side of a buffer is not a boundary anything can cross, so it
      // has no port. A walk can never arrive here, which is the intent.
      port: null,
    });
  }

  return out;
}

/** Drawn track that stops against a tile which has nothing meeting it. */
export interface UnjoinedEdge {
  at: Coordinate;
  edge: TileEdge;
  /** The cell it butts against. Always occupied — open air is a legitimate line end, not a fault. */
  against: Coordinate;
}

/**
 * Finds every place one tile's drawn track runs into another tile that draws
 * nothing back (#91).
 *
 * This is the one case in the connectivity model an operator would not predict
 * from looking at the drawing: the track appears continuous, and the block
 * quietly ends there. The diagnostics report it as `track-not-joined` so the
 * end has an explanation rather than looking like a generator bug.
 *
 * Over **all** tiles, not only block ones. The run walk in `rawOpenings`
 * only iterates block-classified tiles, so it would miss a decorative tile
 * drawing into a block tile that does not meet it — and that is the direction
 * the mistake usually points, since decorative track is the stuff drawn last.
 *
 * Both sides of a mismatch are reported, from each tile that draws into the
 * other. That is intentional: they are two different cells to go and look at.
 */
export function findUnjoinedEdges(tiles: readonly GeometryTile[]): UnjoinedEdge[] {
  const edgesByKey = new Map<string, ReadonlySet<TileEdge>>();
  for (const t of tiles) edgesByKey.set(key(t.x, t.y), drawnEdges(t.tileType, t.metadata));

  const out: UnjoinedEdge[] = [];

  for (const t of tiles) {
    for (const edge of edgesByKey.get(key(t.x, t.y))!) {
      const offset = EDGE_OFFSET[edge];
      const against = { x: t.x + offset.dx, y: t.y + offset.dy };
      const neighbour = edgesByKey.get(key(against.x, against.y));

      // Nothing there at all is a line end, which is ordinary and often
      // deliberate. Only track meeting a wall is a finding.
      if (!neighbour) continue;
      if (neighbour.has(oppositeEdge(edge))) continue;

      out.push({ at: { x: t.x, y: t.y }, edge, against });
    }
  }

  // Sorted so the diagnostics list does not reshuffle between polls.
  return out.sort((a, b) => a.at.y - b.at.y || a.at.x - b.at.x || a.edge.localeCompare(b.edge));
}

function meanOffset(edges: ReadonlySet<TileEdge>): Coordinate | null {
  if (edges.size === 0) return null;
  let x = 0;
  let y = 0;
  for (const e of edges) {
    x += EDGE_OFFSET[e].dx;
    y += EDGE_OFFSET[e].dy;
  }
  return { x: x / edges.size, y: y / edges.size };
}

/**
 * An end is a finished dead end only if **every** opening making it up is
 * terminated.
 *
 * Deliberately not `some()`, which is one of the mechanisms of #91: a single
 * buffer tile marked a whole fused siding as finished, which suppressed
 * `end-unfinished` on a layout with no authored edges at all. It stays wrong
 * under the connectivity model for a real shape — a handover face where one cell
 * is buffered and the next continues into another block reads as "finished"
 * under `some()`, and would raise a false `buffer-contradicted-by-edge` the
 * moment that edge was authored.
 */
function allTerminated(openings: readonly { terminated: boolean }[]): boolean {
  return openings.every((o) => o.terminated);
}

/**
 * Splits anything positioned into groups whose tiles are 8-adjacent (or
 * identical).
 *
 * Used twice, for two different questions that happen to be the same shape:
 * which opening tiles of a run form one physical opening, and whether two
 * openings sharing a generated label are really one place or two.
 */
function clusterTiles<T extends { at: Coordinate }>(
  items: readonly T[],
  compatible: (a: T, b: T) => boolean = () => true,
): T[][] {
  const clusters: T[][] = [];

  for (const item of items) {
    const touching = clusters.filter((c) =>
      c.some(
        (other) =>
          Math.abs(other.at.x - item.at.x) <= 1 &&
          Math.abs(other.at.y - item.at.y) <= 1 &&
          compatible(other, item),
      ),
    );

    if (touching.length === 0) {
      clusters.push([item]);
      continue;
    }

    // Adding one item can bridge two clusters that were previously apart.
    const merged = touching.flat();
    merged.push(item);
    for (const c of touching) clusters.splice(clusters.indexOf(c), 1);
    clusters.push(merged);
  }

  return clusters;
}

/**
 * Whether two opening tiles face compatibly enough to be one opening.
 *
 * A positive dot product — anything within 90° of each other. Deliberately
 * loose: a curved handover face has neighbouring cells pointing several
 * degrees apart and is still one opening. What it reliably rejects is the
 * opposite pair, which is the case that matters.
 */
function sameDirection(a: RunOpening, b: RunOpening): boolean {
  return a.outward.x * b.outward.x + a.outward.y * b.outward.y > 0;
}

/** The cluster member nearest its own mean, so the label lands on a real tile. Ties break on (y, x) to stay deterministic across reloads. */
function representative(points: readonly Coordinate[]): Coordinate {
  const mx = points.reduce((s, p) => s + p.x, 0) / points.length;
  const my = points.reduce((s, p) => s + p.y, 0) / points.length;

  let best = points[0];
  let bestD = Infinity;
  for (const p of points) {
    const d = (p.x - mx) ** 2 + (p.y - my) ** 2;
    if (d < bestD || (d === bestD && (p.y < best.y || (p.y === best.y && p.x < best.x)))) {
      best = p;
      bestD = d;
    }
  }
  return { x: best.x, y: best.y };
}
