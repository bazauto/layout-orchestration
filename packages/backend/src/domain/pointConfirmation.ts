/**
 * Point position confirmation — the pure state machine (#25,
 * docs/point-feedback.md D3/D5/D6/D7). Imports nothing outside `domain/`.
 *
 * No MQTT, no DCC, no clock reads: every function here takes `now` as a
 * parameter rather than reading a clock itself, the same purity rule
 * `domain/braking.ts` follows (B7) — the seam that makes this exercisable
 * from `ManualClock` without a real timer. `services/PointConfirmationService.ts`
 * is the thin, stateful wrapper around this module that `LayoutService`
 * actually calls.
 */

import {
  PointConfirmation,
  PointFault,
  PointFaultView,
  PointFeedbackMode,
  PointId,
  PointPosition,
  PointReading,
  PointState,
} from './types';

/** Confirmation-timeout policy (D5). `timeoutMs` defaults to 8000 in `LayoutService`'s config — this module knows nothing about the default. */
export interface PointConfirmationPolicy {
  timeoutMs: number;
}

/**
 * The state a point starts in — on registration at layout load, and (D2)
 * again on every backend restart: `'unreported'`, `confirmedPosition`
 * `'unknown'`, `commandedPosition` `null`. Nothing about confirmation
 * persists across a restart (D2/D10); only `feedback` is configuration.
 */
export function initialPointState(pointId: PointId, feedback: PointFeedbackMode, now: Date): PointState {
  return {
    pointId,
    commandedPosition: null,
    confirmedPosition: 'unknown',
    confirmation: 'unreported',
    positionFeedback: feedback,
    awaitingSince: null,
    lastReadingAt: null,
    locked: false,
    lockedByRoute: null,
    lastUpdated: now,
  };
}

/**
 * A command was just issued for this point. Always sets `commandedPosition`.
 *
 * For `positionFeedback: 'required'` this also arms the confirmation
 * deadline: `confirmation: 'pending'`, `awaitingSince: now`, and
 * `confirmedPosition` reset to `'unknown'` — the previous reading no longer
 * describes the point's position now that a new command is in flight. For
 * `'none'` no deadline runs and `confirmation` is left untouched (D7's
 * reduced guarantee for an uninstrumented point).
 */
export function onPointCommanded(p: PointState, position: 'normal' | 'reverse', now: Date): PointState {
  if (p.positionFeedback === 'required') {
    return {
      ...p,
      commandedPosition: position,
      confirmation: 'pending',
      awaitingSince: now,
      confirmedPosition: 'unknown',
      lastUpdated: now,
    };
  }
  return {
    ...p,
    commandedPosition: position,
    lastUpdated: now,
  };
}

/**
 * A `point/{pointId}/query` was just published for this point. Deliberately
 * does NOT arm a confirmation deadline (D6) — a query recovers position
 * live without asserting the backend commanded anything, so an unanswered
 * query leaves the point `unreported`/`unknown`, never faulted. A no-op on
 * state beyond `lastUpdated`.
 */
export function onPointQueried(p: PointState, now: Date): PointState {
  return { ...p, lastUpdated: now };
}

/**
 * A validated `point/{pointId}/reading` landed for this point. The
 * topic/payload id-mismatch check is NOT here — that is
 * `PointConfirmationService.applyReading`'s job, since it needs to know
 * which point the TOPIC named, not just what the payload claims.
 *
 * Rules (D3):
 *  - `reading.position === 'unknown'` → `'indeterminate'`,
 *    `confirmedPosition: 'unknown'`.
 *  - A `'driver'`-sourced reading on a `'required'` point → `'indeterminate'`,
 *    `confirmedPosition: 'unknown'` — a delivery acknowledgement is not a
 *    position confirmation, and accepting it as one would let a controller
 *    with no independent sensor silently defeat the whole feature.
 *  - Otherwise `confirmedPosition = reading.position`, and `confirmation` is
 *    `'confirmed'` when it equals `commandedPosition` (or `commandedPosition`
 *    is `null` — a query answer with nothing outstanding to disagree with),
 *    `'mismatch'` otherwise.
 *
 * Always clears `awaitingSince` and sets `lastReadingAt` — to `now`, never
 * `reading.reportedAt`, which is advisory only (see `PointReading`'s doc
 * comment).
 */
export function applyPointReading(p: PointState, reading: PointReading, now: Date): PointState {
  const base: PointState = { ...p, awaitingSince: null, lastReadingAt: now, lastUpdated: now };

  if (reading.position === 'unknown') {
    return { ...base, confirmedPosition: 'unknown', confirmation: 'indeterminate' };
  }
  if (reading.source === 'driver' && p.positionFeedback === 'required') {
    return { ...base, confirmedPosition: 'unknown', confirmation: 'indeterminate' };
  }

  const confirmation: PointConfirmation =
    p.commandedPosition === null || reading.position === p.commandedPosition ? 'confirmed' : 'mismatch';

  return { ...base, confirmedPosition: reading.position, confirmation };
}

/**
 * Applies D5's timeout predicate: `null` unless `confirmation === 'pending'`
 * and `now - awaitingSince >= policy.timeoutMs`, in which case
 * `'timed-out'`, `confirmedPosition: 'unknown'`, `awaitingSince: null`.
 *
 * Returning `null` for a non-pending point (rather than `p` unchanged) is
 * deliberate: it is what lets `PointConfirmationService.sweep` tell "this
 * point transitioned" from "this point had nothing to evaluate" without a
 * reference-equality check, and it is what keeps a sweep from re-publishing
 * every point on the layout every 250ms.
 */
export function evaluateTimeout(p: PointState, now: Date, policy: PointConfirmationPolicy): PointState | null {
  if (p.confirmation !== 'pending' || p.awaitingSince === null) return null;
  if (now.getTime() - p.awaitingSince.getTime() < policy.timeoutMs) return null;
  return {
    ...p,
    confirmation: 'timed-out',
    confirmedPosition: 'unknown',
    awaitingSince: null,
    lastUpdated: now,
  };
}

/**
 * The single place that decides what a point's position is trusted to be
 * (D7). Consumed by the UI and by any road-confirmation check — deliberately
 * NOT by the pathfinder: `domain/graph.ts#findPath` continues to ignore
 * point positions when searching (`docs/pathfinding.md` P3), because setting
 * the road is what granting a route means.
 *
 *  - `'required'` → `confirmedPosition`, full stop. Nothing about
 *    `commandedPosition` may substitute for it.
 *  - `'none'` → `confirmedPosition` if it is not `'unknown'`, otherwise
 *    `commandedPosition ?? 'unknown'` — the same trust model the system used
 *    for every point before this feature existed, preserved exactly for a
 *    point the operator has not opted in.
 */
export function effectivePosition(p: PointState): PointPosition {
  if (p.positionFeedback === 'required') {
    return p.confirmedPosition;
  }
  return p.confirmedPosition !== 'unknown' ? p.confirmedPosition : (p.commandedPosition ?? 'unknown');
}

/** `effectivePosition` over a whole points map — what a road-confirmation check or the UI actually wants. */
export function buildPointPositionMap(points: ReadonlyMap<PointId, PointState>): Map<PointId, PointPosition> {
  const positions = new Map<PointId, PointPosition>();
  for (const [pointId, state] of points) {
    positions.set(pointId, effectivePosition(state));
  }
  return positions;
}

/**
 * D4's arming rule, with no per-kind branching: does `reading` count toward
 * clearing a latched `PointFault`?
 *
 * A reading arms when it confirms the point at its `commandedPosition` — or,
 * if the point was never commanded this session, when it is a
 * `sensor`-sourced reading that is not `'unknown'`. An `'unknown'` reading
 * never arms, and neither does a `'driver'`-sourced reading on a `'required'`
 * point (D3: it can never actually confirm anything there). Retention is
 * NOT checked here — a retained reading is dropped by
 * `PointConfirmationService.applyReading` before this predicate is ever
 * reached (D1), so "non-retained" is satisfied by the caller rather than by
 * this function needing the flag.
 */
export function confirmationArms(p: PointState, reading: PointReading): boolean {
  if (reading.position === 'unknown') return false;
  if (reading.source === 'driver' && p.positionFeedback === 'required') return false;

  if (p.commandedPosition !== null) {
    return reading.position === p.commandedPosition;
  }
  return reading.source === 'sensor';
}

/**
 * D4's arming predicate for ACKNOWLEDGING a latched fault — mirrors
 * `isSensorFaultArmed` (`domain/occupancy.ts`) exactly. Added in Stage 2a
 * (`services/LayoutService.ts`) once a `getPointFaults`/`acknowledgePointFault`
 * pair needed to mirror the sensor one.
 */
export function isPointFaultArmed(fault: PointFault, requiredConfirmations: number): boolean {
  return fault.consecutiveConfirmations >= requiredConfirmations;
}

/** Projection for the wire (D4). Pure — takes the threshold, calls no clock. Mirrors `toSensorFaultView`. */
export function toPointFaultView(fault: PointFault, requiredConfirmations: number): PointFaultView {
  return {
    pointId: fault.pointId,
    kind: fault.kind,
    reason: fault.reason,
    faultedAt: fault.faultedAt.toISOString(),
    consecutiveConfirmations: fault.consecutiveConfirmations,
    requiredConfirmations,
    armed: isPointFaultArmed(fault, requiredConfirmations),
  };
}
