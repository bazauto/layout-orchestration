/**
 * Sensor liveness (#28, docs/sensor-trust.md). Pure — imports only `./types`,
 * the same posture as `domain/occupancy.ts` and `domain/sensorPosition.ts`.
 *
 * A retained MQTT message tells a new subscriber what was last published and
 * nothing at all about whether the publisher is still alive. A controller that
 * died reporting `clear` replays that `clear` to every future subscriber,
 * including a backend that has just restarted and has no other information
 * about that block. Before this module the backend believed it.
 *
 * The contract's answer is mandated re-assertion: hardware re-publishes its
 * current reading at least every 30 s (docs/mqtt-contract.md), so silence is
 * now a fact about the device rather than a fact about the traffic. This is
 * the predicate that reads that silence.
 */

import { SensorObservation } from './types';

/**
 * The freshness window's default, in ms — 3 × the contract's 30 s re-assert
 * interval (D11). Exported and named for the same reason
 * `MAX_CREDIBLE_SPEED_MM_PER_S` is: it is a deliberate tolerance, not a
 * measurement. Three intervals absorbs two consecutive lost messages, which is
 * what stops ordinary WiFi packet loss flapping a block to `unknown`.
 *
 * `config.sensors.freshnessTimeoutMs` is what production reads; this is the
 * fallback and the number the tests are written against.
 */
export const DEFAULT_SENSOR_FRESHNESS_TIMEOUT_MS = 90_000;

/**
 * Whether a sensor's reading may currently be believed.
 *
 * Two ordered clauses, both fail-safe:
 *
 *  1. **Never had a live reading — never fresh.** `lastLiveReadingAt === null`
 *     covers a sensor that has only ever been heard through a retained replay,
 *     and it is the whole of the #28 fix: the dead controller's archived
 *     `clear` arrives, is recorded, and is never promoted, so the block it
 *     reports stays `unknown` forever. Which is the truth.
 *  2. **Otherwise, age against the window.** Measured on the backend's own
 *     receipt clock, never on the payload's `updatedAt` (D4) — that timestamp
 *     is produced by the very device whose liveness is in question.
 *
 * The boundary is stated here so it is not re-litigated in review: an age
 * strictly greater than the timeout is stale, and **exactly equal is fresh**.
 *
 * A negative age (a reading stamped in the future, which under `ManualClock`
 * means a test advanced the clock backwards) reads as fresh rather than stale.
 * That is the same direction `travelAllowanceMm` clamps in and for a different
 * reason: a clock skew must not be able to silently untrust a healthy sensor,
 * because the resulting `unknown` looks exactly like a dead detector and would
 * send someone to the layout with a screwdriver.
 */
export function isSensorFresh(
  observation: SensorObservation,
  now: Date,
  timeoutMs: number = DEFAULT_SENSOR_FRESHNESS_TIMEOUT_MS,
): boolean {
  if (observation.lastLiveReadingAt === null) return false;
  return now.getTime() - observation.lastLiveReadingAt.getTime() <= timeoutMs;
}
