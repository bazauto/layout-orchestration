/**
 * Sub-block sensor position (#77). See `docs/sensor-position.md` for the
 * decision record (D1–D12) this module implements.
 *
 * Pure — imports only `./types`, `./graph` and `./occupancy`, matching
 * `domain/braking.ts`'s posture. No clock: every function that needs "now"
 * takes it as an argument, so the caller reads the clock and this module stays
 * testable without one.
 *
 * Three things live here and nothing else does:
 *  - `positionFixFrom` — turning a sensor observation into an observation of a
 *    train, which happens only on a rising edge (D6);
 *  - `creditedDistanceMm` — what a fix is still worth once it has aged (D7);
 *  - `leadDistanceMm` — the whole of D9's rule, in one place, so
 *    `remainingRouteDistanceMm` gains one term rather than a policy.
 *
 * **What is deliberately absent: anything that lowers occupancy.** A beam being
 * unbroken says nothing about the rest of its block however precisely its
 * position is known, so `deriveBlockOccupancy` clause 3 is untouched by this
 * feature and must stay so (D8).
 */

import { BlockId, PositionFix, SensorObservation, SensorPosition } from './types';
import { TrackGraph, edgesFrom } from './graph';
import { isContributingSensor } from './occupancy';

/**
 * The one place the two `sensors` position columns become a `SensorPosition`.
 *
 * **A half-set pair reads as unmeasured, not as corruption** (D5). The anchor
 * column is `ON DELETE SET NULL`, so deleting the neighbouring block leaves a
 * stranded offset by design, and the fail-safe reading of a stranded offset is
 * "we no longer know where this is" — not "the database is broken". Keeping
 * that rule here rather than in `parseSensorRow` is what stops it being
 * re-decided at each call site.
 *
 * Takes the two loose values rather than a `SensorRecord` so this module keeps
 * importing nothing outside `domain/`, and tolerates `undefined` as well as
 * `null` for the same reason it tolerates a half-set pair: every way of not
 * having a measurement must mean the same thing, and the only safe thing it can
 * mean is "unmeasured".
 */
export function sensorPositionOf(
  towardBlockId: string | null | undefined,
  offsetMm: number | null | undefined,
): SensorPosition | null {
  if (towardBlockId === null || towardBlockId === undefined) return null;
  if (offsetMm === null || offsetMm === undefined) return null;
  return { towardBlockId, offsetMm };
}

/**
 * The fastest anything on this layout could credibly be moving, in mm/s (D7).
 *
 * Used only to *subtract* a worst-case travel allowance from an aging fix, so
 * being wrong high is the fail-safe direction and being wrong low is the one to
 * avoid. 500 mm/s is roughly 85 scale mph at 1:76.2 — comfortably above
 * anything Westgate Hollow runs.
 *
 * Exported and named for the same reason `REFERENCE_STOPPING_DISTANCE_MM` is:
 * it is a deliberate over-estimate, not a measurement, and the correct response
 * to it being wrong high is to leave it alone.
 */
export const MAX_CREDIBLE_SPEED_MM_PER_S = 500;

/**
 * The fix a sensor observation currently supports, or `null`.
 *
 * `null` for every ordinary reason and no exceptional ones: the sensor is
 * unmeasured, belongs to no block, has never gone `clear → occupied` since it
 * was registered, or is not contributing at all — out of service, faulted, or
 * with its reading cleared, by exactly the rule `isContributingSensor` already
 * applies to occupancy (D9). A sensor the system has stopped trusting for
 * occupancy is not one to trust for position either.
 */
export function positionFixFrom(observation: SensorObservation): PositionFix | null {
  if (!isContributingSensor(observation)) return null;
  if (observation.blockId === null) return null;
  if (observation.position === null) return null;
  if (observation.lastRisingEdgeAt === null) return null;

  return {
    sensorId: observation.sensorId,
    blockId: observation.blockId,
    towardBlockId: observation.position.towardBlockId,
    offsetMm: observation.position.offsetMm,
    at: observation.lastRisingEdgeAt,
  };
}

/**
 * How far the train could have travelled since `fix.at` (D7), in mm — a bound,
 * not an estimate. Clamped at zero for a fix somehow stamped in the future, so
 * a clock skew can never *add* distance.
 */
export function travelAllowanceMm(fix: PositionFix, now: Date): number {
  const ageMs = now.getTime() - fix.at.getTime();
  if (ageMs <= 0) return 0;
  return (ageMs / 1000) * MAX_CREDIBLE_SPEED_MM_PER_S;
}

/**
 * What a fix is still worth: the measured offset less D7's travel allowance,
 * floored at zero.
 *
 * There is deliberately no expiry constant and no freshness cliff. An old fix
 * decays to nothing on its own, monotonically, which is both simpler to reason
 * about and impossible to tune wrong in the unsafe direction.
 */
export function creditedDistanceMm(fix: PositionFix, now: Date): number {
  return Math.max(0, fix.offsetMm - travelAllowanceMm(fix, now));
}

/**
 * Whether `towardBlockId` is a definite description of a boundary of
 * `fromBlockId` (D5).
 *
 * False when the drawing joins the two blocks nowhere — the offset then
 * measures to a boundary that does not exist — and false when it joins them in
 * more than one place, because "the boundary between b and c" is then not a
 * definite description and picking one is guessing.
 *
 * Counted over `edgesFrom`, one direction only: the compiler emits a row per
 * direction for a bidirectional connection, so counting both would read every
 * ordinary joint as a duplicate.
 */
export function isAnchorUnambiguous(
  graph: TrackGraph,
  fromBlockId: BlockId,
  towardBlockId: BlockId,
): boolean {
  let found = 0;
  for (const edge of edgesFrom(graph, fromBlockId)) {
    if (edge.toBlockId === towardBlockId) found++;
    if (found > 1) return false;
  }
  return found === 1;
}

/**
 * D9's whole rule: how much of `blockId` the system may promise still lies
 * ahead of the train, given every sensor observation registered against it.
 *
 * Returns `0` — never a refusal — when nothing applies. That is what makes this
 * feature purely additive: an absent, stale, inapplicable or ambiguous fix
 * falls straight through to `docs/braking.md` B4's worst case, so a run that
 * would have been granted before can never be refused because of it.
 *
 * `towardBlockId` is the block the train is about to enter. A fix measured
 * toward some *other* exit of a branching block is not applicable and
 * contributes nothing, because its offset says nothing about the distance to
 * the boundary actually being crossed.
 *
 * **Several applicable fixes take the minimum**, not the newest: a minimum
 * needs no argument about which observation supersedes which, and it is the
 * fail-safe pick under every ordering.
 */
export function leadDistanceMm(
  observations: readonly SensorObservation[],
  graph: TrackGraph,
  blockId: BlockId,
  towardBlockId: BlockId,
  now: Date,
): number {
  if (!isAnchorUnambiguous(graph, blockId, towardBlockId)) return 0;

  let best: number | null = null;
  for (const observation of observations) {
    const fix = positionFixFrom(observation);
    if (fix === null) continue;
    if (fix.blockId !== blockId) continue;
    if (fix.towardBlockId !== towardBlockId) continue;

    const credited = creditedDistanceMm(fix, now);
    if (best === null || credited < best) best = credited;
  }

  return best ?? 0;
}
