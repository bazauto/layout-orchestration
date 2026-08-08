import { describe, it, expect } from 'vitest';
import { ManualClock } from '../../../src/adapters/clock/ManualClock';

describe('ManualClock', () => {
  it('fires timers in due order regardless of scheduling order', () => {
    const clock = new ManualClock(new Date(0));
    const order: string[] = [];

    clock.setTimeout(() => order.push('late'), 200);
    clock.setTimeout(() => order.push('early'), 100);

    return clock.advance(200).then(() => {
      expect(order).toEqual(['early', 'late']);
    });
  });

  it('cancel() before due prevents the timer from firing', async () => {
    const clock = new ManualClock(new Date(0));
    const order: string[] = [];

    const cancelled = clock.setTimeout(() => order.push('cancelled'), 100);
    clock.setTimeout(() => order.push('kept'), 150);
    cancelled.cancel();

    await clock.advance(200);
    expect(order).toEqual(['kept']);
  });

  it('honours a timer scheduled from inside a callback within the same advance', async () => {
    const clock = new ManualClock(new Date(0));
    const order: Array<{ label: string; at: number }> = [];

    clock.setTimeout(() => {
      order.push({ label: 'first', at: clock.now().getTime() });
      // Chained the way the braking ramp chains one step into the next.
      clock.setTimeout(() => {
        order.push({ label: 'second', at: clock.now().getTime() });
      }, 50);
    }, 100);

    await clock.advance(200);

    expect(order).toEqual([
      { label: 'first', at: 100 },
      { label: 'second', at: 150 },
    ]);
  });

  it('runs each due timer with now() set to its own due instant, in due order', async () => {
    const clock = new ManualClock(new Date(0));
    const seenNow: number[] = [];

    clock.setTimeout(() => seenNow.push(clock.now().getTime()), 300);
    clock.setTimeout(() => seenNow.push(clock.now().getTime()), 100);
    clock.setTimeout(() => seenNow.push(clock.now().getTime()), 200);

    await clock.advance(300);
    expect(seenNow).toEqual([100, 200, 300]);
  });

  // ── Failure path ────────────────────────────────────────────────────────

  it('does not fire a timer due after the advanced target, and does not let now() jump past it', async () => {
    const clock = new ManualClock(new Date(0));
    let fired = false;

    clock.setTimeout(() => {
      fired = true;
    }, 150);

    await clock.advance(100);

    expect(fired).toBe(false);
    expect(clock.now().getTime()).toBe(100);
  });
});
