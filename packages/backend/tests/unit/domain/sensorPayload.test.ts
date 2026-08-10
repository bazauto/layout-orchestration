import { describe, it, expect } from 'vitest';
import { isEmptySensorPayload } from '../../../src/domain/sensorPayload';

describe('isEmptySensorPayload', () => {
  it("'' is an empty payload", () => {
    expect(isEmptySensorPayload('')).toBe(true);
  });

  // These must NOT be swallowed here — each is a real malformed payload that
  // must still reach Zod and trip a sensor fault (docs/sensor-fault-recovery.md D9).
  it('null is not an empty payload', () => {
    expect(isEmptySensorPayload(null)).toBe(false);
  });

  it('{} is not an empty payload', () => {
    expect(isEmptySensorPayload({})).toBe(false);
  });

  it('a whitespace-only string is not an empty payload', () => {
    expect(isEmptySensorPayload(' ')).toBe(false);
  });

  it("the string 'null' is not an empty payload", () => {
    expect(isEmptySensorPayload('null')).toBe(false);
  });
});
