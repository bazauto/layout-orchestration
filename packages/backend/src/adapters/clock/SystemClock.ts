/**
 * SystemClock
 *
 * Wraps the real `Date`/`setTimeout`/`clearTimeout`. The production
 * implementation of `IClock` — used everywhere except tests.
 */

import { ClockTimer, IClock } from '../../ports/IClock';

export class SystemClock implements IClock {
  now(): Date {
    return new Date();
  }

  setTimeout(fn: () => void, delayMs: number): ClockTimer {
    const handle = setTimeout(fn, delayMs);
    return {
      cancel: () => clearTimeout(handle),
    };
  }
}
