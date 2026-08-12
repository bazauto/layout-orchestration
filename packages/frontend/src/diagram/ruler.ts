/**
 * Pure tick maths for the Track Editor's ruler gutters and gridline emphasis
 * (#94). Kept out of `GridEditor.tsx` so it is unit-testable without
 * mounting an SVG, and so the two consumers — the printed column/row
 * numbers and the "every 5th gridline" emphasis on the canvas itself — stay
 * one implementation.
 */

/** "Nice" label steps a ruler falls back through as the view zooms out. */
const NICE_STEPS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000] as const;

/**
 * The smallest step from `NICE_STEPS` that keeps consecutive labels at
 * least `minSpacingPx` apart on screen, at `tilePx` pixels per tile.
 *
 * Shrinking the printed number at low zoom was rejected (D11,
 * `docs/track-editor.md`): a scaled-down "11" is illegible exactly when the
 * ruler is doing the most work, at zoom 0.3. Skipping labels instead keeps
 * every one that *is* printed full size and readable.
 */
export function rulerLabelStep(tilePx: number, minSpacingPx = 24): number {
  for (const step of NICE_STEPS) {
    if (step * tilePx >= minSpacingPx) return step;
  }
  return NICE_STEPS[NICE_STEPS.length - 1];
}

export interface RulerTick {
  /** The column or row index this tick sits at. */
  index: number;
  /** Every 5th index, regardless of whether it also carries a label. */
  major: boolean;
  /** Whether this index is one `rulerLabelStep` keeps at the current zoom. */
  label: boolean;
}

/**
 * Every tick along one ruler axis, `count` of them (indices `0..count-1`).
 *
 * Used both for the printed column/row numbers (which read `label`) and for
 * emphasising every 5th gridline on the canvas itself (which reads `major`
 * only) — one pass produces both, so the two can never drift out of step
 * with each other the way two independent modulo checks eventually would.
 */
export function rulerTicks(count: number, tilePx: number, minSpacingPx = 24): RulerTick[] {
  const step = rulerLabelStep(tilePx, minSpacingPx);
  const ticks: RulerTick[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push({ index: i, major: i % 5 === 0, label: i % step === 0 });
  }
  return ticks;
}
