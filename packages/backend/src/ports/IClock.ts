/**
 * Port: IClock
 *
 * Time and timers, injected rather than read from globals — the seam #6's
 * braking ramp (see docs/braking.md B3) executes against, and #25's D5
 * confirmation sweep executes against too. `domain/braking.ts` and
 * `domain/pointConfirmation.ts` never touch a clock themselves (purity
 * rules); this port exists purely for the service/transport layer that turns
 * a `BrakingSchedule` into real `setSpeed` calls over time, or that applies
 * `evaluateTimeout` on a periodic tick.
 *
 * Implementations: `SystemClock` (real hardware/wall-clock), `ManualClock`
 * (tests/dev — CLAUDE.md safety rule 5, everything testable without
 * hardware, extends to time itself).
 */

export interface ClockTimer {
  cancel(): void;
}

export interface IClock {
  now(): Date;

  /**
   * Schedules `fn` to run after `delayMs`. Returns a handle whose `cancel()`
   * prevents `fn` from running if called before it is due — mirrors the
   * global `setTimeout`/`clearTimeout` pair, but as an object so a caller
   * does not need to track a separate timer id.
   */
  setTimeout(fn: () => void, delayMs: number): ClockTimer;

  /**
   * Schedules `fn` to run every `everyMs`, starting `everyMs` from now, and
   * to keep running until cancelled. Returns a handle whose `cancel()` stops
   * future firings — mirrors the global `setInterval`/`clearInterval` pair.
   *
   * Added for #25's D5: a point confirmation deadline is a pure predicate
   * (`domain/pointConfirmation.ts#evaluateTimeout`) applied on a periodic
   * sweep, never a bare `setInterval` reached for directly in the service
   * layer — that is what makes the sweep exercisable by `ManualClock` in
   * tests without a real timer. A self-rescheduling `setTimeout` chain was
   * considered and rejected: it would put re-arm bookkeeping in the caller
   * and make "cancelled between fire and re-arm" a live hazard on a
   * safety-relevant timer.
   */
  setInterval(fn: () => void, everyMs: number): ClockTimer;
}
