/**
 * Per-loco braking model (#6). See `docs/braking.md` for the decision record
 * (B1–B10) this module implements.
 *
 * Pure — imports nothing outside `domain/`, and reads no clock and no I/O of
 * any kind. That purity is deliberate (B7): this module is a strictly
 * open-loop, dead-reckoning model. A commanded speed step, the reserved
 * track's measured length and — since #77 — an operator's sub-block
 * measurement are the only inputs it ever sees; it has no "actual speed" to be
 * tempted into reading.
 *
 * #77's lead term takes a `now` as an *argument* (`docs/sensor-position.md`
 * D7), which is not a hole in that rule: the caller reads the clock, this
 * module only subtracts. A `Date` arriving as data is no more a clock read than
 * a block length is a tape measure.
 *
 * Two entry points:
 *  - `planBrakingSchedule` computes a full stop, from a starting speed to
 *    zero, against a `StoppingDistanceModel` — pluggable so a per-loco
 *    measured curve can replace `scalarStoppingDistance` later without
 *    touching a caller (B2).
 *  - `remainingRouteDistanceMm` / `buildStopExpectation` / `isBrakingOverrun`
 *    are the route-aware half: how much measured track remains ahead of a
 *    train's confirmed position (B4), and the armed overrun check that
 *    catches a train reaching further than it was told to (B5).
 *
 * `services/BrakingService.ts` is what turns roster/state data into the
 * `BrakingProfile` this module takes; `LayoutService` (PR B) is what executes
 * a returned `BrakingSchedule` against a real `IClock`.
 */

import {
  BlockId,
  BrakingFault,
  BrakingFaultView,
  BrakingModelFault,
  BrakingProfile,
  BrakingRefusal,
  BrakingSchedule,
  BrakingStep,
  BrakingStopExpectation,
  Direction,
  NameBook,
  Occupancy,
  RouteReservation,
  SensorObservation,
} from './types';
import { TrackGraph, edgesFrom } from './graph';
import { blockLabel, edgeLabel, locoLabel, pointLabel } from './naming';
import { leadDistanceMm } from './sensorPosition';

// ─── Constants (B1, B3, B5) ────────────────────────────────────────────────────

/** Layout-wide reference stopping distance at full speed with `brakingFactor = 0` (B1). Unvalidated until Westgate Hollow is measured — see docs/braking.md's "Limits recorded rather than closed". */
export const REFERENCE_STOPPING_DISTANCE_MM = 1000;

/** Floor applied to any non-zero-speed stopping distance (B1) — `brakingFactor = 1.0` is representable and would otherwise assert a zero-distance stop, which is false for any real loco. Rounding up is the fail-safe direction. */
export const MIN_STOPPING_DISTANCE_MM = 50;

/** Interval between successive ramp commands (B3). */
export const BRAKING_TICK_MS = 250;

/** DCC speed steps shed per tick (B3). Loco-independent — see docs/braking.md B3 for why the ramp shape does not vary by `brakingFactor`. */
export const BRAKING_STEP_DECREMENT = 8;

/** Proportional safety margin added to every estimate before it is trusted (B5). */
export const BRAKING_SAFETY_MARGIN = 0.25;

/** Absolute safety margin floor (B5) — a proportional margin alone vanishes at low speed, exactly where the estimate is least reliable. */
export const BRAKING_SAFETY_FLOOR_MM = 100;

// ─── Stopping distance model (B1, B2) ──────────────────────────────────────────

export interface StoppingDistanceQuery {
  commandedSpeedStep: number;
  direction: Direction;
}

export type StoppingDistanceEstimate =
  | { known: true; distanceMm: number }
  | { known: false; fault: BrakingModelFault };

/**
 * How a stopping distance is predicted from a loco's braking profile and a
 * commanded speed (B2). `scalarStoppingDistance` is one value of this type;
 * a per-loco measured curve is a second, and touches no caller — every
 * caller of a `StoppingDistanceModel` depends on this function type, never
 * on `scalarStoppingDistance` directly.
 */
export type StoppingDistanceModel = (
  profile: BrakingProfile,
  query: StoppingDistanceQuery,
) => StoppingDistanceEstimate;

/** A valid DCC speed step: an integer in [0, 126]. Duplicated from `domain/safety.ts#isValidSpeed` rather than imported — `domain/safety.ts` carries system-status and authority policy this model has no business reaching into, which is the half of B7's purity rule that survives the `./naming` and `./sensorPosition` imports above. */
function isValidSpeedStep(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 126;
}

/**
 * B1's formula: `d(s) = REFERENCE_STOPPING_DISTANCE_MM * (1 - brakingFactor)
 * * (s / maxSpeed)^2`, floored at `MIN_STOPPING_DISTANCE_MM` for any `s > 0`.
 * Quadratic in normalised speed because that is what both constant
 * deceleration (`d = v²/2a`) and a fixed-rate speed ramp give.
 *
 * Refuses rather than clamps a `commandedSpeedStep` above `maxSpeed`
 * (`speed-exceeds-max`) — `maxSpeed` is advisory and unenforced elsewhere,
 * so a speed above it means the roster is wrong, and a clamped answer would
 * be an *under*-estimate, which is the unsafe direction to be wrong in.
 */
export const scalarStoppingDistance: StoppingDistanceModel = (profile, query) => {
  if (!Number.isFinite(profile.brakingFactor) || profile.brakingFactor < 0 || profile.brakingFactor > 1) {
    return {
      known: false,
      fault: { kind: 'invalid-braking-factor', brakingFactor: profile.brakingFactor },
    };
  }
  if (!isValidSpeedStep(profile.maxSpeed) || profile.maxSpeed <= 0) {
    return { known: false, fault: { kind: 'invalid-max-speed', maxSpeed: profile.maxSpeed } };
  }
  if (!isValidSpeedStep(query.commandedSpeedStep)) {
    return {
      known: false,
      fault: { kind: 'invalid-speed-step', commandedSpeedStep: query.commandedSpeedStep },
    };
  }
  if (query.commandedSpeedStep > profile.maxSpeed) {
    return {
      known: false,
      fault: {
        kind: 'speed-exceeds-max',
        commandedSpeedStep: query.commandedSpeedStep,
        maxSpeed: profile.maxSpeed,
      },
    };
  }
  const isMoving = query.commandedSpeedStep > 0;
  if (isMoving === (query.direction === 'stop')) {
    return {
      known: false,
      fault: {
        kind: 'speed-direction-mismatch',
        commandedSpeedStep: query.commandedSpeedStep,
        direction: query.direction,
      },
    };
  }

  if (query.commandedSpeedStep === 0) {
    return { known: true, distanceMm: 0 };
  }

  const normalised = query.commandedSpeedStep / profile.maxSpeed;
  const distanceMm = REFERENCE_STOPPING_DISTANCE_MM * (1 - profile.brakingFactor) * normalised ** 2;
  return { known: true, distanceMm: Math.max(distanceMm, MIN_STOPPING_DISTANCE_MM) };
};

/** `estimate + margin` (B5): the greater of the proportional margin and the absolute floor, so the margin never vanishes at low speed. */
export function requiredDistanceMm(estimateMm: number): number {
  return Math.max(estimateMm * (1 + BRAKING_SAFETY_MARGIN), estimateMm + BRAKING_SAFETY_FLOOR_MM);
}

// ─── Schedule planning (B3, B6) ─────────────────────────────────────────────────

export interface BrakingScheduleRequest {
  profile: BrakingProfile;
  fromCommandedSpeedStep: number;
  direction: Direction;
  /** Distance available for the stop, or `null` for an unconstrained calibration stop (B8). */
  availableDistanceMm: number | null;
  /**
   * The speed step the ramp ends at (#7, `docs/automation.md` A4). Defaults to
   * `0` — a full stop, which is every pre-#7 caller's behaviour byte-for-byte.
   * A berthing run passes the loco's crawl step instead.
   *
   * **This changes what the ramp commands, not what it requires.** The distance
   * check below is still the full-stop one, deliberately: "could this train
   * have come to a stand in the track available?" is answerable without
   * assuming the berthing beam works, and the slack it leaves over a ramp that
   * only has to reach crawl speed *is* the crawl allowance. See A4.
   */
  toSpeedStep?: number;
}

export type BrakingPlan =
  | { ok: true; schedule: BrakingSchedule }
  | { ok: false; reason: BrakingRefusal };

/**
 * Plans a full stop from `request.fromCommandedSpeedStep` to zero (B3).
 * Refuses outright — never a partial or best-effort schedule — if the loco
 * is already stopped, the model cannot estimate a distance for the request,
 * or the estimate (plus B5's margin) exceeds `request.availableDistanceMm`.
 *
 * The ramp shape (linear step-down, `BRAKING_STEP_DECREMENT` per
 * `BRAKING_TICK_MS`) does not depend on `model` or on `brakingFactor` — see
 * docs/braking.md B3 for why the ramp is loco-independent while the
 * predicted distance is not.
 */
export function planBrakingSchedule(
  request: BrakingScheduleRequest,
  model: StoppingDistanceModel = scalarStoppingDistance,
): BrakingPlan {
  const { profile, fromCommandedSpeedStep, direction, availableDistanceMm } = request;
  const toSpeedStep = request.toSpeedStep ?? 0;

  if (fromCommandedSpeedStep === 0) {
    return { ok: false, reason: { kind: 'already-stopped', locoAddress: profile.locoAddress } };
  }
  if (toSpeedStep >= fromCommandedSpeedStep) {
    return {
      ok: false,
      reason: { kind: 'target-speed-not-slower', fromSpeedStep: fromCommandedSpeedStep, toSpeedStep },
    };
  }

  const estimate = model(profile, { commandedSpeedStep: fromCommandedSpeedStep, direction });
  if (!estimate.known) {
    return { ok: false, reason: { kind: 'model-unavailable', fault: estimate.fault } };
  }

  // A4: the full-stop figure, whatever the ramp ends at. The slack this leaves
  // over a ramp that only has to reach `toSpeedStep` is the crawl allowance.
  const requiredMm = requiredDistanceMm(estimate.distanceMm);
  if (availableDistanceMm !== null && requiredMm > availableDistanceMm) {
    return {
      ok: false,
      reason: { kind: 'insufficient-distance', requiredMm, availableMm: availableDistanceMm },
    };
  }

  const steps = buildSteps(fromCommandedSpeedStep, toSpeedStep, direction);
  const schedule: BrakingSchedule = {
    locoAddress: profile.locoAddress,
    steps,
    estimatedStoppingDistanceMm: estimate.distanceMm,
    requiredDistanceMm: requiredMm,
    endsAtSpeedStep: toSpeedStep,
    totalDurationMs: steps[steps.length - 1].atOffsetMs,
  };
  return { ok: true, schedule };
}

/**
 * Linear step-down from `fromSpeedStep` to `toSpeedStep` (B3, extended by #7's
 * A4). The first step is issued immediately (`atOffsetMs: 0`) and is already
 * below the current speed — the loop always runs at least once because
 * `planBrakingSchedule` has already refused `fromSpeedStep === 0` and
 * `toSpeedStep >= fromSpeedStep` before calling this.
 *
 * The decrement is clamped at `toSpeedStep`, so a ramp ending at a crawl stops
 * there rather than stepping past it, and the last step keeps `direction`
 * rather than becoming `'stop'` — a crawling train is still moving, and
 * commanding `'stop'` at a non-zero speed step is the
 * `speed-direction-mismatch` the model refuses on the way in.
 */
function buildSteps(fromSpeedStep: number, toSpeedStep: number, direction: Direction): BrakingStep[] {
  const steps: BrakingStep[] = [];
  let s = fromSpeedStep;
  let t = 0;
  while (s > toSpeedStep) {
    s = Math.max(toSpeedStep, s - BRAKING_STEP_DECREMENT);
    steps.push({ atOffsetMs: t, speedStep: s, direction: s === 0 ? 'stop' : direction });
    t += BRAKING_TICK_MS;
  }
  return steps;
}

// ─── Route-aware distance (B4, B5) ─────────────────────────────────────────────

/**
 * Sums `blocks.length_mm` over the route's **intermediate** blocks — path
 * indices `confirmedIndex + 1` through `targetIndex - 1` inclusive — which is
 * the track between the exit boundary of the train's last confirmed block and
 * the entry boundary of `targetIndex` (B4).
 *
 * The target block contributes nothing: B4's target is its *entry* boundary,
 * not its far end. The confirmed block contributes nothing **either, unless
 * `lead` supplies a sub-block position fix** (#77 D9) — without one the train
 * may be anywhere within it, including hard against the exit.
 *
 * **Joints contribute zero** (D5, `docs/track-graph-compilation.md`). The
 * undetected trackwork between two detected sections is not modelled, which
 * underestimates the available distance and therefore brakes early — the safe
 * direction.
 *
 * **`lead` can only ever hand back distance this model previously refused to
 * promise.** Every way of not having a usable fix — no observations, an
 * unmeasured or untrusted sensor, a fix measured toward a different exit of a
 * branching block, an ambiguous anchor, or one aged past its travel allowance —
 * contributes `0` and falls straight through to the B4 sum. Omitting `lead`
 * entirely reproduces the pre-#77 behaviour exactly, which is what makes it
 * impossible for this feature to turn a run that would have been granted into
 * one that is refused.
 *
 * **B4's adjacent-target case is what this is for.** When
 * `targetIndex === confirmedIndex + 1` there are no intermediate blocks and the
 * sum is `0`; without a fix `planBrakingSchedule` then refuses
 * `insufficient-distance`, which is correct under block-level occupancy and is
 * the whole reason #77 was promoted ahead of #7. With a fix the lead term is
 * the only distance there is, and it is honestly bounded.
 *
 * **`berthOffsetMm` is #7's mirror of `lead` at the far end** (A2/A3): how far
 * *past* the entry boundary of `path[targetIndex]` the train is being asked to
 * run, because the stopping point is a beam inside the destination block rather
 * than its entry boundary. Resolved by the caller via
 * `sensorPosition.ts#berthingBeamIn` and passed in as a plain number, so the
 * beam whose offset sets this distance is provably the same beam the crawl then
 * watches for arrival — selecting it twice is how the two would come to
 * disagree.
 *
 * Like `lead` it is purely additive and omitting it reproduces B4's answer
 * exactly, and like `lead` a negative value cannot subtract: it is clamped at
 * zero. Unlike `lead` it does not decay, because it is the position of a
 * screwed-down beam and not an observation of a moving train (A3).
 *
 * Refuses `unmeasured-track` on the first block with no measured length,
 * naming it. Deliberately does **not** fall back to `DEFAULT_BLOCK_LENGTH_MM`
 * (the pathfinder's cost-only guess, P2 in docs/pathfinding.md) — guessing a
 * cost to steer a search is fine; guessing a stopping distance is a collision
 * if the guess is short. The lead term is not an exception to that rule: it is
 * a measurement an operator took, decayed by a bound, not a guess.
 */
export function remainingRouteDistanceMm(
  reservation: RouteReservation,
  graph: TrackGraph,
  targetIndex: number,
  lead?: { observations: readonly SensorObservation[]; now: Date },
  berthOffsetMm?: number,
): { ok: true; distanceMm: number } | { ok: false; reason: BrakingRefusal } {
  if (targetIndex <= reservation.confirmedIndex) {
    return {
      ok: false,
      reason: { kind: 'target-behind-train', targetIndex, confirmedIndex: reservation.confirmedIndex },
    };
  }

  let distanceMm = 0;
  for (let i = reservation.confirmedIndex + 1; i < targetIndex; i++) {
    const blockId = reservation.path[i].blockId;
    const lengthMm = graph.blockLengthsMm.get(blockId);
    if (lengthMm === undefined) {
      return { ok: false, reason: { kind: 'unmeasured-track', blockId } };
    }
    distanceMm += lengthMm;
  }

  return {
    ok: true,
    distanceMm: distanceMm + leadTermMm(reservation, graph, lead) + Math.max(0, berthOffsetMm ?? 0),
  };
}

/**
 * The confirmed block's contribution (#77 D9), or `0`.
 *
 * The fix must be measured toward `path[confirmedIndex + 1]` — the boundary the
 * train is about to cross — and not toward some other exit of a branching
 * block, whose offset says nothing about the distance that matters here. Both
 * path steps are read defensively: a reservation whose `confirmedIndex` has run
 * off the end of its own path is a bug elsewhere, and the right response to one
 * is to promise nothing rather than to index into `undefined`.
 */
function leadTermMm(
  reservation: RouteReservation,
  graph: TrackGraph,
  lead: { observations: readonly SensorObservation[]; now: Date } | undefined,
): number {
  if (!lead) return 0;

  const confirmed = reservation.path[reservation.confirmedIndex];
  const next = reservation.path[reservation.confirmedIndex + 1];
  if (!confirmed || !next) return 0;

  return leadDistanceMm(lead.observations, graph, confirmed.blockId, next.blockId, lead.now);
}

/**
 * Builds the overrun expectation for a run stopping at `targetIndex` (B5): a
 * snapshot of every block id at or beyond `targetIndex` on the route. Taken
 * once, at run start — not a live query — so the overrun check it feeds
 * needs no reservation lookup and cannot race the release path in
 * `LayoutService.recomputeBlock`.
 */
export function buildStopExpectation(
  reservation: RouteReservation,
  targetIndex: number,
): BrakingStopExpectation {
  return {
    locoAddress: reservation.locoAddress,
    routeId: reservation.id,
    targetIndex,
    forbiddenBlockIds: reservation.path.slice(targetIndex).map((step) => step.blockId),
  };
}

/**
 * The overrun expectation for a **berthing** run (#7, `docs/automation.md` A9):
 * every block the graph joins to the destination, less the one the train
 * arrived from. "The track beyond the end of the route."
 *
 * `buildStopExpectation` is exactly wrong for a berthing run and this exists
 * because of it. That one forbids `path.slice(targetIndex)`, which for a
 * berthing run *contains the destination block* — the block the train is
 * supposed to end up in. Armed unchanged, a textbook berthing arrival would
 * Safe-Stop the layout at the instant it succeeded.
 *
 * What this catches is the thing nothing caught before #7: a train running out
 * past its destination into track no route holds. `onOccupancyChange` finds the
 * route holding the block that changed, and an unreserved block has no holder,
 * so a runaway raised nothing at all.
 *
 * `targetIndex` is recorded as the destination step for the record, though
 * nothing reads it back for a berthing expectation — the forbidden set is
 * derived from the graph, not from a path slice.
 *
 * **A terminal destination yields an empty forbidden set**, and that is honest
 * rather than broken: there is no block past the buffers to detect a train that
 * reaches them. Recorded as a limit in A9.
 */
export function buildBerthExpectation(
  reservation: RouteReservation,
  graph: TrackGraph,
): BrakingStopExpectation {
  const destinationIndex = reservation.path.length - 1;
  const destinationBlockId = reservation.path[destinationIndex]?.blockId;
  const arrivedFromBlockId = reservation.path[destinationIndex - 1]?.blockId ?? null;

  const forbidden = new Set<BlockId>();
  if (destinationBlockId !== undefined) {
    for (const edge of edgesFrom(graph, destinationBlockId)) {
      if (edge.toBlockId !== arrivedFromBlockId) forbidden.add(edge.toBlockId);
    }
  }

  return {
    locoAddress: reservation.locoAddress,
    routeId: reservation.id,
    targetIndex: destinationIndex,
    forbiddenBlockIds: [...forbidden],
  };
}

/**
 * Whether `blockId` reading `occupancy` violates `expectation` (B5): the
 * train has reached the target block or beyond. Only `occupied` counts —
 * `clear`/`unknown` are never evidence of an overrun on their own.
 */
export function isBrakingOverrun(
  expectation: BrakingStopExpectation,
  blockId: BlockId,
  occupancy: Occupancy,
): boolean {
  return occupancy === 'occupied' && expectation.forbiddenBlockIds.includes(blockId);
}

// ─── Projections and description ───────────────────────────────────────────────

/** Wire projection of `BrakingFault`, mirroring `toRouteFaultView`/`toSensorFaultView`. Pure — takes no clock. */
export function toBrakingFaultView(fault: BrakingFault): BrakingFaultView {
  return {
    locoAddress: fault.locoAddress,
    kind: fault.kind,
    reason: fault.reason,
    routeId: fault.routeId,
    blockId: fault.blockId,
    faultedAt: fault.faultedAt.toISOString(),
  };
}

function describeBrakingModelFault(fault: BrakingModelFault): string {
  switch (fault.kind) {
    case 'invalid-braking-factor':
      return `braking factor ${fault.brakingFactor} is not in [0, 1]`;
    case 'invalid-max-speed':
      return `max speed ${fault.maxSpeed} is not a valid DCC speed step`;
    case 'invalid-speed-step':
      return `commanded speed step ${fault.commandedSpeedStep} is not a valid DCC speed step`;
    case 'speed-exceeds-max':
      return `commanded speed step ${fault.commandedSpeedStep} exceeds max speed ${fault.maxSpeed}`;
    case 'speed-direction-mismatch':
      return `commanded speed step ${fault.commandedSpeedStep} is inconsistent with direction ${fault.direction}`;
  }
}

/** Human-readable summary of a refusal, for HTTP error bodies and log messages, mirroring `describeRejections`. */
export function describeBrakingRefusal(reason: BrakingRefusal, book?: NameBook): string {
  switch (reason.kind) {
    case 'model-unavailable':
      return `braking model unavailable: ${describeBrakingModelFault(reason.fault)}`;
    case 'already-stopped':
      return `loco ${locoLabel(reason.locoAddress, book)} is already stopped`;
    case 'insufficient-distance':
      return `required stopping distance ${reason.requiredMm}mm exceeds available distance ${reason.availableMm}mm`;
    case 'unmeasured-track':
      return `block ${blockLabel(reason.blockId, book)} has no measured length — unsafe for automated braking`;
    case 'unknown-edge':
      return `edge ${edgeLabel(reason.edgeId, book)} does not exist in the current track graph`;
    case 'target-behind-train':
      return `target index ${reason.targetIndex} is not ahead of confirmed index ${reason.confirmedIndex}`;
    case 'target-speed-not-slower':
      return `a ramp cannot end at speed step ${reason.toSpeedStep} when it starts from ${reason.fromSpeedStep}`;
    case 'unknown-loco':
      return `loco ${locoLabel(reason.locoAddress, book)} is not in the roster`;
    case 'ambiguous-loco':
      return `loco ${locoLabel(reason.locoAddress, book)} has ${reason.count} roster entries`;
    case 'unknown-loco-state':
      return `loco ${locoLabel(reason.locoAddress, book)} has no known commanded state`;
    case 'system-not-online':
      return `system is ${reason.status}, not online`;
    case 'auto-not-permitted':
      return `system status ${reason.status} / mode ${reason.mode} does not permit an automated command`;
    case 'manual-authority':
      return `route ${reason.routeId} is manual authority`;
    case 'route-not-active':
      return `route ${reason.routeId} is ${reason.status}, not active`;
    case 'point-not-confirmed':
      return `point ${pointLabel(reason.pointId, book)} is not confirmed ${reason.requiredPosition} (reads ${reason.effectivePosition}) — the road this plan measures along may not be set`;
    case 'command-rejected':
      return `command rejected: ${reason.message}`;
  }
}
