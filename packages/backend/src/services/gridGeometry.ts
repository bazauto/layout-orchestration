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
 * One opening of a block: a place its drawn track stops being that block.
 *
 * `terminated` is #84's whole contribution. A buffer tile drawn at an opening
 * asserts "track ends here, nothing continues beyond" — which turns a block
 * end with no edges from *ambiguous* (deliberate dead end, or an edge nobody
 * has authored yet) into a fact. On Westgate Hollow the buffers are already
 * drawn at every siding and yard road; they were simply inert.
 */
export interface BlockOpening {
  blockId: BlockId;
  label: CardinalEndLabel;
  /** A tile **of the block**, where the editor draws the label. Never a computed mean, which for an L-shaped run falls in the hole. */
  at: Coordinate;
  terminated: boolean;
  /**
   * The tile boundaries this opening actually covers (#78).
   *
   * An end is frequently several cells wide — a three-cell handover face is one
   * opening — so "which end did I arrive at?" cannot be answered by comparing
   * against `at`, which is only the cell the *label* is drawn on. The ports are
   * the exact set, so the lookup is an equality test rather than a proximity
   * guess. Empty for the synthetic terminus a buffer contributes on its closed
   * side: there is no boundary there, which is the point of it.
   */
  ports: Port[];
}

/**
 * A bearing the generator refused rather than guessed at: two openings of one
 * block that are not adjacent to each other but face the same way.
 *
 * Refusing is the decision from #72, over suffixing (`east`, `east_2`) or
 * falling back to a finer bearing. A silently suffixed label is exactly the
 * kind that gets typed wrong later in an edge, and the manual override exists
 * for precisely this case — so the honest move is to say which end could not
 * be named and let the author name it.
 */
export interface EndLabelCollision {
  blockId: BlockId;
  label: CardinalEndLabel;
  /** Each contending opening, so the editor can point at them on the diagram. */
  at: Coordinate[];
}

export interface GeneratedEnds {
  openings: BlockOpening[];
  collisions: EndLabelCollision[];
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

/** An opening before it has been grouped into a named end. */
interface RawOpening {
  blockId: BlockId;
  at: Coordinate;
  label: CardinalEndLabel;
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
 * Derives every block's openings and their generated cardinal labels.
 *
 * An opening is a place **drawn track leaves the run** — see `runOpenings` for
 * the rule. Adjacency plays no part: two blocks drawn side by side touch along
 * their whole length and connect nowhere.
 *
 * The bearing runs from the *run's* centroid, not the block's: a block drawn
 * in two disconnected places has two centroids, and averaging them puts the
 * origin in the gap between, which points every opening the wrong way.
 */
export function generateBlockEnds(tiles: readonly GeometryTile[]): GeneratedEnds {
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

      const label = bearingLabel(px - cx, py - cy);
      if (!label) continue; // sits exactly on the centroid — no honest direction

      raw.push({
        blockId: run.blockId,
        at: representative(cluster.map((o) => o.at)),
        label,
        terminated: allTerminated(cluster),
        ports: cluster.map((o) => o.port).filter((p): p is Port => p !== null),
      });
    }
  }

  return groupOpenings(raw);
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
 * Over **all** tiles, not only block ones. The run walk in `generateBlockEnds`
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
 * Collapses raw openings into one named end per (block, bearing), and splits
 * out the bearings that cannot be named.
 *
 * Several raw openings almost always describe one physical end — a throat tile
 * touches its neighbour block on three of eight sides. They are one end when
 * their tiles are adjacent to each other. Two openings of one block that face
 * the same way from *different* places are two ends wanting one name, which is
 * the collision #72 refuses.
 */
function groupOpenings(raw: readonly RawOpening[]): GeneratedEnds {
  const byBlockLabel = new Map<string, RawOpening[]>();
  for (const o of raw) {
    const k = `${o.blockId} ${o.label}`;
    const list = byBlockLabel.get(k);
    if (list) list.push(o);
    else byBlockLabel.set(k, [o]);
  }

  const openings: BlockOpening[] = [];
  const collisions: EndLabelCollision[] = [];

  for (const group of byBlockLabel.values()) {
    const clusters = clusterTiles(group);

    if (clusters.length > 1) {
      collisions.push({
        blockId: group[0].blockId,
        label: group[0].label,
        at: clusters.map((c) => representative(c.map((o) => o.at))),
      });
      continue;
    }

    const cluster = clusters[0];
    openings.push({
      blockId: cluster[0].blockId,
      label: cluster[0].label,
      at: representative(cluster.map((o) => o.at)),
      terminated: allTerminated(cluster),
      ports: cluster.flatMap((o) => o.ports),
    });
  }

  return {
    openings: openings.sort(
      (a, b) => a.blockId.localeCompare(b.blockId) || a.label.localeCompare(b.label),
    ),
    collisions: collisions.sort(
      (a, b) => a.blockId.localeCompare(b.blockId) || a.label.localeCompare(b.label),
    ),
  };
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
