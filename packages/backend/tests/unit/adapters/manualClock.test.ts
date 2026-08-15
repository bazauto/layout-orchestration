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

  // ── setInterval (#25 D5) ────────────────────────────────────────────────

  it('re-arms a repeating timer from its own due instant, so advance(1000) past a 250ms interval fires it four times', async () => {
    const clock = new ManualClock(new Date(0));
    const fireTimes: number[] = [];

    clock.setInterval(() => fireTimes.push(clock.now().getTime()), 250);

    await clock.advance(1000);

    expect(fireTimes).toEqual([250, 500, 750, 1000]);
  });

  it('interleaves a repeating timer with one-shot timers in due order', async () => {
    const clock = new ManualClock(new Date(0));
    const order: string[] = [];

    clock.setInterval(() => order.push('sweep'), 250);
    clock.setTimeout(() => order.push('once-at-100'), 100);
    clock.setTimeout(() => order.push('once-at-600'), 600);

    await clock.advance(750);

    expect(order).toEqual(['once-at-100', 'sweep', 'sweep', 'once-at-600', 'sweep']);
  });

  it('cancel() on a repeating timer stops all further firings', async () => {
    const clock = new ManualClock(new Date(0));
    let count = 0;

    const handle = clock.setInterval(() => {
      count += 1;
    }, 250);

    await clock.advance(500);
    expect(count).toBe(2);

    handle.cancel();
    await clock.advance(500);
    expect(count).toBe(2);
  });

  it('a throwing callback does not stop other timers, including its own next firing', async () => {
    const clock = new ManualClock(new Date(0));
    const order: string[] = [];
    let sweepCount = 0;

    clock.setInterval(() => {
      sweepCount += 1;
      throw new Error('sweep callback exploded');
    }, 250);
    clock.setTimeout(() => order.push('kept'), 300);

    await clock.advance(1000);

    expect(sweepCount).toBe(4);
    expect(order).toEqual(['kept']);
  });
});
