/**
 * Scenario: sensor simulation (#65 — see docs/sensor-simulation.md).
 *
 * The manual loop the panel exists to exercise, driven through the REAL
 * `SensorSimulationService` → `SimulatedMqttAdapter` → `LayoutService` round
 * trip via `harness.inject` — never `simulateIncoming`, which would shortcut
 * exactly the "indistinguishable from hardware" property D1 depends on.
 *
 * Fixture layout used throughout: a single block b1 with one block_detection
 * sensor s1, plus an out-of-service sensor s2 on the same block for the D9
 * failure path.
 */

import { describe, it, expect } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { SensorOutOfServiceError } from '../../src/services/SensorSimulationService';

const BLOCKS = [{ id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' }];
const SENSORS = [
  {
    id: 's1',
    layoutId: LAYOUT_ID,
    name: 'Sensor 1',
    type: 'block_detection' as const,
    blockId: 'b1',
    mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`,
    inService: true,
  },
  {
    id: 's2',
    layoutId: LAYOUT_ID,
    name: 'Sensor 2 (dead)',
    type: 'block_detection' as const,
    blockId: 'b1',
    mqttTopic: `layout/${LAYOUT_ID}/sensor/s2/reading`,
    inService: false,
  },
];

async function seedAndStart(h: ReturnType<typeof createScenarioHarness>) {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints([]);
  h.repo._setSensors(SENSORS);
  h.repo._setLocos([]);
  await h.start();
}

describe('scenario: sensor simulation', () => {
  it('inject occupied -> the block\'s derived occupancy becomes occupied', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    await h.inject('s1', { action: 'reading', state: 'occupied', retain: true });

    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');

    await h.service.stop();
  });

  it('inject clear -> derived occupancy becomes clear', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.inject('s1', { action: 'reading', state: 'occupied', retain: true });
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');

    await h.inject('s1', { action: 'reading', state: 'clear', retain: true });

    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('clear');

    await h.service.stop();
  });

  it('inject malformed (bad-enum) -> Safe-Stop with one latched fault for that sensor', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    await h.inject('s1', { action: 'malformed', variant: 'bad-enum', retain: true });

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSensorFaults().map((f) => f.sensorId)).toEqual(['s1']);

    await h.service.stop();
  });

  it('inject malformed (missing-field) -> Safe-Stop', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    await h.inject('s1', { action: 'malformed', variant: 'missing-field', retain: true });

    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    await h.service.stop();
  });

  it('inject malformed (not-an-object) -> Safe-Stop', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    await h.inject('s1', { action: 'malformed', variant: 'not-an-object', retain: true });

    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    await h.service.stop();
  });

  it('three valid injections after a fault arm it (armed: true, consecutiveValidReadings: 3)', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.inject('s1', { action: 'malformed', variant: 'bad-enum', retain: true });

    await h.inject('s1', { action: 'reading', state: 'occupied', retain: false });
    await h.inject('s1', { action: 'reading', state: 'occupied', retain: false });
    await h.inject('s1', { action: 'reading', state: 'occupied', retain: false });

    const [fault] = h.service.getSensorFaults();
    expect(fault.consecutiveValidReadings).toBe(3);
    expect(fault.armed).toBe(true);

    await h.service.stop();
  });

  it('acknowledge after arming clears the fault and returns the system to online', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.inject('s1', { action: 'malformed', variant: 'bad-enum', retain: true });
    await h.inject('s1', { action: 'reading', state: 'occupied', retain: false });
    await h.inject('s1', { action: 'reading', state: 'occupied', retain: false });
    await h.inject('s1', { action: 'reading', state: 'occupied', retain: false });

    const result = await h.service.acknowledgeSensorFault(LAYOUT_ID, 's1');

    expect(result.cleared).toBe(true);
    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getSensorFaults()).toEqual([]);

    await h.service.stop();
  });

  // D7 regression guard — the one that would fail today (before #65 step 4).
  it('failure path: an empty payload (clear-retained) is ignored: no fault, no Safe-Stop, occupancy unchanged', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.inject('s1', { action: 'reading', state: 'occupied', retain: true });
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');

    await h.inject('s1', { action: 'clear-retained' });

    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getSensorFaults()).toEqual([]);
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');

    await h.service.stop();
  });

  it('failure path: clear-retained empties the retained map, so a fresh subscribe replays nothing', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.inject('s1', { action: 'reading', state: 'occupied', retain: true });

    await h.inject('s1', { action: 'clear-retained' });

    const handler = () => {
      throw new Error('a fresh subscribe must not replay anything after clear-retained');
    };
    await h.mqtt.subscribe(`layout/${LAYOUT_ID}/sensor/s1/reading`, handler);
    await new Promise((r) => setImmediate(r));

    await h.service.stop();
  });

  it('failure path: injecting at an out-of-service sensor throws and publishes nothing', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    await expect(
      h.sensorSimulation.inject(LAYOUT_ID, 's2', { action: 'reading', state: 'occupied', retain: true }, {
        username: 'scenario-test',
      }),
    ).rejects.toThrow(SensorOutOfServiceError);
    expect(h.mqtt.publishLog.filter((e) => e.topic === `layout/${LAYOUT_ID}/sensor/s2/reading`)).toHaveLength(0);

    await h.service.stop();
  });
});
