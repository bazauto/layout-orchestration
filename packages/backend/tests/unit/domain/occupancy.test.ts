import { describe, it, expect } from 'vitest';
import {
  deriveBlockOccupancy,
  isContributingSensor,
  isSensorFaultArmed,
  toSensorFaultView,
  toSensorObservationView,
} from '../../../src/domain/occupancy';
import { SensorFault, SensorObservation } from '../../../src/domain/types';

function obs(overrides: Partial<SensorObservation> = {}): SensorObservation {
  return {
    sensorId: 's1',
    blockId: 'b1',
    type: 'block_detection',
    inService: true,
    faulted: false,
    // #28: the fixture describes a sensor that has been heard from live and
    // recently. These cases are about D3's three clauses, not about liveness,
    // and an untrusted default would make every one of them vacuously
    // `unknown`. The trust rule gets its own cases below.
    trusted: true,
    lastReading: null,
    lastReadingAt: null,
    lastLiveReadingAt: null,
    position: null,
    lastRisingEdgeAt: null,
    ...overrides,
  };
}

describe('isContributingSensor', () => {
  it('is true for an in-service, non-faulted sensor with a reading', () => {
    expect(isContributingSensor(obs({ lastReading: 'occupied' }))).toBe(true);
  });

  it('is false when out of service', () => {
    expect(isContributingSensor(obs({ lastReading: 'occupied', inService: false }))).toBe(false);
  });

  it('is false when faulted', () => {
    expect(isContributingSensor(obs({ lastReading: 'occupied', faulted: true }))).toBe(false);
  });

  it('is false when it has never reported', () => {
    expect(isContributingSensor(obs({ lastReading: null }))).toBe(false);
  });

  it('is false when untrusted, even with a perfectly good reading (#28 D9)', () => {
    expect(isContributingSensor(obs({ lastReading: 'clear', trusted: false }))).toBe(false);
    expect(isContributingSensor(obs({ lastReading: 'occupied', trusted: false }))).toBe(false);
  });
});

describe('deriveBlockOccupancy — sensor liveness (#28 D9)', () => {
  it("an untrusted detector's clear does NOT clear the block — it falls through to unknown", () => {
    // The #28 case at the derivation level: a dead controller's retained
    // `clear` is recorded on the observation and must resolve to `unknown`.
    // No fourth clause was added for this; the sensor is simply ineligible
    // and clause 3 does the rest.
    expect(deriveBlockOccupancy([obs({ lastReading: 'clear', trusted: false })])).toBe('unknown');
  });

  it("an untrusted detector's occupied does not raise occupancy either", () => {
    // Untrusted means "not evidence", in both directions. Raising occupancy
    // from a stale reading would be safe but wrong, and it would make a block
    // that a dead sensor last saw a train in permanently unroutable with no
    // way to tell why.
    expect(deriveBlockOccupancy([obs({ lastReading: 'occupied', trusted: false })])).toBe('unknown');
  });

  it('a stale sensor does NOT poison a block a trusted detector still covers', () => {
    // Deliberate, and a divergence from #28's original plan (which specified
    // "any untrusted sensor poisons"). That plan predates #34's derivation,
    // which had already settled the same question for a FAULTED sensor: it
    // contributes nothing and poisons nothing, because a `block_detection`
    // sensor is a whole-block monitor entitled to assert the block is empty.
    // Making silence poison while a device publishing garbage does not would
    // be an inconsistency pointing the wrong way.
    const stale = obs({ sensorId: 'dead', lastReading: 'clear', trusted: false });
    const live = obs({ sensorId: 'alive', lastReading: 'clear', trusted: true });
    expect(deriveBlockOccupancy([stale, live])).toBe('clear');
  });

  it('a trusted occupied still wins over a trusted clear — liveness does not disturb clause 1', () => {
    const occupied = obs({ sensorId: 'a', lastReading: 'occupied' });
    const clear = obs({ sensorId: 'b', lastReading: 'clear' });
    expect(deriveBlockOccupancy([occupied, clear])).toBe('occupied');
  });

  it('a trusted IR clear still clears nothing — clause 2 is untouched by #28', () => {
    // The subtle clause, and the reason liveness was added as a conjunct
    // rather than as a rewrite: only a `block_detection` sensor may assert
    // clear, and that must survive this change unaltered.
    expect(deriveBlockOccupancy([obs({ type: 'ir_position', lastReading: 'clear' })])).toBe('unknown');
  });
});

describe('deriveBlockOccupancy', () => {
  it('returns unknown for an empty observation set', () => {
    expect(deriveBlockOccupancy([])).toBe('unknown');
  });

  it('returns unknown when every observation is ineligible', () => {
    const observations = [
      obs({ sensorId: 's1', lastReading: 'occupied', inService: false }),
      obs({ sensorId: 's2', lastReading: 'clear', faulted: true }),
    ];
    expect(deriveBlockOccupancy(observations)).toBe('unknown');
  });

  it('a block_detection reading occupied resolves to occupied', () => {
    expect(deriveBlockOccupancy([obs({ type: 'block_detection', lastReading: 'occupied' })])).toBe(
      'occupied',
    );
  });

  it('a block_detection reading clear resolves to clear', () => {
    expect(deriveBlockOccupancy([obs({ type: 'block_detection', lastReading: 'clear' })])).toBe(
      'clear',
    );
  });

  it('an ir_position reading occupied resolves to occupied — IR may raise', () => {
    expect(deriveBlockOccupancy([obs({ type: 'ir_position', lastReading: 'occupied' })])).toBe(
      'occupied',
    );
  });

  it('an ir_position reading clear resolves to unknown, NOT clear — the failure path this module exists for', () => {
    expect(deriveBlockOccupancy([obs({ type: 'ir_position', lastReading: 'clear' })])).toBe(
      'unknown',
    );
  });

  it('IR clear plus detector clear resolves to clear (the detector governs)', () => {
    const observations = [
      obs({ sensorId: 'ir', type: 'ir_position', lastReading: 'clear' }),
      obs({ sensorId: 'det', type: 'block_detection', lastReading: 'clear' }),
    ];
    expect(deriveBlockOccupancy(observations)).toBe('clear');
  });

  it('IR occupied plus detector clear resolves to occupied — IR raises, never lowers', () => {
    const observations = [
      obs({ sensorId: 'ir', type: 'ir_position', lastReading: 'occupied' }),
      obs({ sensorId: 'det', type: 'block_detection', lastReading: 'clear' }),
    ];
    expect(deriveBlockOccupancy(observations)).toBe('occupied');
  });

  it('two disagreeing detectors resolve to occupied (fail-safe on conflict)', () => {
    const observations = [
      obs({ sensorId: 'd1', type: 'block_detection', lastReading: 'occupied' }),
      obs({ sensorId: 'd2', type: 'block_detection', lastReading: 'clear' }),
    ];
    expect(deriveBlockOccupancy(observations)).toBe('occupied');
  });

  it('detector faulted + IR clear in service resolves to unknown — the second D3 degraded case', () => {
    const observations = [
      obs({ sensorId: 'det', type: 'block_detection', lastReading: 'clear', faulted: true }),
      obs({ sensorId: 'ir', type: 'ir_position', lastReading: 'clear' }),
    ];
    expect(deriveBlockOccupancy(observations)).toBe('unknown');
  });

  it('detector in service + IR faulted is unaffected — the first D3 degraded case', () => {
    const observations = [
      obs({ sensorId: 'det', type: 'block_detection', lastReading: 'clear' }),
      obs({ sensorId: 'ir', type: 'ir_position', lastReading: 'occupied', faulted: true }),
    ];
    expect(deriveBlockOccupancy(observations)).toBe('clear');
  });

  it('excludes an out-of-service sensor from consideration', () => {
    const observations = [
      obs({ sensorId: 'det', type: 'block_detection', lastReading: 'clear', inService: false }),
    ];
    expect(deriveBlockOccupancy(observations)).toBe('unknown');
  });
});

function fault(overrides: Partial<SensorFault> = {}): SensorFault {
  return {
    sensorId: 's1',
    reason: 'Malformed sensor payload from sensor "s1" on topic "t1": bad shape',
    topic: 't1',
    faultedAt: new Date('2026-01-01T00:00:00.000Z'),
    consecutiveValidReadings: 0,
    ...overrides,
  };
}

describe('isSensorFaultArmed', () => {
  it('is false below the threshold', () => {
    expect(isSensorFaultArmed(fault({ consecutiveValidReadings: 2 }), 3)).toBe(false);
  });

  it('is true exactly at the threshold', () => {
    expect(isSensorFaultArmed(fault({ consecutiveValidReadings: 3 }), 3)).toBe(true);
  });

  it('is true above the threshold', () => {
    expect(isSensorFaultArmed(fault({ consecutiveValidReadings: 4 }), 3)).toBe(true);
  });
});

describe('toSensorFaultView', () => {
  it('projects every field, including the precomputed armed/requiredValidReadings', () => {
    const view = toSensorFaultView(fault({ consecutiveValidReadings: 3 }), 3);
    expect(view).toEqual({
      sensorId: 's1',
      reason: 'Malformed sensor payload from sensor "s1" on topic "t1": bad shape',
      topic: 't1',
      faultedAt: '2026-01-01T00:00:00.000Z',
      consecutiveValidReadings: 3,
      requiredValidReadings: 3,
      armed: true,
    });
  });

  it('armed is false when not yet at the threshold', () => {
    const view = toSensorFaultView(fault({ consecutiveValidReadings: 1 }), 3);
    expect(view.armed).toBe(false);
  });
});

describe('toSensorObservationView (#76, formerly excluded by DD10)', () => {
  it('projects every field, including a live reading as source: "live"', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const view = toSensorObservationView(
      obs({ lastReading: 'occupied', lastReadingAt: at, lastLiveReadingAt: at }),
    );
    expect(view).toEqual({
      sensorId: 's1',
      blockId: 'b1',
      type: 'block_detection',
      lastReading: 'occupied',
      trusted: true,
      inService: true,
      faulted: false,
      lastReadingAt: '2026-01-01T00:00:00.000Z',
      source: 'live',
    });
  });

  it('a retained-only reading (#28 D7) projects as source: "retained"', () => {
    // `lastLiveReadingAt` stays null on a retained delivery — see
    // `recordSensorReading`'s own comment — which is exactly the pair this
    // projection reads.
    const at = new Date('2026-01-01T00:00:00.000Z');
    const view = toSensorObservationView(
      obs({ lastReading: 'clear', trusted: false, lastReadingAt: at, lastLiveReadingAt: null }),
    );
    expect(view.source).toBe('retained');
    expect(view.trusted).toBe(false);
  });

  it('a live reading superseded by a later retained replay is still "retained" — the pair, not just presence', () => {
    // Same case #28 D7's comment on `SensorObservation.lastLiveReadingAt`
    // warns about: the two timestamps can disagree, and disagreement means
    // retained even though a live reading happened at some point.
    const liveAt = new Date('2026-01-01T00:00:00.000Z');
    const retainedAt = new Date('2026-01-01T01:00:00.000Z');
    const view = toSensorObservationView(
      obs({ lastReading: 'clear', lastReadingAt: retainedAt, lastLiveReadingAt: liveAt }),
    );
    expect(view.source).toBe('retained');
  });

  it('a sensor that has never reported projects source: null and lastReadingAt: null', () => {
    const view = toSensorObservationView(obs({ lastReading: null }));
    expect(view.source).toBeNull();
    expect(view.lastReadingAt).toBeNull();
  });

  it('an untrusted or faulted observation is projected, never omitted (D-d) — the caller decides what to do with it', () => {
    const view = toSensorObservationView(obs({ faulted: true, inService: false, trusted: false }));
    expect(view.faulted).toBe(true);
    expect(view.inService).toBe(false);
    expect(view.trusted).toBe(false);
  });
});
