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
  TileType,
  classifyTile,
} from '../domain/types';

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
}

/**
 * A tile of a run through which the block opens, and which way it faces.
 *
 * `outward` is the mean offset toward whatever is on the other side, averaged
 * over that tile's foreign neighbours — **one per tile, not one per
 * direction**. A cell at a junction touches its neighbour block on up to three
 * of eight sides, and treating those as three openings would generate three
 * end labels where the railway has one opening.
 */
interface OpeningTile {
  at: Coordinate;
  outward: Coordinate;
  terminated: boolean;
}

/**
 * Derives every block's openings and their generated cardinal labels.
 *
 * Two things count as an opening, and both are needed:
 *
 * - a **contact**: a tile of the block sitting next to a tile that is not of
 *   that block. This is where the block hands over — to another block, or to
 *   the undetected plain track #71 is about.
 * - a **terminus**: a tile of the block with at most one drawn neighbour of
 *   any kind, i.e. the end of a line. Without this a siding ending in buffers
 *   would produce no end at all, since it touches nothing foreign — and that
 *   dead end is exactly the one #84 wants to distinguish from an unauthored
 *   edge.
 *
 * The bearing runs from the *run's* centroid, not the block's: a block drawn
 * in two disconnected places has two centroids, and averaging them puts the
 * origin in the gap between, which points every opening the wrong way.
 */
export function generateBlockEnds(tiles: readonly GeometryTile[]): GeneratedEnds {
  const byKey = new Map<string, GeometryTile>();
  for (const t of tiles) byKey.set(key(t.x, t.y), t);

  const raw: RawOpening[] = [];

  for (const run of findBlockRuns(tiles)) {
    const memberKeys = new Set(run.tiles.map((t) => key(t.x, t.y)));
    const cx = run.tiles.reduce((s, t) => s + t.x, 0) / run.tiles.length;
    const cy = run.tiles.reduce((s, t) => s + t.y, 0) / run.tiles.length;

    const openingTiles: OpeningTile[] = [];

    for (const m of run.tiles) {
      const tile = byKey.get(key(m.x, m.y))!;
      const foreign: Coordinate[] = [];
      let neighbourCount = 0;

      for (const d of NEIGHBOURS) {
        const nKey = key(m.x + d.x, m.y + d.y);
        if (!byKey.has(nKey)) continue;
        neighbourCount++;
        if (!memberKeys.has(nKey)) foreign.push(d);
      }

      // A buffer tile is *always* an opening, whatever its neighbour count.
      // It is the author's explicit assertion that track ends here, and the
      // generic end-of-line test below misses it whenever parallel roads of
      // one block are drawn on adjacent rows — which is most yards.
      const terminated = tile.tileType === 'buffer';
      // A terminus otherwise: the end of a drawn line, with nothing beyond it.
      // Without this, a siding ending in buffers touches nothing foreign and
      // would produce no end at all.
      const isTerminus = terminated || neighbourCount <= 1;

      if (foreign.length === 0) {
        if (isTerminus) {
          // A dead end has nothing to point at, so the direction away from the
          // run's own centre is the only honest outward vector available.
          openingTiles.push({ at: m, outward: { x: m.x - cx, y: m.y - cy }, terminated });
        }
        continue;
      }

      openingTiles.push({
        at: m,
        // Half a cell toward the mean foreign neighbour: the midpoint of the
        // handover, which points outward even for a contact on the far side.
        outward: {
          x: foreign.reduce((s, d) => s + d.x, 0) / foreign.length / 2,
          y: foreign.reduce((s, d) => s + d.y, 0) / foreign.length / 2,
        },
        terminated,
      });
    }

    // Adjacent opening tiles facing the same way are ONE opening. A block
    // meeting its neighbour along a three-cell face has one end there, not
    // three — and three generated labels for one physical opening is worse
    // than none, because an edge then references a name for a place that does
    // not exist.
    //
    // Facing the same way is not optional: on a two-tile block the west end
    // and the east end are adjacent cells, and adjacency alone would fuse the
    // two opposite ends of the block into a single mid-pointing one.
    for (const cluster of clusterTiles(openingTiles, sameDirection)) {
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
        terminated: cluster.some((o) => o.terminated),
      });
    }
  }

  return groupOpenings(raw);
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
      terminated: cluster.some((o) => o.terminated),
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
function sameDirection(a: OpeningTile, b: OpeningTile): boolean {
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
