import { describe, it, expect } from 'vitest';
import {
  applyPointReading,
  buildPointPositionMap,
  confirmationArms,
  effectivePosition,
  evaluateStaleness,
  evaluateTimeout,
  initialPointState,
  onPointCommanded,
  onPointQueried,
  PointConfirmationPolicy,
} from '../../../src/domain/pointConfirmation';
import { PointReading, PointState } from '../../../src/domain/types';

const NOW = new Date('2026-08-14T00:00:00.000Z');
const LATER = new Date('2026-08-14T00:00:09.000Z'); // +9000ms
const POLICY: PointConfirmationPolicy = { timeoutMs: 8000, freshnessTimeoutMs: 90_000 };

function reading(overrides: Partial<PointReading> = {}): PointReading {
  return {
    pointId: 'p1',
    position: 'normal',
    source: 'sensor',
    reportedAt: null,
    ...overrides,
  };
}

/** The invariant every transition function must preserve. */
function assertAwaitingInvariant(p: PointState): void {
  if (p.confirmation === 'pending') {
    expect(p.awaitingSince).not.toBeNull();
  } else {
    expect(p.awaitingSince).toBeNull();
  }
}

// ─── initialPointState ──────────────────────────────────────────────────────

describe('initialPointState', () => {
  it('starts unreported, unknown, uncommanded — same shape for "none" and "required"', () => {
    const p = initialPointState('p1', 'required', NOW);
    expect(p).toMatchObject({
      pointId: 'p1',
      commandedPosition: null,
      confirmedPosition: 'unknown',
      confirmation: 'unreported',
      positionFeedback: 'required',
      awaitingSince: null,
      lastReadingAt: null,
      locked: false,
      lockedByRoute: null,
    });
    assertAwaitingInvariant(p);
  });

  it('carries the configured feedback mode through unchanged', () => {
    const p = initialPointState('p1', 'none', NOW);
    expect(p.positionFeedback).toBe('none');
  });
});

// ─── onPointCommanded ───────────────────────────────────────────────────────

describe('onPointCommanded', () => {
  it("arms a deadline on a 'required' point: pending, awaitingSince = now, confirmedPosition reset to unknown", () => {
    const p = { ...initialPointState('p1', 'required', NOW), confirmedPosition: 'normal' as const };
    const commanded = onPointCommanded(p, 'reverse', NOW);
    expect(commanded.commandedPosition).toBe('reverse');
    expect(commanded.confirmation).toBe('pending');
    expect(commanded.awaitingSince).toEqual(NOW);
    expect(commanded.confirmedPosition).toBe('unknown');
    assertAwaitingInvariant(commanded);
  });

  it("does NOT arm a deadline on a 'none' point — confirmation is left untouched", () => {
    const p = initialPointState('p1', 'none', NOW);
    const commanded = onPointCommanded(p, 'normal', NOW);
    expect(commanded.commandedPosition).toBe('normal');
    expect(commanded.confirmation).toBe('unreported'); // untouched
    expect(commanded.awaitingSince).toBeNull();
    assertAwaitingInvariant(commanded);
  });

  it('always sets commandedPosition regardless of feedback mode', () => {
    const none = onPointCommanded(initialPointState('p1', 'none', NOW), 'reverse', NOW);
    const required = onPointCommanded(initialPointState('p2', 'required', NOW), 'reverse', NOW);
    expect(none.commandedPosition).toBe('reverse');
    expect(required.commandedPosition).toBe('reverse');
  });
});

// ─── onPointQueried ─────────────────────────────────────────────────────────

describe('onPointQueried (D6 — a query never arms a deadline)', () => {
  it('is a no-op on an unreported point beyond lastUpdated', () => {
    const p = initialPointState('p1', 'required', NOW);
    const queried = onPointQueried(p, LATER);
    expect(queried).toEqual({ ...p, lastUpdated: LATER });
    assertAwaitingInvariant(queried);
  });

  it('does not disturb a point that is already pending', () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const queried = onPointQueried(commanded, LATER);
    expect(queried.confirmation).toBe('pending');
    expect(queried.awaitingSince).toEqual(NOW); // unchanged — still the command's instant
    assertAwaitingInvariant(queried);
  });
});

// ─── applyPointReading ──────────────────────────────────────────────────────

describe('applyPointReading', () => {
  it('confirms when the reading matches commandedPosition', () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const result = applyPointReading(commanded, reading({ position: 'normal' }), LATER);
    expect(result.confirmation).toBe('confirmed');
    expect(result.confirmedPosition).toBe('normal');
    expect(result.awaitingSince).toBeNull();
    expect(result.lastReadingAt).toEqual(LATER);
    assertAwaitingInvariant(result);
  });

  it('confirms a reading with nothing commanded to disagree with (a query answer)', () => {
    const p = initialPointState('p1', 'none', NOW);
    const result = applyPointReading(p, reading({ position: 'reverse' }), LATER);
    expect(result.confirmation).toBe('confirmed');
    expect(result.confirmedPosition).toBe('reverse');
  });

  // ── Failure paths ──────────────────────────────────────────────────────

  it('reports mismatch when the reading disagrees with commandedPosition, and confirmedPosition holds the REPORTED value', () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const result = applyPointReading(commanded, reading({ position: 'reverse' }), LATER);
    expect(result.confirmation).toBe('mismatch');
    expect(result.confirmedPosition).toBe('reverse'); // reported, not commanded
    expect(result.awaitingSince).toBeNull();
    assertAwaitingInvariant(result);
  });

  it("a reading of 'unknown' is indeterminate regardless of feedback mode", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const result = applyPointReading(commanded, reading({ position: 'unknown', source: 'sensor' }), LATER);
    expect(result.confirmation).toBe('indeterminate');
    expect(result.confirmedPosition).toBe('unknown');
    assertAwaitingInvariant(result);
  });

  it("a driver-sourced reading on a 'required' point is indeterminate, even when it matches commandedPosition", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const result = applyPointReading(commanded, reading({ position: 'normal', source: 'driver' }), LATER);
    expect(result.confirmation).toBe('indeterminate');
    expect(result.confirmedPosition).toBe('unknown');
    assertAwaitingInvariant(result);
  });

  it("a driver-sourced reading on a 'none' point IS accepted as confirmed — nothing stronger was ever claimed", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'none', NOW), 'normal', NOW);
    const result = applyPointReading(commanded, reading({ position: 'normal', source: 'driver' }), LATER);
    expect(result.confirmation).toBe('confirmed');
    expect(result.confirmedPosition).toBe('normal');
  });

  it('a late reading after timed-out restores confirmed', () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const timedOut = evaluateTimeout(commanded, LATER, POLICY);
    expect(timedOut).not.toBeNull();
    expect(timedOut!.confirmation).toBe('timed-out');

    const restored = applyPointReading(timedOut!, reading({ position: 'normal' }), new Date(LATER.getTime() + 1000));
    expect(restored.confirmation).toBe('confirmed');
    expect(restored.confirmedPosition).toBe('normal');
    assertAwaitingInvariant(restored);
  });
});

// ─── evaluateTimeout ────────────────────────────────────────────────────────

describe('evaluateTimeout', () => {
  it('returns null for a non-pending point so a sweep does not emit spuriously', () => {
    const unreported = initialPointState('p1', 'required', NOW);
    expect(evaluateTimeout(unreported, LATER, POLICY)).toBeNull();

    const confirmed = applyPointReading(
      onPointCommanded(unreported, 'normal', NOW),
      reading({ position: 'normal' }),
      NOW,
    );
    expect(evaluateTimeout(confirmed, LATER, POLICY)).toBeNull();
  });

  it('returns null before the deadline elapses', () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const almostThere = new Date(NOW.getTime() + 7999);
    expect(evaluateTimeout(commanded, almostThere, POLICY)).toBeNull();
  });

  it('times out exactly at the deadline: timed-out, confirmedPosition unknown, awaitingSince cleared', () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const dueInstant = new Date(NOW.getTime() + 8000);
    const timedOut = evaluateTimeout(commanded, dueInstant, POLICY);
    expect(timedOut).not.toBeNull();
    expect(timedOut).toMatchObject({
      confirmation: 'timed-out',
      confirmedPosition: 'unknown',
      awaitingSince: null,
    });
    assertAwaitingInvariant(timedOut!);
  });

  it('a "none" point commanded and never reporting never times out — no deadline was armed (regression guard for the live layout)', () => {
    const commanded = onPointCommanded(initialPointState('p1', 'none', NOW), 'normal', NOW);
    expect(evaluateTimeout(commanded, new Date(NOW.getTime() + 100_000), POLICY)).toBeNull();
  });
});


// ─── evaluateStaleness (#167 D11) ───────────────────────────────────────────

/** A `required` point that has confirmed `normal` at `NOW` — the only state staleness can act on. */
function confirmedAt(now: Date, feedback: 'required' | 'none' = 'required'): PointState {
  const commanded = onPointCommanded(initialPointState('p1', feedback, now), 'normal', now);
  return applyPointReading(commanded, reading({ position: 'normal' }), now);
}

describe('evaluateStaleness (#167 D11)', () => {
  it('goes stale past the window: stale, confirmedPosition unknown, awaitingSince cleared', () => {
    const confirmed = confirmedAt(NOW);
    const past = new Date(NOW.getTime() + 90_001);
    const stale = evaluateStaleness(confirmed, past, POLICY);
    expect(stale).not.toBeNull();
    expect(stale).toMatchObject({
      confirmation: 'stale',
      confirmedPosition: 'unknown',
      awaitingSince: null,
    });
    assertAwaitingInvariant(stale!);
  });

  it('exactly at the window is still fresh — the boundary matches isSensorFresh', () => {
    const confirmed = confirmedAt(NOW);
    expect(evaluateStaleness(confirmed, new Date(NOW.getTime() + 90_000), POLICY)).toBeNull();
    expect(evaluateStaleness(confirmed, new Date(NOW.getTime() + 90_001), POLICY)).not.toBeNull();
  });

  it('a re-assert inside the window keeps the point confirmed indefinitely', () => {
    let p = confirmedAt(NOW);
    // Three re-asserts at the contract's 30 s interval, checked just before each.
    for (let i = 1; i <= 3; i += 1) {
      const justBefore = new Date(NOW.getTime() + i * 30_000 - 1);
      expect(evaluateStaleness(p, justBefore, POLICY)).toBeNull();
      p = applyPointReading(p, reading({ position: 'normal' }), new Date(NOW.getTime() + i * 30_000));
      expect(p.confirmation).toBe('confirmed');
    }
    // ...and it is the RE-ASSERTS holding it up. The last one landed at
    // NOW+90s, so the window runs out at NOW+180s and not before.
    expect(evaluateStaleness(p, new Date(NOW.getTime() + 180_000), POLICY)).toBeNull();
    expect(evaluateStaleness(p, new Date(NOW.getTime() + 180_001), POLICY)).not.toBeNull();
  });

  it("a 'none' point never goes stale — nothing reports on it (every live Westgate Hollow point today)", () => {
    const confirmed = confirmedAt(NOW, 'none');
    expect(evaluateStaleness(confirmed, new Date(NOW.getTime() + 10_000_000), POLICY)).toBeNull();
  });

  it("'unreported' stays unreported — D6's boot case is not a dead controller", () => {
    const unreported = initialPointState('p1', 'required', NOW);
    expect(unreported.lastReadingAt).toBeNull();
    expect(evaluateStaleness(unreported, new Date(NOW.getTime() + 10_000_000), POLICY)).toBeNull();
  });

  it("'pending' is left to the 8 s confirmation deadline, which fires far sooner", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'reverse', NOW);
    expect(evaluateStaleness(commanded, new Date(NOW.getTime() + 90_001), POLICY)).toBeNull();
  });

  it('never re-labels an already-latched fault state — a sharp fact is not replaced by a vaguer one', () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const wayLater = new Date(NOW.getTime() + 90_001);

    const mismatch = applyPointReading(commanded, reading({ position: 'reverse' }), NOW);
    expect(mismatch.confirmation).toBe('mismatch');
    expect(evaluateStaleness(mismatch, wayLater, POLICY)).toBeNull();

    const indeterminate = applyPointReading(commanded, reading({ position: 'unknown' }), NOW);
    expect(indeterminate.confirmation).toBe('indeterminate');
    expect(evaluateStaleness(indeterminate, wayLater, POLICY)).toBeNull();

    const timedOut = evaluateTimeout(commanded, new Date(NOW.getTime() + 8000), POLICY)!;
    expect(timedOut.confirmation).toBe('timed-out');
    expect(evaluateStaleness(timedOut, wayLater, POLICY)).toBeNull();
  });

  it('a reading stamped in the future reads as fresh — a clock skew must not untrust a healthy point', () => {
    const confirmed = confirmedAt(NOW);
    expect(evaluateStaleness(confirmed, new Date(NOW.getTime() - 10_000_000), POLICY)).toBeNull();
  });

  it('a stale point reads unknown through effectivePosition, which is what makes its edges untraversable', () => {
    const stale = evaluateStaleness(confirmedAt(NOW), new Date(NOW.getTime() + 90_001), POLICY)!;
    expect(effectivePosition(stale)).toBe('unknown');
  });

  it('recovers on the next reading, with no acknowledgement — it latched nothing to clear', () => {
    const stale = evaluateStaleness(confirmedAt(NOW), new Date(NOW.getTime() + 90_001), POLICY)!;
    const recovered = applyPointReading(
      stale,
      reading({ position: 'normal' }),
      new Date(NOW.getTime() + 91_000),
    );
    expect(recovered.confirmation).toBe('confirmed');
    expect(effectivePosition(recovered)).toBe('normal');
  });
});

// ─── effectivePosition / buildPointPositionMap ─────────────────────────────

describe('effectivePosition', () => {
  it("'required': trusts confirmedPosition only, full stop — even mid-command", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'reverse', NOW);
    expect(effectivePosition(commanded)).toBe('unknown'); // pending — confirmedPosition reset
  });

  it("'required': a mismatch reports the REPORTED position, not the commanded one", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const mismatched = applyPointReading(commanded, reading({ position: 'reverse' }), NOW);
    expect(effectivePosition(mismatched)).toBe('reverse');
  });

  it("a commanded 'required' point that times out reports effectivePosition 'unknown' — full stop, nothing substitutes", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    const timedOut = evaluateTimeout(commanded, new Date(NOW.getTime() + 8000), POLICY)!;
    expect(effectivePosition(timedOut)).toBe('unknown');
  });

  it("'none': falls back to commandedPosition when confirmedPosition is unknown", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'none', NOW), 'reverse', NOW);
    expect(effectivePosition(commanded)).toBe('reverse');
  });

  it("a commanded 'none' point that never reports keeps effectivePosition at the commanded position (it structurally never times out — see evaluateTimeout tests)", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'none', NOW), 'reverse', NOW);
    expect(evaluateTimeout(commanded, new Date(NOW.getTime() + 1_000_000), POLICY)).toBeNull();
    expect(effectivePosition(commanded)).toBe('reverse');
  });

  it("'none': falls back to 'unknown' when nothing was ever commanded or confirmed", () => {
    const p = initialPointState('p1', 'none', NOW);
    expect(effectivePosition(p)).toBe('unknown');
  });

  it("'none': prefers a confirmed reading over the commanded position once one lands", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'none', NOW), 'normal', NOW);
    const confirmed = applyPointReading(commanded, reading({ position: 'reverse' }), NOW);
    expect(effectivePosition(confirmed)).toBe('reverse');
  });
});

describe('buildPointPositionMap', () => {
  it('maps every point to its effectivePosition', () => {
    const points = new Map([
      ['p1', onPointCommanded(initialPointState('p1', 'none', NOW), 'normal', NOW)],
      ['p2', initialPointState('p2', 'required', NOW)],
    ]);
    const map = buildPointPositionMap(points);
    expect(map.get('p1')).toBe('normal');
    expect(map.get('p2')).toBe('unknown');
  });

  it('returns an empty map for an empty input', () => {
    expect(buildPointPositionMap(new Map()).size).toBe(0);
  });
});

// ─── confirmationArms ───────────────────────────────────────────────────────

describe('confirmationArms (D4)', () => {
  it('arms on a reading that confirms the commandedPosition', () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    expect(confirmationArms(commanded, reading({ position: 'normal' }))).toBe(true);
  });

  it('does not arm on a reading that disagrees with commandedPosition', () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    expect(confirmationArms(commanded, reading({ position: 'reverse' }))).toBe(false);
  });

  it('never commanded this session: arms on a sensor-sourced reading that is not unknown', () => {
    const p = initialPointState('p1', 'none', NOW);
    expect(confirmationArms(p, reading({ position: 'normal', source: 'sensor' }))).toBe(true);
  });

  it('never commanded this session: does NOT arm on a driver-sourced reading', () => {
    const p = initialPointState('p1', 'none', NOW);
    expect(confirmationArms(p, reading({ position: 'normal', source: 'driver' }))).toBe(false);
  });

  it("an 'unknown' reading never arms", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    expect(confirmationArms(commanded, reading({ position: 'unknown' }))).toBe(false);
  });

  it("a driver reading on a 'required' point never arms, even when its position matches commandedPosition", () => {
    const commanded = onPointCommanded(initialPointState('p1', 'required', NOW), 'normal', NOW);
    expect(confirmationArms(commanded, reading({ position: 'normal', source: 'driver' }))).toBe(false);
  });
});
