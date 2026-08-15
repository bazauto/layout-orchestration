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
  /** One-shot timers only — a repeating timer is never "done" firing. */
  fired: boolean;
  /** Set for a `setInterval` timer; `undefined` for a one-shot `setTimeout`. */
  intervalMs: number | undefined;
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
      intervalMs: undefined,
    };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  /**
   * A repeating timer — the twin `IClock.setInterval` documents. Re-arms
   * from its OWN due instant, not from `now`, each time it fires: a 250 ms
   * interval created at t=0 is due at 250, 500, 750, ..., so `advance(1000)`
   * fires it exactly four times regardless of how the calls are batched.
   */
  setInterval(fn: () => void, everyMs: number): ClockTimer {
    const timer: ScheduledTimer = {
      seq: this.nextSeq++,
      dueAtMs: this.currentMs + everyMs,
      fn,
      cancelled: false,
      fired: false,
      intervalMs: everyMs,
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
   * `advance` call, not left for a caller to notice and advance again. A
   * repeating timer is re-armed (its `dueAtMs` pushed forward by its own
   * `intervalMs`) immediately after it fires, so it competes for the next
   * slot exactly like any other pending timer.
   *
   * A timer due strictly after the target instant does not fire, and `now()`
   * never jumps past the target to reach it — advancing short of a timer's
   * due time is a no-op for that timer, exactly as it would be for a real
   * clock that simply hasn't reached it yet.
   *
   * A callback that throws is caught and swallowed rather than propagated:
   * the real `setInterval`/`setTimeout` a thrown handler crashes stops that
   * one timer, never its siblings, and a thrown handler here must never
   * silently kill a safety-relevant sweep sharing the same virtual clock.
   */
  async advance(ms: number): Promise<void> {
    const target = this.currentMs + ms;

    for (;;) {
      const next = this.nextDueTimer(target);
      if (!next) break;

      this.currentMs = next.dueAtMs;
      if (next.intervalMs !== undefined) {
        next.dueAtMs += next.intervalMs;
      } else {
        next.fired = true;
      }

      try {
        next.fn();
      } catch {
        // Swallowed — see the doc comment above.
      }

      await flushMicrotasks();
    }

    this.currentMs = target;
  }

  private nextDueTimer(target: number): ScheduledTimer | undefined {
    let earliest: ScheduledTimer | undefined;
    for (const timer of this.timers) {
      if (timer.cancelled) continue;
      if (timer.fired && timer.intervalMs === undefined) continue;
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
