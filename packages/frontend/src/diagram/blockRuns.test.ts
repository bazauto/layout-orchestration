/**
 * `findBlockRuns` / `assignRunTints` (#68).
 *
 * These are the parts of the label-and-tint work that can be wrong in ways a
 * screenshot would not reveal: a run split in two, a label placed in the hole
 * of a ring-shaped block, or two touching blocks handed the same tint. The
 * rendering that consumes them is exercised by the editor's e2e specs.
 */

import { describe, expect, it } from 'vitest';
import { assignRunTints, findBlockRuns, type RunnableTile } from './blockRuns';

/**
 * Builds tiles from an ASCII drawing: each non-space character is a tile whose
 * `blockId` is that character, `.` is a tile with no block at all.
 */
function draw(...rows: string[]): RunnableTile[] {
  const tiles: RunnableTile[] = [];
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (ch === ' ') return;
      tiles.push({ x, y, blockId: ch === '.' ? undefined : ch });
    });
  });
  return tiles;
}

describe('findBlockRuns', () => {
  it('groups a straight run of one block into a single run', () => {
    const runs = findBlockRuns(draw('AAAAA'));

    expect(runs).toHaveLength(1);
    expect(runs[0].blockId).toBe('A');
    expect(runs[0].tiles).toHaveLength(5);
  });

  // The bug in the issue: ten tiles drew ten labels, which overlapped into
  // `Fiddle Yard 2iddle Yard 2`.
  it('a ten-tile block yields one label position, not ten', () => {
    const runs = findBlockRuns(draw('AAAAAAAAAA'));

    expect(runs).toHaveLength(1);
    expect(runs[0].labelAt).toEqual({ x: 4, y: 0 });
  });

  it('is 8-connected, so a diagonal run is one block rather than several', () => {
    const runs = findBlockRuns(draw('A    ', ' A   ', '  A  ', '   A '));

    expect(runs).toHaveLength(1);
    expect(runs[0].tiles).toHaveLength(4);
  });

  it('separates two different blocks that touch', () => {
    const runs = findBlockRuns(draw('AAABBB'));

    expect(runs.map((r) => r.blockId)).toEqual(['A', 'B']);
    expect(runs.every((r) => r.tiles.length === 3)).toBe(true);
  });

  // A block genuinely drawn in two places gets one label per place — those are
  // two separate things on screen and each needs naming.
  it('gives a block drawn in two disconnected places one run each', () => {
    const runs = findBlockRuns(draw('AA..AA'));

    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.blockId === 'A')).toBe(true);
  });

  it('ignores tiles with no blockId rather than treating them as a block', () => {
    const runs = findBlockRuns(draw('..A..'));

    expect(runs).toHaveLength(1);
    expect(runs[0].tiles).toEqual([{ x: 2, y: 0 }]);
  });

  it('returns nothing for a drawing with no tagged tiles at all', () => {
    expect(findBlockRuns(draw('.....'))).toEqual([]);
  });

  // The arithmetic centroid of a ring falls in the hole, which would float the
  // label over the middle of the loop instead of over the track.
  it('places the label on a tile of the run, never in its hole', () => {
    const runs = findBlockRuns(draw('AAA', 'A.A', 'AAA'));

    expect(runs).toHaveLength(1);
    const { labelAt, tiles } = runs[0];
    expect(tiles).toContainEqual(labelAt);
    expect(labelAt).not.toEqual({ x: 1, y: 1 });
  });

  it('places the label on the run for an L-shaped block too', () => {
    const runs = findBlockRuns(draw('A..', 'A..', 'AAA'));

    expect(runs[0].tiles).toContainEqual(runs[0].labelAt);
  });

  it('is deterministic — the same drawing always yields the same order and labels', () => {
    const drawing = draw('AABBB', 'AA..B', 'CCCCB');

    const first = findBlockRuns(drawing);
    const second = findBlockRuns([...drawing].reverse());

    expect(second).toEqual(first);
  });
});

describe('assignRunTints', () => {
  const PALETTE = 4;

  function tintsFor(...rows: string[]) {
    const runs = findBlockRuns(draw(...rows));
    return { runs, tints: assignRunTints(runs, PALETTE) };
  }

  it('gives two touching blocks different tints', () => {
    const { tints } = tintsFor('AAABBB');

    expect(tints.get('A')).not.toBe(tints.get('B'));
  });

  it('gives every block in a mutually touching group of four a distinct tint', () => {
    const { tints } = tintsFor('AB', 'CD');

    expect(new Set([...tints.values()]).size).toBe(4);
  });

  it('counts diagonal contact as adjacency', () => {
    const { tints } = tintsFor('A.', '.B');

    expect(tints.get('A')).not.toBe(tints.get('B'));
  });

  it('lets two blocks that never touch share a tint, rather than exhausting the palette', () => {
    const { tints } = tintsFor('A...B');

    expect(tints.get('A')).toBe(tints.get('B'));
  });

  // A block drawn in two places is still one block, so both runs must tint
  // identically or it would read as two.
  it('gives every run of the same block the same tint', () => {
    const { runs, tints } = tintsFor('AA..AA');

    expect(runs).toHaveLength(2);
    expect(tints.get('A')).toBeDefined();
    expect(new Set(runs.map((r) => tints.get(r.blockId))).size).toBe(1);
  });

  it('is stable across reloads for the same drawing', () => {
    const rows = ['AABBB', 'AA..B', 'CCCCB'];

    expect([...tintsFor(...rows).tints]).toEqual([...tintsFor(...rows).tints]);
  });

  it('always stays within the palette, even when greedy runs out', () => {
    // Five mutually adjacent blocks — more than four colours can separate.
    const { tints } = tintsFor('ABC', 'DE.');

    for (const tint of tints.values()) {
      expect(tint).toBeGreaterThanOrEqual(0);
      expect(tint).toBeLessThan(PALETTE);
    }
  });

  it('handles an empty drawing without throwing', () => {
    expect(assignRunTints([], PALETTE).size).toBe(0);
  });
});
