/**
 * PointConfirmationService
 *
 * Owns #25's point-confirmation policy as a stateful wrapper around the pure
 * transitions in `domain/pointConfirmation.ts` — the same split
 * `ReservationService` draws around `domain/routeLocking.ts`. No MQTT, no
 * DCC, no timer: every method here returns an outcome and mutates
 * `LayoutStateManager`; `LayoutService` (Stage 2a) is what publishes
 * `point/{id}/state`, latches a `PointFault` into `SystemHealth`, and drives
 * the `IClock.setInterval` sweep that calls `sweep()` on a schedule. This
 * service never calls back into `LayoutService`.
 */

import {
  applyPointReading,
  confirmationArms,
  evaluateStaleness,
  evaluateTimeout,
  onPointCommanded,
  onPointQueried,
  PointConfirmationPolicy,
} from '../domain/pointConfirmation';
import { PointId, PointReading, PointState } from '../domain/types';
import { LayoutStateManager } from '../domain/layoutState';

/**
 * Why `applyReading` could not apply a reading at all — distinct from the
 * ordinary `PointConfirmation` outcomes (`mismatch`, `indeterminate`, ...),
 * which DO apply and are visible on the returned `PointState`. Both members
 * mutate nothing (#25 plan, decision 4): an unknown topic point id is
 * dropped with a warn and latches no fault, and an id-mismatch on a KNOWN
 * point is likewise dropped here — `LayoutService` is what turns the latter
 * into a latched `PointFault` (a Fail-Safe Trigger per
 * docs/mqtt-contract.md), since this service has no `SystemHealth` access.
 */
export type PointReadingRejection =
  | { kind: 'unknown-point'; pointId: PointId }
  | { kind: 'id-mismatch'; topicPointId: PointId; payloadPointId: PointId };

/**
 * The result of `applyReading`. `point` is the resulting `PointState` only
 * when this reading actually changed something — `null` for every rejected
 * or dropped case (unknown point, id-mismatch, or a retained reading, D1),
 * so a caller can safely treat "publish `point/state` when `point` is
 * non-null" as the whole rule.
 */
export interface PointReadingOutcome {
  point: PointState | null;
  rejection: PointReadingRejection | null;
  /** Whether this reading counts toward clearing a latched `PointFault` (D4) — `LayoutService`'s to act on, this service does not touch `SystemHealth`. */
  arms: boolean;
}

export class PointConfirmationService {
  constructor(
    private readonly stateManager: LayoutStateManager,
    private readonly policy: PointConfirmationPolicy,
  ) {}

  /** A point command was just issued. `null` for an unregistered point id — a no-op, mirroring `LayoutStateManager.setPointState`. */
  noteCommanded(pointId: PointId, position: 'normal' | 'reverse', now: Date): PointState | null {
    const existing = this.stateManager.getPoint(pointId);
    if (!existing) return null;
    return this.stateManager.setPointState(pointId, onPointCommanded(existing, position, now));
  }

  /** A `point/{pointId}/query` was just published. `null` for an unregistered point id. Never arms a deadline (D6). */
  noteQueried(pointId: PointId, now: Date): PointState | null {
    const existing = this.stateManager.getPoint(pointId);
    if (!existing) return null;
    return this.stateManager.setPointState(pointId, onPointQueried(existing, now));
  }

  /**
   * Applies one validated `point/{topicPointId}/reading` payload.
   *
   * Order, and why: `topicPointId` must resolve to a point in this layout's
   * state FIRST — an unknown point is dropped with a warn and latches
   * nothing regardless of anything else the payload says (#25 plan decision
   * 4). Next, the payload's own `pointId` must equal `topicPointId` — a
   * mismatch is a Fail-Safe Trigger (docs/mqtt-contract.md) independent of
   * retention, so it is checked before the retained short-circuit. Only
   * then does D1's retained-reading rule apply: a retained reading on a
   * correctly-addressed, known point is dropped — it confirms nothing and
   * arms nothing towards a fault clearing, and is deliberately not faulted
   * on its own.
   */
  applyReading(topicPointId: PointId, reading: PointReading, now: Date, retained: boolean): PointReadingOutcome {
    const existing = this.stateManager.getPoint(topicPointId);
    if (!existing) {
      return { point: null, rejection: { kind: 'unknown-point', pointId: topicPointId }, arms: false };
    }

    if (reading.pointId !== topicPointId) {
      return {
        point: null,
        rejection: { kind: 'id-mismatch', topicPointId, payloadPointId: reading.pointId },
        arms: false,
      };
    }

    if (retained) {
      return { point: null, rejection: null, arms: false };
    }

    const arms = confirmationArms(existing, reading);
    const next = applyPointReading(existing, reading, now);
    const stored = this.stateManager.setPointState(topicPointId, next);
    return { point: stored, rejection: null, arms };
  }

  /**
   * Applies `evaluateTimeout` (D5) and then `evaluateStaleness` (D11) to every
   * registered point, storing and returning only the ones that transitioned —
   * never the whole layout, so a caller publishing `point/state` per entry does
   * not re-publish every point on the layout on every 250ms tick.
   *
   * The two predicates cannot both fire on one point: a timeout needs
   * `'pending'` and staleness needs `'confirmed'`. Evaluating the timeout first
   * and the staleness against its result is therefore ordering for clarity
   * rather than for correctness — but it is the ordering that stays correct if
   * either predicate's precondition is ever widened, because a point that has
   * just timed out is already `'timed-out'` and no longer a staleness
   * candidate.
   *
   * The caller distinguishes the two outcomes by the returned
   * `confirmation` — `'timed-out'` is a fault, `'stale'` is a degrade — which is
   * the same discrimination `runConfirmationSweep` already did for the one kind.
   */
  sweep(now: Date): PointState[] {
    const transitioned: PointState[] = [];
    for (const point of this.stateManager.getState().points.values()) {
      const timedOut = evaluateTimeout(point, now, this.policy);
      const next = evaluateStaleness(timedOut ?? point, now, this.policy) ?? timedOut;
      if (next) {
        transitioned.push(this.stateManager.setPointState(point.pointId, next));
      }
    }
    return transitioned;
  }

  /** Every point configured `positionFeedback: 'required'` — what `LayoutService` queries on startup and on every MQTT reconnect (D2). */
  pointsRequiringFeedback(): PointId[] {
    const ids: PointId[] = [];
    for (const point of this.stateManager.getState().points.values()) {
      if (point.positionFeedback === 'required') ids.push(point.pointId);
    }
    return ids;
  }
}
