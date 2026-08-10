/**
 * Outbound canned payloads for #65's sensor simulation panel. Pure — imports
 * only from `./types`, same posture as `domain/naming.ts`. What actually
 * publishes them (`SensorSimulationService`) lives in `services/`.
 */

import { MalformedVariant, SimulatedReadingAction } from './types';

export const MALFORMED_VARIANTS: readonly MalformedVariant[] = ['bad-enum', 'missing-field', 'not-an-object'];

/**
 * D5: three canned payloads chosen for three DISTINCT Zod failures, so a
 * scenario test can assert a predictable Safe-Stop for each. Never operator
 * free-text — the request names a variant, the server owns the bytes.
 */
export const MALFORMED_PAYLOADS: Record<MalformedVariant, unknown> = {
  'bad-enum': { state: 'banana' }, // fails z.enum
  'missing-field': {}, // `state` required
  'not-an-object': null, // not an object at all
};

/**
 * A payload that will pass `sensorReadingSchema` — byte-identical in shape
 * to what real hardware publishes (#65 D1/D12: no marker field, ever).
 */
export function buildSimulatedReading(
  state: 'occupied' | 'clear',
  now: Date,
): { state: 'occupied' | 'clear'; updatedAt: string } {
  return { state, updatedAt: now.toISOString() };
}

/**
 * The exact JSON value `SensorSimulationService` publishes for `action`.
 * Returns `null` for `clear-retained` — nothing is published as JSON for
 * that action (it publishes zero bytes via `IMqttAdapter.clearRetained`);
 * the caller branches on `action.action` for the transport call, so `null`
 * here is only ever used for the response echo and the log line.
 */
export function buildSimulatedPayload(action: SimulatedReadingAction, now: Date): unknown {
  switch (action.action) {
    case 'reading':
      return buildSimulatedReading(action.state, now);
    case 'malformed':
      return MALFORMED_PAYLOADS[action.variant];
    case 'clear-retained':
      return null;
  }
}
