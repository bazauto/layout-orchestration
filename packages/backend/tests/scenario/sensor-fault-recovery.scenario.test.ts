/**
 * Scenario: sensor-fault recovery (see docs/sensor-fault-recovery.md, D1-D8).
 *
 * Covers the acceptance set #34 requires, plus the A6 regression guard for
 * A4 (the reservation engine is driven by DERIVED occupancy, not a raw
 * sensor reading — see docs/route-locking.md D5). Uses the real
 * `ReservationService`/`LayoutService`/`TopologyService` trio via
 * `createScenarioHarness`, exercised end to end through
 * `SimulatedMqttAdapter`/`SimulatedDccAdapter` — no mocks of the services
 * under test.
 *
 * Fixture layout used throughout:
 *
 *   b1 --e1--> b2 --e2--> b3
 *
 * b1 carries BOTH a block_detection sensor (s1) and an ir_position sensor
 * (s1-ir) — the degraded-operation and progressive-release cases need both
 * on the same block.
 */

import { describe, it, expect } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { SensorFaultNotArmedError } from '../../src/services/LayoutService';

const LOCO_3 = { id: 'loco-3', layoutId: LAYOUT_ID, name: 'Loco 3', address: 3, type: 'diesel', maxSpeed: 126, brakingFactor: 0.5 };

const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
  { id: 'b3', layoutId: LAYOUT_ID, name: 'Block 3' },
];
const SENSORS = [
  { id: 's1', layoutId: LAYOUT_ID, name: 'Sensor 1 (detector)', type: 'block_detection' as const, blockId: 'b1', mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`, inService: true },
  { id: 's1-ir', layoutId: LAYOUT_ID, name: 'Sensor 1 (IR)', type: 'ir_position' as const, blockId: 'b1', mqttTopic: `layout/${LAYOUT_ID}/sensor/s1-ir/reading`, inService: true },
  { id: 's2', layoutId: LAYOUT_ID, name: 'Sensor 2', type: 'block_detection' as const, blockId: 'b2', mqttTopic: `layout/${LAYOUT_ID}/sensor/s2/reading`, inService: true },
];

/** Seeds the fixture layout (blocks/sensors/locos/edges) and starts the harness's service. b2/b3 start confirmed clear (D13). */
async function seedAndStart(h: ReturnType<typeof createScenarioHarness>) {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints([]);
  h.repo._setSensors(SENSORS);
  h.repo._setLocos([LOCO_3]);
  await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [],
    lengthMm: null,
  });
  await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b2',
    fromEnd: 'east',
    toBlockId: 'b3',
    toEnd: 'west',
    pointConditions: [],
    lengthMm: null,
  });

  await h.start();

  await h.sensorReports('s2', 'clear');
  // No sensor on b3 in this fixture — case 8 needs the final block clear
  // too (D13), so mutate it directly the same way the route-locking
  // scenario simulates a detection dropout.
  const blocks = h.service.getAllState().blocks;
  blocks.set('b3', { ...blocks.get('b3')!, occupancy: 'clear' });
}

/** Looks up the (repo-assigned) edge id connecting `from` to `to`. */
async function edgeId(h: ReturnType<typeof createScenarioHarness>, from: string, to: string): Promise<string> {
  const edges = await h.repo.listBlockEdges(LAYOUT_ID);
  const edge = edges.find((e) => e.fromBlockId === from && e.toBlockId === to);
  if (!edge) throw new Error(`no edge ${from} -> ${to}`);
  return edge.id;
}

function topicFor(sensorId: string): string {
  return `layout/${LAYOUT_ID}/sensor/${sensorId}/reading`;
}

/** Publishes a malformed (non-conforming) payload on `sensorId`'s topic and flushes microtasks. */
async function faultSensor(h: ReturnType<typeof createScenarioHarness>, sensorId: string): Promise<void> {
  h.mqtt.simulateIncoming(topicFor(sensorId), { garbage: true });
  await new Promise((r) => setImmediate(r));
}

/** Asserts that acknowledging s1's fault is refused as not-yet-armed, with the given outstanding count. */
async function expectNotArmed(h: ReturnType<typeof createScenarioHarness>, outstanding: number): Promise<void> {
  try {
    await h.service.acknowledgeSensorFault(LAYOUT_ID, 's1');
    throw new Error('expected the acknowledge to be refused');
  } catch (err) {
    expect(err).toBeInstanceOf(SensorFaultNotArmedError);
    expect((err as SensorFaultNotArmedError).outstanding).toBe(outstanding);
  }
}

describe('scenario: sensor-fault recovery', () => {
  it('1. Latched: a malformed payload enters Safe-Stop; an MQTT reconnect does not clear it; the reason still names the sensor', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    await faultSensor(h, 's1');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toMatch(/s1/);

    h.mqtt.disconnect();
    await new Promise((r) => setImmediate(r));
    await h.mqtt.connect();
    await new Promise((r) => setImmediate(r));

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toMatch(/s1/);

    await h.service.stop();
  });

  it('2. Premature recovery is refused with the correct outstanding count, and a later malformed reading resets the arming counter (D1 "consecutive")', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await faultSensor(h, 's1');

    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s1', 'occupied');
    await expectNotArmed(h, 1);
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    // A malformed payload resets the counter to 0 (DD5) — proven by needing
    // the SAME two more readings to reach the SAME "1 outstanding" state.
    await faultSensor(h, 's1');
    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s1', 'occupied');
    await expectNotArmed(h, 1);

    await h.service.stop();
  });

  it('3. A retained replay does not count toward arming (D1/D8)', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await faultSensor(h, 's1');

    await h.sensorReports('s1', 'occupied', { retained: true });
    await h.sensorReports('s1', 'occupied', { retained: true });
    await h.sensorReports('s1', 'occupied', { retained: true });

    expect(h.service.getSensorFaults()[0].consecutiveValidReadings).toBe(0);
    await expectNotArmed(h, 3);

    await h.service.stop();
  });

  it('4. Three consecutive valid non-retained readings arm the fault; acknowledge succeeds; the block reads unknown until a further reading (D6)', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await faultSensor(h, 's1');

    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s1', 'occupied');

    const result = await h.service.acknowledgeSensorFault(LAYOUT_ID, 's1');
    expect(result.cleared).toBe(true);
    expect(result.systemStatus).toBe('online');
    expect(h.service.getSystemStatus().status).toBe('online');
    // D6: the acknowledge itself supplies no reading.
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('unknown');

    await h.sensorReports('s1', 'occupied');
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');

    await h.service.stop();
  });

  it('5. Out of service clears the fault for a dead device, and a later malformed payload on the (now unsubscribed) topic does not re-trip (Q1)', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await faultSensor(h, 's1');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    await h.service.updateSensorConfig(LAYOUT_ID, 's1', { inService: false });

    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getSensorFaults()).toEqual([]);
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('unknown');

    await faultSensor(h, 's1');
    expect(h.service.getSystemStatus().status).toBe('online');

    await h.service.stop();
  });

  it('6a. Degraded operation: an IR fault leaves occupancy unaffected while the detector stays in service', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');

    await faultSensor(h, 's1-ir');

    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');
    // The fault itself still trips Safe-Stop — only occupancy is unaffected.
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    await h.service.stop();
  });

  it('6b. Degraded operation: a detector fault with the IR in service and reporting occupied still reads occupied — IR may raise (D3 clause 1)', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s1-ir', 'occupied');

    await faultSensor(h, 's1');

    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');

    await h.service.stop();
  });

  it('6c. Degraded operation: a detector fault with the IR in service and reporting clear reads unknown — IR cannot assert clear', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s1-ir', 'clear');

    await faultSensor(h, 's1');

    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('unknown');

    await h.service.stop();
  });

  it('7. Two faults: the Safe-Stop reason names the oldest; acknowledging it leaves the survivor latched; recovering the survivor clears Safe-Stop', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    await faultSensor(h, 's1');
    await faultSensor(h, 's2');
    expect(h.service.getSystemStatus().reason).toMatch(/s1/);

    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s1', 'occupied');
    await h.service.acknowledgeSensorFault(LAYOUT_ID, 's1');

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toMatch(/s2/);

    await h.sensorReports('s2', 'clear');
    await h.sensorReports('s2', 'clear');
    await h.sensorReports('s2', 'clear');
    await h.service.acknowledgeSensorFault(LAYOUT_ID, 's2');

    expect(h.service.getSystemStatus().status).toBe('online');

    await h.service.stop();
  });

  it("8. An IR clear does not release a route's holds under a train; the detector clearing does (regression guard for A4 — the reservation engine is driven by DERIVED occupancy, see docs/route-locking.md D5)", async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied'); // loco 3 asserted into b1

    const e1 = await edgeId(h, 'b1', 'b2');
    const e2 = await edgeId(h, 'b2', 'b3');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      edgeIds: [e1, e2],
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');
    const routeId = grant.reservation.id;

    // Progress the train into b2 — b1 stays occupied for now.
    await h.sensorReports('s2', 'occupied');
    expect(h.service.listRoutes(['active']).find((r) => r.id === routeId)?.confirmedIndex).toBe(1);

    // The IR sensor on b1 reports clear. D3 discards an IR 'clear' for
    // occupancy purposes — the detector's 'occupied' reading still governs
    // b1 — so derived occupancy does not change and recomputeBlock never
    // even calls into ReservationService.onOccupancyChange. Nothing may
    // release under the train.
    await h.sensorReports('s1-ir', 'clear');

    const afterIrClear = h.service.listRoutes(['active']).find((r) => r.id === routeId)!;
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');
    expect(afterIrClear.confirmedIndex).toBe(1);
    expect(afterIrClear.holds.every((hold) => !hold.released)).toBe(true);
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBe(routeId);

    // The DETECTOR clearing is the real evidence — release proceeds exactly
    // as D5 requires.
    await h.sensorReports('s1', 'clear');

    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBeNull();
    const afterDetectorClear = h.service.listRoutes(['active']).find((r) => r.id === routeId)!;
    expect(
      afterDetectorClear.holds.find((hold) => hold.kind === 'block' && hold.targetId === 'b1')?.released,
    ).toBe(true);

    await h.service.stop();
  });
});
