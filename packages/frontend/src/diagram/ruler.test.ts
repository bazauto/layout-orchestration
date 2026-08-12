/**
 * `diagram/ruler` — the tick maths behind the Track Editor's ruler gutters
 * and gridline emphasis (#94).
 *
 * These tests defend the one property the whole feature exists for: at low
 * zoom the labels thin out instead of shrinking, and they never land closer
 * together than the spacing a printed number needs to stay legible.
 */

import { describe, expect, it } from 'vitest';
import { rulerLabelStep, rulerTicks } from './ruler';

describe('rulerLabelStep', () => {
  it('labels every tile at zoom 1, where 40px per tile is already wide enough', () => {
    // Real regression this guards: an over-eager thinning rule that kicked
    // in even at full zoom would make the ruler look sparse when there was
    // no crowding problem to solve.
    expect(rulerLabelStep(40)).toBe(1);
  });

  it('thins to a wider step once tiles are too close together to label', () => {
    // Zoom 0.3, 40px tiles => 12px per tile. Two adjacent labels 12px apart
    // is the exact illegible-ruler complaint #94 raised — the step must
    // widen enough that consecutive labels clear the 24px floor.
    const step = rulerLabelStep(12);
    expect(step * 12).toBeGreaterThanOrEqual(24);
    expect(step).toBeGreaterThan(1);
  });

  it('never returns a step smaller than the spacing requires', () => {
    // A step that is merely close, rather than sufficient, would let two
    // numbers overlap at the exact zoom level the thinning exists to protect.
    for (const tilePx of [1, 3, 7, 12, 20, 39, 40, 41, 100]) {
      const step = rulerLabelStep(tilePx);
      expect(step * tilePx).toBeGreaterThanOrEqual(24);
    }
  });

  it('falls back to the widest nice step rather than looping forever on a vanishing tile size', () => {
    expect(rulerLabelStep(0.001)).toBe(1000);
  });
});

describe('rulerTicks', () => {
  it('marks every 5th index major regardless of the label step', () => {
    // Gridline emphasis and label thinning are independent controls — a
    // widened label step must never also widen which lines count as major,
    // or the "every 5th gridline" promise breaks the moment you zoom out.
    const ticks = rulerTicks(12, 12); // label step will be > 1 here
    const majors = ticks.filter((t) => t.major).map((t) => t.index);
    expect(majors).toEqual([0, 5, 10]);
  });

  it('labels only the indices rulerLabelStep keeps', () => {
    const ticks = rulerTicks(10, 40); // 40px/tile => step 1, everything labelled
    expect(ticks.every((t) => t.label)).toBe(true);

    const thinned = rulerTicks(10, 12); // step > 1
    const step = rulerLabelStep(12);
    expect(thinned.filter((t) => t.label).map((t) => t.index)).toEqual(
      thinned.map((t) => t.index).filter((i) => i % step === 0),
    );
  });

  it('returns one tick per index in range, indices starting at 0', () => {
    expect(rulerTicks(3, 40).map((t) => t.index)).toEqual([0, 1, 2]);
  });

  it('returns nothing for an empty axis rather than throwing', () => {
    expect(rulerTicks(0, 40)).toEqual([]);
  });
});
