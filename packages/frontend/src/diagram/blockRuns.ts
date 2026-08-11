/**
 * Block runs — grouping a drawing's tiles into the contiguous stretches a
 * label and a tint apply to (#68).
 *
 * Pure: takes plain tile coordinates, returns plain data. No React, no SVG, no
 * knowledge of how any of it is drawn. That is what makes it testable, and
 * what keeps it reusable when the editor and the monitor view come to share
 * one geometry renderer (#75).
 *
 * The problem it solves: the editor drew the block name on *every* tile
 * carrying a `blockId`, at font size 6. A ten-tile block drew ten labels side
 * by side, which overlapped and interleaved — the real layout produced
 * `Fiddle Yard 2iddle Yard 2`. Repeating a name ten times also conveys
 * nothing the first one didn't.
 */

/** The minimum a tile must expose for grouping. */
export interface RunnableTile {
  x: number;
  y: number;
  blockId?: string;
}

export interface BlockRun {
  blockId: string;
  tiles: { x: number; y: number }[];
  /**
   * Where the run's single label goes. Guaranteed to be **a tile of the run**,
   * not the arithmetic mean: the mean of an L-shaped or ring-shaped block
   * falls in the hole, which would float the label over unrelated track or
   * over nothing at all.
   */
  labelAt: { x: number; y: number };
}

/** 8-connected: diagonal neighbours count, so a 45° run of track is one block. */
const NEIGHBOURS: readonly [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

const key = (x: number, y: number) => `${x},${y}`;

/**
 * Groups tiles into runs of 8-connected neighbours sharing a `blockId`.
 *
 * A block drawn in two genuinely disconnected places gets one run — and so one
 * label — per place, which is the right answer: those are two separate things
 * on screen and each needs naming. Tiles with no `blockId` are skipped
 * entirely; an untagged tile is legitimate and must not be warned about here
 * (#68, and #71 is what will eventually classify them).
 *
 * Output order is deterministic — sorted by `blockId`, then by the run's
 * top-left tile — so the tints derived from it in `assignRunTints` are stable
 * across reloads.
 */
export function findBlockRuns(tiles: readonly RunnableTile[]): BlockRun[] {
  const tagged = new Map<string, RunnableTile>();
  for (const t of tiles) {
    if (t.blockId) tagged.set(key(t.x, t.y), t);
  }

  const seen = new Set<string>();
  const runs: BlockRun[] = [];

  for (const [startKey, start] of tagged) {
    if (seen.has(startKey)) continue;

    const blockId = start.blockId!;
    const members: { x: number; y: number }[] = [];
    const queue = [start];
    seen.add(startKey);

    while (queue.length > 0) {
      const tile = queue.pop()!;
      members.push({ x: tile.x, y: tile.y });

      for (const [dx, dy] of NEIGHBOURS) {
        const nKey = key(tile.x + dx, tile.y + dy);
        if (seen.has(nKey)) continue;
        const neighbour = tagged.get(nKey);
        if (!neighbour || neighbour.blockId !== blockId) continue;
        seen.add(nKey);
        queue.push(neighbour);
      }
    }

    // Sorted, not left in flood-fill order: the traversal visits neighbours in
    // whatever order the input happened to be in, and a run whose `tiles`
    // depend on input order is not the deterministic output this claims to be.
    members.sort((a, b) => a.y - b.y || a.x - b.x);
    runs.push({ blockId, tiles: members, labelAt: pickLabelTile(members) });
  }

  return runs.sort(
    (a, b) =>
      a.blockId.localeCompare(b.blockId) ||
      a.labelAt.y - b.labelAt.y ||
      a.labelAt.x - b.labelAt.x,
  );
}

/**
 * The member tile closest to the run's centroid — so the label sits centrally
 * but always *on* the run. Ties break on (y, x) to stay deterministic.
 */
function pickLabelTile(members: { x: number; y: number }[]): { x: number; y: number } {
  const cx = members.reduce((s, t) => s + t.x, 0) / members.length;
  const cy = members.reduce((s, t) => s + t.y, 0) / members.length;

  let best = members[0];
  let bestD = Infinity;
  for (const t of members) {
    const d = (t.x - cx) ** 2 + (t.y - cy) ** 2;
    if (d < bestD || (d === bestD && (t.y < best.y || (t.y === best.y && t.x < best.x)))) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/**
 * Assigns each run a tint index, such that no two spatially adjacent runs
 * share one.
 *
 * Greedy graph colouring, not a hash of the block id. A hash gives adjacent
 * blocks the same tint often enough to be useless precisely where the
 * distinction matters — at the boundary — and, worse, it needs a palette as
 * large as the layout, which cannot be made colour-blind-safe (see
 * `BLOCK_TINTS`). Four colours suffice here for the same reason they suffice
 * for a map: a track drawing is near-planar.
 *
 * All runs of the same block get the same tint, so a block drawn in two places
 * still reads as one block.
 *
 * If a layout ever defeats the palette — greedy is not optimal, and a
 * pathological drawing could need a fifth — the assignment wraps rather than
 * failing. Two adjacent blocks then share a tint, and the labels are what tell
 * them apart. That is a graceful degradation, not a correctness bug: the tint
 * was never the identity carrier.
 */
export function assignRunTints(runs: readonly BlockRun[], paletteSize: number): Map<string, number> {
  const occupied = new Map<string, string>(); // tile key -> blockId
  for (const run of runs) {
    for (const t of run.tiles) occupied.set(key(t.x, t.y), run.blockId);
  }

  // blockId -> the set of other blockIds it touches.
  const adjacency = new Map<string, Set<string>>();
  const blockIds: string[] = [];
  for (const run of runs) {
    if (!adjacency.has(run.blockId)) {
      adjacency.set(run.blockId, new Set());
      blockIds.push(run.blockId);
    }
  }

  for (const run of runs) {
    const mine = adjacency.get(run.blockId)!;
    for (const t of run.tiles) {
      for (const [dx, dy] of NEIGHBOURS) {
        const other = occupied.get(key(t.x + dx, t.y + dy));
        if (other && other !== run.blockId) {
          mine.add(other);
          adjacency.get(other)!.add(run.blockId);
        }
      }
    }
  }

  // `runs` is already sorted by blockId, so `blockIds` is in a stable order
  // and the same drawing always produces the same tints.
  const tintOf = new Map<string, number>();
  for (const blockId of blockIds) {
    const taken = new Set<number>();
    for (const neighbour of adjacency.get(blockId)!) {
      const t = tintOf.get(neighbour);
      if (t !== undefined) taken.add(t);
    }
    let tint = 0;
    while (taken.has(tint) && tint < paletteSize - 1) tint++;
    tintOf.set(blockId, tint % paletteSize);
  }

  return tintOf;
}
