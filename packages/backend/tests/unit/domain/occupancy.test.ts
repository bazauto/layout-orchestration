import { describe, it, expect } from 'vitest';
import {
  deriveBlockOccupancy,
  isContributingSensor,
  isSensorFaultArmed,
  toSensorFaultView,
} from '../../../src/domain/occupancy';
import { SensorFault, SensorObservation } from '../../../src/domain/types';

function obs(overrides: Partial<SensorObservation> = {}): SensorObservation {
  return {
    sensorId: 's1',
    blockId: 'b1',
    type: 'block_detection',
    inService: true,
    faulted: false,
    lastReading: null,
    lastReadingAt: null,
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
