/**
 * `diagram/openings` — the port→coordinate mapping the canvas draws opening
 * marks from (#103 step 6.1).
 */

import { describe, expect, it } from 'vitest';
import { portMarkGeometry } from './openings';

const SIZE = 40;

/**
 * Rotates a point 90° the way an SVG `rotate(90, cx, cy)` would — matching
 * `TilePath`'s own transform, so this can simulate "what if the tick were
 * drawn inside that rotated `<g>` too" without hard-coding sines and cosines
 * at every call site.
 */
function rotate90(p: { x: number; y: number }, centre: { x: number; y: number }) {
  const rx = p.x - centre.x;
  const ry = p.y - centre.y;
  return { x: centre.x - ry, y: centre.y + rx };
}

describe('portMarkGeometry', () => {
  it('n — a vertical tick straddling the top boundary at its midpoint', () => {
    expect(portMarkGeometry({ edge: 'n' }, SIZE)).toEqual({ x1: 20, y1: 5, x2: 20, y2: -5 });
  });

  it('e — a horizontal tick straddling the right boundary at its midpoint', () => {
    expect(portMarkGeometry({ edge: 'e' }, SIZE)).toEqual({ x1: 35, y1: 20, x2: 45, y2: 20 });
  });

  it('s — a vertical tick straddling the bottom boundary at its midpoint', () => {
    expect(portMarkGeometry({ edge: 's' }, SIZE)).toEqual({ x1: 20, y1: 35, x2: 20, y2: 45 });
  });

  it('w — a horizontal tick straddling the left boundary at its midpoint', () => {
    expect(portMarkGeometry({ edge: 'w' }, SIZE)).toEqual({ x1: 5, y1: 20, x2: -5, y2: 20 });
  });

  it('ne — a diagonal tick straddling the top-right corner', () => {
    const g = portMarkGeometry({ edge: 'ne' }, SIZE);
    expect(g.x1).toBeCloseTo(36.4645, 3);
    expect(g.y1).toBeCloseTo(3.5355, 3);
    expect(g.x2).toBeCloseTo(43.5355, 3);
    expect(g.y2).toBeCloseTo(-3.5355, 3);
  });

  it('se — a diagonal tick straddling the bottom-right corner', () => {
    const g = portMarkGeometry({ edge: 'se' }, SIZE);
    expect(g.x1).toBeCloseTo(36.4645, 3);
    expect(g.y1).toBeCloseTo(36.4645, 3);
    expect(g.x2).toBeCloseTo(43.5355, 3);
    expect(g.y2).toBeCloseTo(43.5355, 3);
  });

  it('sw — a diagonal tick straddling the bottom-left corner', () => {
    const g = portMarkGeometry({ edge: 'sw' }, SIZE);
    expect(g.x1).toBeCloseTo(3.5355, 3);
    expect(g.y1).toBeCloseTo(36.4645, 3);
    expect(g.x2).toBeCloseTo(-3.5355, 3);
    expect(g.y2).toBeCloseTo(43.5355, 3);
  });

  it('nw — a diagonal tick straddling the top-left corner', () => {
    const g = portMarkGeometry({ edge: 'nw' }, SIZE);
    expect(g.x1).toBeCloseTo(3.5355, 3);
    expect(g.y1).toBeCloseTo(3.5355, 3);
    expect(g.x2).toBeCloseTo(-3.5355, 3);
    expect(g.y2).toBeCloseTo(-3.5355, 3);
  });

  /**
   * Regression: `Port.edge` is already in the rotated (screen) frame
   * (`../types.ts`, mirroring `tileGeometry.ts`'s `Port`). An unrotated `n`
   * leg on a tile drawn at `rotation: 90` becomes `e` in that frame — the
   * compiler's job, done once, server-side.
   *
   * The correct render draws the tick for `{ edge: 'e' }` directly, with no
   * further transform. If it were (wrongly) drawn inside the same rotated
   * `<g>` `TilePath` uses — applying the tile's rotation a **second** time —
   * the mark would land where a further 90° turn of the already-correct tick
   * would put it, not where it belongs.
   */
  it('a rotated tile port is not rotated a second time', () => {
    const centre = { x: SIZE / 2, y: SIZE / 2 };
    const north = portMarkGeometry({ edge: 'n' }, SIZE);
    const east = portMarkGeometry({ edge: 'e' }, SIZE);

    // One correct rotation — applied once, upstream, by the compiler that
    // turned the unrotated `n` leg into the screen-frame `e` port — lands
    // exactly on the directly-computed east tick.
    const northRotatedOnce = {
      ...rotate90({ x: north.x1, y: north.y1 }, centre),
    };
    const northRotatedOnceEnd = rotate90({ x: north.x2, y: north.y2 }, centre);
    expect(northRotatedOnce.x).toBeCloseTo(east.x1, 5);
    expect(northRotatedOnce.y).toBeCloseTo(east.y1, 5);
    expect(northRotatedOnceEnd.x).toBeCloseTo(east.x2, 5);
    expect(northRotatedOnceEnd.y).toBeCloseTo(east.y2, 5);

    // A SECOND rotation of the already-correct east tick — the double-
    // rotation bug — lands on the south boundary instead. The directly-
    // computed east tick must not be there.
    const eastRotatedAgain = rotate90({ x: east.x1, y: east.y1 }, centre);
    const south = portMarkGeometry({ edge: 's' }, SIZE);
    expect(eastRotatedAgain.x).toBeCloseTo(south.x1, 5);
    expect(eastRotatedAgain.y).toBeCloseTo(south.y1, 5);
    expect(east.x1).not.toBeCloseTo(south.x1, 5);
  });
});
