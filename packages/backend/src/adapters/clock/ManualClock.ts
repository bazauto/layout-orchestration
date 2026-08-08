/**
 * ManualClock
 *
 * The first-class simulated twin of `IClock` (CLAUDE.md safety rule 5 —
 * everything testable without hardware, extended to time itself). Virtual
 * time only advances when `advance()` is called; nothing here reads the real
 * wall clock.
 *
 * Used by tests exercising #6's braking ramp (docs/braking.md B3) and, once
 * PR B wires it in, `tests/scenario/`'s harness.
 */

import { ClockTimer, IClock } from '../../ports/IClock';

interface ScheduledTimer {
  /** Insertion order — the tie-break when two timers share `dueAtMs`. */
  seq: number;
  dueAtMs: number;
  fn: () => void;
  cancelled: boolean;
  fired: boolean;
}

export class ManualClock implements IClock {
  private currentMs: number;
  private readonly timers: ScheduledTimer[] = [];
  private nextSeq = 0;

  constructor(initial: Date = new Date(0)) {
    this.currentMs = initial.getTime();
  }

  now(): Date {
    return new Date(this.currentMs);
  }

  setTimeout(fn: () => void, delayMs: number): ClockTimer {
    const timer: ScheduledTimer = {
      seq: this.nextSeq++,
      dueAtMs: this.currentMs + delayMs,
      fn,
      cancelled: false,
      fired: false,
    };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  /**
   * Advances virtual time by `ms`, firing every timer due at or before the
   * resulting instant, in due order. After each timer runs, a `setImmediate`
   * microtask flush is awaited before looking for the next one due — so a
   * timer scheduled *from inside* a callback (exactly how the braking ramp
   * chains one `setTimeout` into the next) is honoured within this same
   * `advance` call, not left for a caller to notice and advance again.
   *
   * A timer due strictly after the target instant does not fire, and `now()`
   * never jumps past the target to reach it — advancing short of a timer's
   * due time is a no-op for that timer, exactly as it would be for a real
   * clock that simply hasn't reached it yet.
   */
  async advance(ms: number): Promise<void> {
    const target = this.currentMs + ms;

    for (;;) {
      const next = this.nextDueTimer(target);
      if (!next) break;

      this.currentMs = next.dueAtMs;
      next.fired = true;
      next.fn();

      await flushMicrotasks();
    }

    this.currentMs = target;
  }

  private nextDueTimer(target: number): ScheduledTimer | undefined {
    let earliest: ScheduledTimer | undefined;
    for (const timer of this.timers) {
      if (timer.cancelled || timer.fired) continue;
      if (timer.dueAtMs > target) continue;
      if (
        !earliest ||
        timer.dueAtMs < earliest.dueAtMs ||
        (timer.dueAtMs === earliest.dueAtMs && timer.seq < earliest.seq)
      ) {
        earliest = timer;
      }
    }
    return earliest;
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
