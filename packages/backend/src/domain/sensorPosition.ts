/**
 * Sub-block sensor position (#77). See `docs/sensor-position.md` for the
 * decision record (D1–D12) this module implements.
 *
 * Pure — imports only `./types`, `./graph` and `./occupancy`, matching
 * `domain/braking.ts`'s posture. No clock: every function that needs "now"
 * takes it as an argument, so the caller reads the clock and this module stays
 * testable without one.
 *
 * Four things live here and nothing else does:
 *  - `positionFixFrom` — turning a sensor observation into an observation of a
 *    train, which happens only on a rising edge (D6);
 *  - `creditedDistanceMm` — what a fix is still worth once it has aged (D7);
 *  - `leadDistanceMm` — the whole of D9's rule, in one place, so
 *    `remainingRouteDistanceMm` gains one term rather than a policy;
 *  - `berthingBeamIn` — #7's mirror image of it at the other end of the route
 *    (`docs/automation.md` A3): where in the *destination* block a train should
 *    stop, from the same measured pair.
 *
 * **What is deliberately absent: anything that lowers occupancy.** A beam being
 * unbroken says nothing about the rest of its block however precisely its
 * position is known, so `deriveBlockOccupancy` clause 3 is untouched by this
 * feature and must stay so (D8).
 */

import { BlockId, PositionFix, SensorId, SensorObservation, SensorPosition } from './types';
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

/**
 * Where in `blockId` a train arriving from `fromBlockId` should be brought to a
 * stand, and which beam says so (#7, `docs/automation.md` A3).
 *
 * The mirror image of `leadDistanceMm`. That answers "how much of the block the
 * train is *in* still lies ahead of it"; this answers "how far *into* the block
 * ahead is the place it should stop". Same measured pair, same anchor rules,
 * opposite end of the route.
 *
 * **Both anchor directions are accepted**, because which one an operator
 * naturally measures to depends on the block:
 *
 * - measured toward `fromBlockId` (the boundary the train arrives over) — the
 *   beam is `offsetMm` past that boundary, so the answer is `offsetMm`. This is
 *   the terminal-platform case: the block's only neighbour *is* the one behind.
 * - measured toward any other neighbour (the far end) — the beam is `offsetMm`
 *   short of the far boundary, so the answer is `blockLengthMm - offsetMm`.
 *   This needs a measured block length; without one there is no far-end berth,
 *   and `DEFAULT_BLOCK_LENGTH_MM` is no more admissible here than in B4.
 *
 * **Returns the sensor id, not just a distance**, and that is load-bearing: the
 * beam whose position sets the stopping distance must be the same beam the
 * crawl watches for arrival. Returning a bare number would let the caller
 * select a different one and quietly disagree with itself.
 *
 * `null` — never a refusal — for every way of not having a usable beam: no
 * candidates, an untrusted sensor, an ambiguous anchor, an unmeasured block for
 * the far-end form, or an offset that does not land inside the block. The
 * caller falls through to `docs/braking.md` B4's boundary stop, which is what
 * makes berthing arrive incrementally as beams are fitted.
 *
 * **Several candidates take the minimum** — the beam nearest the entry
 * boundary. Two beams in one block is an operator saying "stop here" twice, and
 * honouring the earlier one is the fail-safe reading under every ordering.
 *
 * **Deliberately no decay.** `creditedDistanceMm` ages a lead fix because that
 * is an observation of a *moving train* and is stale the instant it is taken. A
 * berth offset is the position of a screwed-down piece of infrastructure and is
 * as true a minute later as when the tape came off it. Ageing it would be
 * ageing the wrong thing — and note this function reads no `now` at all, which
 * is what makes that structural rather than a comment.
 */
export function berthingBeamIn(
  observations: readonly SensorObservation[],
  graph: TrackGraph,
  blockId: BlockId,
  fromBlockId: BlockId,
  blockLengthMm: number | undefined,
): { sensorId: SensorId; offsetMm: number } | null {
  let best: { sensorId: SensorId; offsetMm: number } | null = null;

  for (const observation of observations) {
    // The same trust rule as `positionFixFrom`, minus the rising edge: a berth
    // is configuration, not an observation, so it needs no reading to exist —
    // but a sensor the system has stopped trusting for occupancy is not one to
    // stop a train against either.
    if (!isContributingSensor(observation)) continue;
    if (observation.blockId !== blockId) continue;
    if (observation.position === null) continue;

    const { towardBlockId, offsetMm } = observation.position;
    if (!isAnchorUnambiguous(graph, blockId, towardBlockId)) continue;

    const fromEntry =
      towardBlockId === fromBlockId
        ? offsetMm
        : blockLengthMm === undefined
          ? null
          : blockLengthMm - offsetMm;

    // A negative distance means the measurement and the block length disagree —
    // an offset longer than the block it is in. The write path refuses that
    // (#77 D4), so reaching it here means the block was re-measured shorter
    // afterwards. Declining the berth is the fail-safe reading; it stops the
    // train at the boundary instead.
    if (fromEntry === null || fromEntry < 0) continue;

    if (best === null || fromEntry < best.offsetMm) {
      best = { sensorId: observation.sensorId, offsetMm: fromEntry };
    }
  }

  return best;
}
