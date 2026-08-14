import { describe, expect, it } from 'vitest';
import { PATTERN_SIZE } from './patterns';
import { TILE_SIZE } from './tilePaths';

/**
 * The alignment invariant, asserted rather than commented.
 *
 * `patternUnits="userSpaceOnUse"` anchors a pattern in the user space of the
 * element referencing it, and every occupancy wash rect sits inside its own
 * tile's `translate(x*TILE_SIZE, y*TILE_SIZE)`. A pattern whose period divides
 * `TILE_SIZE` comes out in the same phase on every tile, so the hatch runs
 * unbroken across a multi-tile block. One that does not leaves a visible seam
 * at every tile boundary — which is exactly what `diag-occupied` did while it
 * carried `patternTransform="rotate(45)"`, since a 40px shift along a 45° axis
 * is 28.28 and `28.28 mod 8` is not zero.
 */
describe('hatch alignment', () => {
  it('has a pattern period that divides the tile size', () => {
    expect(TILE_SIZE % PATTERN_SIZE).toBe(0);
  });
});
