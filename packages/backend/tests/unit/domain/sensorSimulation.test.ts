import { describe, it, expect } from 'vitest';
import {
  buildSimulatedPayload,
  buildSimulatedReading,
  MALFORMED_PAYLOADS,
  MALFORMED_VARIANTS,
} from '../../../src/domain/sensorSimulation';
import { sensorReadingSchema } from '../../../src/services/validation';

describe('MALFORMED_PAYLOADS', () => {
  for (const variant of MALFORMED_VARIANTS) {
    it(`'${variant}' fails sensorReadingSchema`, () => {
      const result = sensorReadingSchema.safeParse(MALFORMED_PAYLOADS[variant]);
      expect(result.success).toBe(false);
    });
  }
});

describe('buildSimulatedReading', () => {
  it('produces a payload that passes sensorReadingSchema', () => {
    const reading = buildSimulatedReading('occupied', new Date('2026-01-01T00:00:00.000Z'));
    const result = sensorReadingSchema.safeParse(reading);
    expect(result.success).toBe(true);
  });

  it('carries no marker field distinguishing it from a hardware reading (#65 D12)', () => {
    const reading = buildSimulatedReading('clear', new Date('2026-01-01T00:00:00.000Z'));
    expect(Object.keys(reading).sort()).toEqual(['state', 'updatedAt']);
  });
});

describe('buildSimulatedPayload', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');

  it("action: 'reading' builds a valid reading payload", () => {
    const payload = buildSimulatedPayload({ action: 'reading', state: 'occupied', retain: true }, now);
    expect(sensorReadingSchema.safeParse(payload).success).toBe(true);
  });

  it("action: 'malformed' returns the canned payload for the variant byte-for-byte", () => {
    const payload = buildSimulatedPayload({ action: 'malformed', variant: 'bad-enum', retain: true }, now);
    expect(payload).toEqual(MALFORMED_PAYLOADS['bad-enum']);
  });

  it("action: 'clear-retained' returns null — nothing is published as JSON", () => {
    const payload = buildSimulatedPayload({ action: 'clear-retained' }, now);
    expect(payload).toBeNull();
  });
});
