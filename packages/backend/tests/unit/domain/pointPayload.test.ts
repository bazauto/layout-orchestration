import { describe, it, expect } from 'vitest';
import { pointReadingSchema } from '../../../src/domain/pointPayload';

describe('pointReadingSchema', () => {
  it('accepts a well-formed sensor-sourced reading', () => {
    const result = pointReadingSchema.safeParse({
      pointId: 'p1',
      position: 'normal',
      source: 'sensor',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a reading with no updatedAt — optional', () => {
    const result = pointReadingSchema.safeParse({
      pointId: 'p1',
      position: 'reverse',
      source: 'driver',
    });
    expect(result.success).toBe(true);
  });

  it("accepts position: 'unknown' — unlike a command, a reading MAY be unknown", () => {
    const result = pointReadingSchema.safeParse({
      pointId: 'p1',
      position: 'unknown',
      source: 'sensor',
    });
    expect(result.success).toBe(true);
  });

  // ── Failure paths ────────────────────────────────────────────────────────

  it('rejects a bad position enum value', () => {
    const result = pointReadingSchema.safeParse({
      pointId: 'p1',
      position: 'thrown',
      source: 'sensor',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a bad source enum value', () => {
    const result = pointReadingSchema.safeParse({
      pointId: 'p1',
      position: 'normal',
      source: 'firmware',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing pointId', () => {
    const result = pointReadingSchema.safeParse({
      position: 'normal',
      source: 'sensor',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unexpected extra field (.strict())', () => {
    const result = pointReadingSchema.safeParse({
      pointId: 'p1',
      position: 'normal',
      source: 'sensor',
      extra: 'field',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object payload', () => {
    const result = pointReadingSchema.safeParse('not-an-object');
    expect(result.success).toBe(false);
  });
});
