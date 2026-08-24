/**
 * Block occupancy derivation from per-sensor observations (D3,
 * docs/sensor-fault-recovery.md). Pure — imports only `./types`, same
 * posture as `domain/topology.ts` and `domain/routeLocking.ts`.
 *
 * Before this module, `LayoutService` folded whatever sensor last reported
 * straight into `BlockState.occupancy` — last write wins, regardless of
 * sensor type. That let a single `ir_position` beam clear an entire block on
 * its own say-so, which is exactly the "guess a train's position" failure
 * CLAUDE.md's fail-safe rule (safety rule 1) forbids: one beam being
 * unbroken is not evidence the whole block is empty. Occupancy is now a
 * derived projection, computed fresh from every sensor currently registered
 * against a block each time any one of them changes.
 */

import {
  Occupancy,
  SensorFault,
  SensorFaultView,
  SensorObservation,
  SensorObservationView,
} from './types';

/**
 * Whether an observation may contribute to a block's derived occupancy.
 * An out-of-service or faulted sensor contributes nothing (D1/D3): the
 * system has stopped trusting it. A sensor that has never reported (or was
 * just de-serviced/faulted and had its reading nulled — DD6) has nothing to
 * contribute either.
 *
 * `!o.trusted` is the fourth way to contribute nothing (#28 D9): a sensor
 * whose reading is known only from a retained replay, or from which no live
 * reading has arrived inside the freshness window, has stopped being evidence
 * of anything. It is one conjunct rather than a fourth clause in
 * `deriveBlockOccupancy` deliberately — see that function's note.
 *
 * Stays clock-free. `trusted` is a stored verdict `LayoutService` writes on
 * every live reading and every trust sweep (#28 D5), which is what spares this
 * predicate's other two consumers — `positionFixFrom` and `berthingBeamIn`,
 * both in `domain/sensorPosition.ts` — from having to be handed a clock.
 */
export function isContributingSensor(o: SensorObservation): boolean {
  return o.inService && !o.faulted && o.trusted && o.lastReading !== null;
}

/**
 * Derives a block's occupancy from every sensor registered against it (D3).
 * Callers pass ALL observations for the block; ineligible ones are filtered
 * here, not by the caller.
 *
 * Three ordered clauses, deliberately in this order and no other:
 *  1. Any eligible observation reading `occupied` wins outright — a
 *     detector asserting occupied, an IR beam broken, or two disagreeing
 *     detectors (one occupied, one clear) all resolve to `occupied`. This is
 *     the fail-safe choice on conflicting evidence, not an arbitrary pick.
 *  2. Otherwise, any eligible `block_detection` reading `clear` governs —
 *     a whole-block monitor is entitled to assert the block is empty.
 *  3. Otherwise `unknown`. This is what makes an IR `clear` a no-op rather
 *     than a fallback: clause 2 only looks at `block_detection` sensors, so
 *     a block with only an IR sensor (or an IR sensor plus a faulted
 *     detector) reporting `clear` falls through to `unknown` rather than
 *     being read as clear. An IR beam being unbroken says nothing about the
 *     rest of the block — do not "simplify" this back to last-write-wins.
 *     **Nor does #77's sub-block position change it** (`docs/sensor-position.md`
 *     D8): knowing precisely where a beam is makes a broken beam a position
 *     fix, and leaves an unbroken one saying exactly as much as it did before,
 *     which is nothing.
 *
 * **#28 adds no fourth clause, and that is deliberate.** The obvious shape for
 * sensor liveness was "any untrusted sensor poisons the block to `unknown`",
 * which would have meant rewriting these three. Instead an untrusted sensor is
 * simply not eligible (`isContributingSensor`), and a block whose every sensor
 * has gone quiet falls through clause 3 exactly as a block with no sensors
 * does. Clause 2 is the reason to care: it is load-bearing and subtle — only a
 * `block_detection` sensor may assert `clear` — and a flat "occupied wins, any
 * untrusted poisons, otherwise clear" rewrite would have silently regressed it
 * back to letting an IR beam clear a whole block.
 */
export function deriveBlockOccupancy(observations: readonly SensorObservation[]): Occupancy {
  const eligible = observations.filter(isContributingSensor);

  if (eligible.some((o) => o.lastReading === 'occupied')) {
    return 'occupied';
  }
  if (eligible.some((o) => o.type === 'block_detection' && o.lastReading === 'clear')) {
    return 'clear';
  }
  return 'unknown';
}

/** D1's arming rule, in one place so no caller re-implements it. */
export function isSensorFaultArmed(fault: SensorFault, requiredValidReadings: number): boolean {
  return fault.consecutiveValidReadings >= requiredValidReadings;
}

/** Projection for the wire. Pure — takes the threshold, calls no clock. */
export function toSensorFaultView(fault: SensorFault, requiredValidReadings: number): SensorFaultView {
  return {
    sensorId: fault.sensorId,
    reason: fault.reason,
    topic: fault.topic,
    faultedAt: fault.faultedAt.toISOString(),
    consecutiveValidReadings: fault.consecutiveValidReadings,
    requiredValidReadings,
    armed: isSensorFaultArmed(fault, requiredValidReadings),
  };
}

/**
 * Wire projection of a `SensorObservation` (#76, formerly excluded by DD10 —
 * see `docs/sensor-fault-recovery.md` D10). Pure, no clock, mirroring
 * `toSensorFaultView`'s posture exactly.
 *
 * `source` is derived from the `lastReadingAt`/`lastLiveReadingAt` pair rather
 * than stored as a third field on the runtime observation — that pair's own
 * comment on `SensorObservation` already rejects a provenance enum there, and
 * a wire-only view is the right place to compute one FOR DISPLAY without
 * carrying that decision back into runtime state.
 */
export function toSensorObservationView(observation: SensorObservation): SensorObservationView {
  const source: SensorObservationView['source'] =
    observation.lastReadingAt === null
      ? null
      : observation.lastLiveReadingAt !== null &&
          observation.lastLiveReadingAt.getTime() === observation.lastReadingAt.getTime()
        ? 'live'
        : 'retained';

  return {
    sensorId: observation.sensorId,
    blockId: observation.blockId,
    type: observation.type,
    lastReading: observation.lastReading,
    trusted: observation.trusted,
    inService: observation.inService,
    faulted: observation.faulted,
    lastReadingAt: observation.lastReadingAt?.toISOString() ?? null,
    source,
  };
}
