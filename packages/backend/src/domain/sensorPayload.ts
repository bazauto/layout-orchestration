/**
 * Ingestion-side predicate for #65 D7 / docs/sensor-fault-recovery.md D9.
 * Imports nothing — pure, like the rest of `domain/`.
 */

/**
 * True only for a genuinely zero-byte MQTT payload — an MQTT retained-clear
 * (#65 D6/D7), which asserts nothing about occupancy.
 *
 * Strict by design. `null` is one of D5's canned malformed variants, `{}` is
 * another, and a whitespace-only body is a real malformed payload; all three
 * must fall through to Zod and Safe-Stop. Only a zero-length string qualifies,
 * which is what BOTH adapters deliver for a zero-byte message: MqttAdapter
 * because `JSON.parse('')` throws and the raw string is forwarded
 * (MqttAdapter.ts:96-111), SimulatedMqttAdapter because `clearRetained`
 * delivers `''` to match it.
 */
export function isEmptySensorPayload(payload: unknown): boolean {
  return typeof payload === 'string' && payload.length === 0;
}
