/**
 * `diagram/encoding.ts` — the sensor observation channel (#76).
 *
 * The rest of this module is constants; `sensorGlyphStateOf` is the one
 * piece of logic in it, mirroring how `routeStyle` earns the module's only
 * other test-worthy function. No other encoding module has its own test file
 * (the constants are exercised through their consumers), but a four-state
 * derivation with a load-bearing ordering (D-d: faulted/out-of-service
 * checked BEFORE `lastReading`) is worth pinning directly.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCK_TINT_OPACITY,
  OCCUPANCY,
  OCCUPANCY_WASH_OPACITY,
  SENSOR_OBSERVATION,
  sensorGlyphStateOf,
} from './encoding';
import { SensorObservationView } from '../types';

function view(overrides: Partial<SensorObservationView> = {}): SensorObservationView {
  return {
    sensorId: 's1',
    blockId: 'b1',
    type: 'block_detection',
    lastReading: null,
    trusted: true,
    inService: true,
    faulted: false,
    lastReadingAt: null,
    source: null,
    ...overrides,
  };
}

describe('sensorGlyphStateOf', () => {
  it('is "occupied" for a trusted, in-service, non-faulted occupied reading', () => {
    expect(sensorGlyphStateOf(view({ lastReading: 'occupied' }))).toBe('occupied');
  });

  it('is "clear" for a trusted, in-service, non-faulted clear reading', () => {
    expect(sensorGlyphStateOf(view({ lastReading: 'clear' }))).toBe('clear');
  });

  it('is "no-reading" for a sensor that has never reported', () => {
    expect(sensorGlyphStateOf(view({ lastReading: null }))).toBe('no-reading');
  });

  it('is "not-evidence" when untrusted, even with a perfectly good reading (D-d)', () => {
    expect(sensorGlyphStateOf(view({ lastReading: 'occupied', trusted: false }))).toBe('not-evidence');
    expect(sensorGlyphStateOf(view({ lastReading: 'clear', trusted: false }))).toBe('not-evidence');
  });

  it('is "not-evidence" when faulted, and takes priority over "no-reading" even though the backend nulls the reading on fault (D-d ordering)', () => {
    // A faulted sensor's `lastReading` is nulled server-side (DD6) — without
    // checking `faulted` FIRST this would fall through to `no-reading` and
    // lose the "not evidence" treatment #76 requires.
    expect(sensorGlyphStateOf(view({ faulted: true, lastReading: null }))).toBe('not-evidence');
  });

  it('is "not-evidence" when out of service, for the same reason as faulted', () => {
    expect(sensorGlyphStateOf(view({ inService: false, lastReading: null }))).toBe('not-evidence');
  });

  it('an untrusted, retained-only observation is "not-evidence", not hidden (#28 D-d)', () => {
    // The #76 case: a retained replay from a dead controller must not read
    // as live evidence, but it must not vanish either.
    const retained = view({ lastReading: 'clear', trusted: false, source: 'retained' });
    expect(sensorGlyphStateOf(retained)).toBe('not-evidence');
  });
});

describe('OCCUPANCY — non-colour carriers (#81, D10)', () => {
  it('only the fail-safe state carries a hatch — texture separates a fault from an operational state, never one operational state from another', () => {
    expect(OCCUPANCY.unknown.pattern).not.toBeNull();
    expect(OCCUPANCY.occupied.pattern).toBeNull();
    expect(OCCUPANCY.clear.pattern).toBeNull();
  });

  it('occupied and clear are both flat, so the wash opacity must separate them — colour alone is exactly what #81 forbids', () => {
    // Red #f38ba8 and green #a6e3a1 washed at the same opacity over the tile
    // surface come out 6.9 apart in RGB under simulated deuteranopia. The
    // heavier wash is what a deuteranope, a greyscale print and a washed-out
    // projector all still read.
    expect(OCCUPANCY_WASH_OPACITY.occupied).toBeGreaterThan(OCCUPANCY_WASH_OPACITY.clear);
  });

  it('leaves the resting layout at the ordinary tint opacity — only occupied is heavier', () => {
    expect(OCCUPANCY_WASH_OPACITY.clear).toBe(BLOCK_TINT_OPACITY);
    expect(OCCUPANCY_WASH_OPACITY.unknown).toBe(BLOCK_TINT_OPACITY);
  });

  it('every state still ships a distinct glyph and label', () => {
    const glyphs = Object.values(OCCUPANCY).map((e) => e.glyph);
    const labels = Object.values(OCCUPANCY).map((e) => e.label);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('SENSOR_OBSERVATION — non-colour carriers (#81)', () => {
  it('every state ships a distinct filled/dash combination — colour is never the only distinction', () => {
    const combos = Object.values(SENSOR_OBSERVATION).map((e) => `${e.filled}:${e.dash}`);
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('every state ships a non-empty glyph and label', () => {
    for (const encoding of Object.values(SENSOR_OBSERVATION)) {
      expect(encoding.glyph.length).toBeGreaterThan(0);
      expect(encoding.label.length).toBeGreaterThan(0);
    }
  });

  it('occupied is filled (a positive assertion); clear, not-evidence and no-reading are hollow', () => {
    expect(SENSOR_OBSERVATION.occupied.filled).toBe(true);
    expect(SENSOR_OBSERVATION.clear.filled).toBe(false);
    expect(SENSOR_OBSERVATION['not-evidence'].filled).toBe(false);
    expect(SENSOR_OBSERVATION['no-reading'].filled).toBe(false);
  });
});
