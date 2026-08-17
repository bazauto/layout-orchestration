/**
 * #28 (docs/sensor-trust.md): the freshness predicate.
 *
 * Every case here is a failure path except the first — which is the point.
 * The interesting behaviour of this function is all in what it refuses to
 * believe.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SENSOR_FRESHNESS_TIMEOUT_MS,
  isSensorFresh,
} from '../../../src/domain/sensorTrust';
import { SensorObservation } from '../../../src/domain/types';

const NOW = new Date('2026-01-01T00:10:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function obs(overrides: Partial<SensorObservation> = {}): SensorObservation {
  return {
    sensorId: 's1',
    blockId: 'b1',
    type: 'block_detection',
    inService: true,
    faulted: false,
    trusted: true,
    lastReading: 'clear',
    lastReadingAt: NOW,
    lastLiveReadingAt: NOW,
    position: null,
    lastRisingEdgeAt: null,
    ...overrides,
  };
}

describe('isSensorFresh', () => {
  it('is true for a live reading received just now', () => {
    expect(isSensorFresh(obs(), NOW)).toBe(true);
  });

  it('is FALSE when no live reading has ever arrived, however recent the retained one', () => {
    // The whole #28 fix. A dead controller's archived `clear` is replayed on
    // every subscribe, so `lastReadingAt` is always "now" — and means nothing.
    const retainedOnly = obs({ lastLiveReadingAt: null, lastReadingAt: NOW });
    expect(isSensorFresh(retainedOnly, NOW)).toBe(false);
  });

  it('is false once the last live reading is older than the window', () => {
    expect(isSensorFresh(obs({ lastLiveReadingAt: ago(90_001) }), NOW)).toBe(false);
  });

  it('treats an age exactly equal to the timeout as FRESH, and one millisecond more as stale', () => {
    // D11 states the boundary explicitly so it is not re-litigated in review.
    expect(isSensorFresh(obs({ lastLiveReadingAt: ago(90_000) }), NOW)).toBe(true);
    expect(isSensorFresh(obs({ lastLiveReadingAt: ago(90_001) }), NOW)).toBe(false);
  });

  it('honours a caller-supplied timeout over the default', () => {
    const observation = obs({ lastLiveReadingAt: ago(10_000) });
    expect(isSensorFresh(observation, NOW, 5_000)).toBe(false);
    expect(isSensorFresh(observation, NOW, 30_000)).toBe(true);
  });

  it('defaults to three re-assert intervals', () => {
    expect(DEFAULT_SENSOR_FRESHNESS_TIMEOUT_MS).toBe(90_000);
    // Stated as a relationship, not a number: the window is meaningful only
    // as a multiple of the 30 s interval the contract obliges firmware to
    // re-assert on, and three of them absorbs two consecutive lost messages.
    expect(DEFAULT_SENSOR_FRESHNESS_TIMEOUT_MS).toBe(3 * 30_000);
  });

  it('reads a reading stamped in the FUTURE as fresh, never as stale', () => {
    // A clock skew must not be able to silently untrust a healthy sensor: the
    // resulting `unknown` is indistinguishable from a dead detector and would
    // send someone to the layout with a screwdriver.
    expect(isSensorFresh(obs({ lastLiveReadingAt: new Date(NOW.getTime() + 60_000) }), NOW)).toBe(true);
  });

  it('says nothing about faults or service state — those are separate ineligibility rules', () => {
    // `isSensorFresh` answers exactly one question. A faulted or out-of-service
    // sensor may perfectly well be fresh; `isContributingSensor` is where the
    // four rules are combined, and keeping them separate is what stops a
    // liveness change quietly altering fault semantics.
    expect(isSensorFresh(obs({ faulted: true }), NOW)).toBe(true);
    expect(isSensorFresh(obs({ inService: false }), NOW)).toBe(true);
  });
});
