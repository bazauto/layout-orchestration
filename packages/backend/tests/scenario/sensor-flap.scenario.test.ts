/**
 * Scenario: an oscillating IR beam (#76).
 *
 * The prompting case for #76's comment: a flapping IR beam on the live layout
 * could not be observed from the UI at all, because per-sensor observations
 * never reached the WebSocket (DD10, superseded — `docs/sensor-fault-recovery.md`
 * D10). This scenario pins the fix at the service level — `SENSOR_STATE`
 * fires on every transition of a beam that will not settle, while derived
 * block occupancy does its own, DIFFERENT thing: `deriveBlockOccupancy`
 * clause 3 makes an IR `clear` a no-op (only a `block_detection` sensor may
 * assert `clear`), so the block moves `occupied` / `unknown`, never `clear` —
 * exactly the "beam is subordinate to derived occupancy" property #76's
 * comment calls the real hazard.
 *
 * CLAUDE.md requires scenario coverage for anything touching occupancy
 * logic; this is observation OF occupancy, not a change to it, so the
 * coverage is of the flap being visible, not of `deriveBlockOccupancy`
 * changing.
 */

import { describe, it, expect } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { LayoutEvent } from '../../src/domain/types';

const BLOCKS = [{ id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' }];

// IR-only — deliberately no block_detection sensor on this block, so its
// `clear` can never govern (clause 2 of `deriveBlockOccupancy`) and the
// no-op is the case under test.
const SENSORS = [
  {
    id: 's1',
    layoutId: LAYOUT_ID,
    name: 'Beam 1',
    type: 'ir_position' as const,
    blockId: 'b1',
    mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`,
    inService: true,
  },
];

function sensorStateEvents(events: LayoutEvent[]) {
  return events.filter(
    (e): e is Extract<LayoutEvent, { type: 'SENSOR_STATE' }> => e.type === 'SENSOR_STATE',
  );
}

function blockStateEvents(events: LayoutEvent[]) {
  return events.filter(
    (e): e is Extract<LayoutEvent, { type: 'BLOCK_STATE' }> => e.type === 'BLOCK_STATE',
  );
}

describe('scenario: a flapping IR beam (#76)', () => {
  it('SENSOR_STATE fires on every transition while block occupancy moves occupied/unknown, never clear', async () => {
    const h = createScenarioHarness();
    h.repo._setBlocks(BLOCKS);
    h.repo._setPoints([]);
    h.repo._setSensors(SENSORS);
    h.repo._setLocos([]);
    await h.start();

    const occupancyOf = () => h.service.getAllState().blocks.get('b1')?.occupancy;

    // Beam breaks — first live reading. Occupied wins clause 1 outright.
    await h.sensorReports('s1', 'occupied');
    expect(occupancyOf()).toBe('occupied');
    expect(sensorStateEvents(h.events)).toHaveLength(1);
    expect(sensorStateEvents(h.events)[0].payload).toMatchObject({
      sensorId: 's1',
      lastReading: 'occupied',
    });

    // Beam clears. An IR clear is a no-op (clause 3), so the block falls to
    // `unknown` — NOT `clear`. The beam is subordinate to derived occupancy,
    // visibly: SENSOR_STATE says the beam itself reads clear even while
    // BLOCK_STATE disagrees about the block.
    await h.sensorReports('s1', 'clear');
    expect(occupancyOf()).toBe('unknown');
    expect(sensorStateEvents(h.events)).toHaveLength(2);
    expect(sensorStateEvents(h.events)[1].payload).toMatchObject({
      sensorId: 's1',
      lastReading: 'clear',
    });

    // It keeps flapping. Every transition emits SENSOR_STATE — this is the
    // signal an operator diagnosing a bad connection needs to see, and D-b's
    // whole point is that it is not swallowed as noise.
    for (let i = 0; i < 4; i += 1) {
      await h.sensorReports('s1', 'occupied');
      await h.sensorReports('s1', 'clear');
    }
    // 2 initial + 4 * 2 further transitions.
    expect(sensorStateEvents(h.events)).toHaveLength(10);

    // Occupancy itself only ever alternates occupied/unknown — clear never
    // appears, because no block_detection sensor exists to assert it. The
    // failure #76 exists to prevent is an operator reading the beam's own
    // SENSOR_STATE as if it were the block's occupancy; the two data series
    // pin that they are allowed to disagree.
    const occupancies = blockStateEvents(h.events).map((e) => e.payload.occupancy);
    expect(occupancies.every((o) => o === 'occupied' || o === 'unknown')).toBe(true);
    expect(occupancies).not.toContain('clear');

    await h.service.stop();
  });

  it('a re-assert at the same value pushes SENSOR_STATE once, not on every publish — the flap is chased, not the reassert', async () => {
    const h = createScenarioHarness();
    h.repo._setBlocks(BLOCKS);
    h.repo._setPoints([]);
    h.repo._setSensors(SENSORS);
    h.repo._setLocos([]);
    await h.start();

    await h.sensorReports('s1', 'occupied');
    expect(sensorStateEvents(h.events)).toHaveLength(1);

    // A healthy, non-flapping beam re-asserting the SAME reading, exactly as
    // #28 obliges hardware to do every 30s inside the freshness window.
    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s1', 'occupied');

    expect(sensorStateEvents(h.events)).toHaveLength(1);

    await h.service.stop();
  });
});
