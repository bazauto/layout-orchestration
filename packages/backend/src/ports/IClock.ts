/**
 * Port: IClock
 *
 * Time and timers, injected rather than read from globals — the seam #6's
 * braking ramp (see docs/braking.md B3) executes against. `domain/braking.ts`
 * itself never touches a clock (B7's purity rule); this port exists purely
 * for the service/transport layer that turns a `BrakingSchedule` into real
 * `setSpeed` calls over time.
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
}
