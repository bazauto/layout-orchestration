/**
 * `POST /api/layouts/:layoutId/sensors/:sensorId/simulate-reading`
 * integration tests (#65 R5).
 *
 * Builds the server twice — once with the service (flag on), once without
 * (flag off) — to prove the route itself doesn't exist at all when the
 * feature is disabled, matching D2's "the capability does not exist in the
 * live process" posture.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../../src/transport/http/server';
import { LayoutService } from '../../src/services/LayoutService';
import { TopologyService } from '../../src/services/TopologyService';
import { ReservationService } from '../../src/services/ReservationService';
import { SensorSimulationService } from '../../src/services/SensorSimulationService';
import { NameBookCache } from '../../src/services/nameBook';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository, SensorRecord } from '../../src/ports/ILayoutRepository';
import { authenticateAsOperator, makeTestAuthService, TEST_AUTH_CONFIG } from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const LAYOUT_ID = 'layout-1';
const SENSOR_TOPIC = `layout/${LAYOUT_ID}/sensor/s1/reading`;

const SENSOR_S1: SensorRecord = {
  id: 's1',
  layoutId: LAYOUT_ID,
  name: 'Sensor 1',
  type: 'block_detection',
  blockId: 'b1',
  mqttTopic: SENSOR_TOPIC,
  inService: true,
};

const SENSOR_OUT_OF_SERVICE: SensorRecord = {
  id: 's2',
  layoutId: LAYOUT_ID,
  name: 'Sensor 2',
  type: 'block_detection',
  blockId: 'b1',
  mqttTopic: `layout/${LAYOUT_ID}/sensor/s2/reading`,
  inService: false,
};

function makeRepo(): ILayoutRepository {
  const sensors: SensorRecord[] = [SENSOR_S1, SENSOR_OUT_OF_SERVICE];

  return {
    listLayouts: vi.fn().mockResolvedValue([
      { id: LAYOUT_ID, name: 'Westgate Hollow', description: null, createdAt: new Date() },
      { id: 'some-other-layout', name: 'Other Layout', description: null, createdAt: new Date() },
    ]),
    getLayout: vi.fn().mockResolvedValue(null),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn().mockResolvedValue([]),
    getLoco: vi.fn().mockResolvedValue(null),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([{ id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' }]),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn().mockResolvedValue([]),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn().mockImplementation(async (layoutId: string) =>
      sensors.filter((s) => s.layoutId === layoutId),
    ),
    createSensor: vi.fn(),
    updateSensor: vi.fn(),
    deleteSensor: vi.fn(),
    listGridTiles: vi.fn().mockResolvedValue([]),
    upsertGridTile: vi.fn(),
    deleteTile: vi.fn(),
    clearGrid: vi.fn(),
    listBlockEdges: vi.fn().mockResolvedValue([]),
    getBlockEdge: vi.fn().mockResolvedValue(null),
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),
    listReservations: vi.fn().mockResolvedValue([]),
    getReservation: vi.fn().mockResolvedValue(null),
    createReservation: vi.fn(),
    updateReservation: vi.fn(),
    markHoldsReleased: vi.fn(),
  };
}

async function buildTestServer(withSimulation: boolean) {
  const repo = makeRepo();
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager(LAYOUT_ID);
  const nameBook = new NameBookCache(repo, LAYOUT_ID);
  const reservations = new ReservationService(repo, state, silentLogger, nameBook);
  const service = new LayoutService(dcc, mqtt, repo, state, reservations, silentLogger, undefined, nameBook);
  await service.start(LAYOUT_ID);
  const topologyService = new TopologyService(repo, () => Promise.resolve(), silentLogger, reservations, nameBook);
  const authService = await makeTestAuthService();
  const sensorSimulation = withSimulation
    ? new SensorSimulationService(mqtt, repo, silentLogger, LAYOUT_ID, nameBook)
    : undefined;
  const app = await buildServer(
    service,
    repo,
    'silent',
    topologyService,
    authService,
    TEST_AUTH_CONFIG,
    nameBook,
    sensorSimulation,
  );
  return { app, repo, mqtt };
}

const URL_S1 = `/api/layouts/${LAYOUT_ID}/sensors/s1/simulate-reading`;

/**
 * `mqtt.publishLog` also carries whatever `LayoutService.start()` and the
 * real ingestion round trip publish (system/status, block/state broadcasts)
 * — this is the real hardware path (D1), not a mock, so a reading that lands
 * genuinely changes occupancy and broadcasts it. Every assertion below
 * therefore filters to the topic under test rather than asserting on the
 * log's raw length.
 */
function entriesFor(mqtt: SimulatedMqttAdapter, topic: string) {
  return mqtt.publishLog.filter((e) => e.topic === topic);
}

describe('POST .../simulate-reading (#65 R5)', () => {
  it('an unauthenticated request is rejected with 401', async () => {
    const { app } = await buildTestServer(true);
    const res = await app.inject({ method: 'POST', url: URL_S1, payload: { action: 'clear-retained' } });
    expect(res.statusCode).toBe(401);
  });

  it('the route is absent (404) when the server is built without the service', async () => {
    const { app } = await buildTestServer(false);
    await authenticateAsOperator(app);
    const res = await app.inject({ method: 'POST', url: URL_S1, payload: { action: 'clear-retained' } });
    expect(res.statusCode).toBe(404);
  });

  it('action: reading/occupied publishes to the sensor\'s topic with qos 1 and retain true by default', async () => {
    const { app, mqtt } = await buildTestServer(true);
    await authenticateAsOperator(app);

    const res = await app.inject({
      method: 'POST',
      url: URL_S1,
      payload: { action: 'reading', state: 'occupied' },
    });

    expect(res.statusCode).toBe(202);
    const entries = entriesFor(mqtt, SENSOR_TOPIC);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ qos: 1, retain: true });
    expect(entries[0].payload).toMatchObject({ state: 'occupied' });
  });

  it('retain: false is honoured', async () => {
    const { app, mqtt } = await buildTestServer(true);
    await authenticateAsOperator(app);

    await app.inject({
      method: 'POST',
      url: URL_S1,
      payload: { action: 'reading', state: 'clear', retain: false },
    });

    expect(entriesFor(mqtt, SENSOR_TOPIC)[0].retain).toBe(false);
  });

  it('clear-retained logs payload \'\' with retain true and empties the retained map', async () => {
    const { app, mqtt } = await buildTestServer(true);
    await authenticateAsOperator(app);
    // Seed a retained reading first, so there is something to clear. Flushed
    // before the action so its own block-state side effect can't land
    // between the two and be mistaken for the clear-retained publish itself.
    await mqtt.publish(SENSOR_TOPIC, { state: 'occupied' }, { retain: true });
    await new Promise((r) => setImmediate(r));

    const res = await app.inject({ method: 'POST', url: URL_S1, payload: { action: 'clear-retained' } });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.payload).toBeNull();
    expect(body.retain).toBe(true);
    // #65 D7: a clear-retained delivery is an empty payload, which step 2b
    // drops before it can touch occupancy — so this is the ONLY entry on
    // the sensor's topic since the seed above, no accompanying block/state
    // broadcast.
    expect(entriesFor(mqtt, SENSOR_TOPIC)).toHaveLength(2);
    expect(entriesFor(mqtt, SENSOR_TOPIC).at(-1)).toMatchObject({ payload: '', qos: 1, retain: true });

    // A fresh subscribe now replays nothing — the retained store was cleared.
    const handler = vi.fn();
    await mqtt.subscribe(SENSOR_TOPIC, handler);
    await new Promise((r) => setImmediate(r));
    expect(handler).not.toHaveBeenCalled();
  });

  it('action: malformed publishes the canned payload byte-for-byte for each variant', async () => {
    const { app, mqtt } = await buildTestServer(true);
    await authenticateAsOperator(app);

    const cases: Array<[string, unknown]> = [
      ['bad-enum', { state: 'banana' }],
      ['missing-field', {}],
      ['not-an-object', null],
    ];
    for (const [variant, expected] of cases) {
      const res = await app.inject({
        method: 'POST',
        url: URL_S1,
        payload: { action: 'malformed', variant },
      });
      expect(res.statusCode).toBe(202);
      expect(mqtt.publishLog.at(-1)?.payload).toEqual(expected);
    }
  });

  it('an operator (non-admin) may inject -> 202', async () => {
    const { app } = await buildTestServer(true);
    await authenticateAsOperator(app);
    const res = await app.inject({ method: 'POST', url: URL_S1, payload: { action: 'clear-retained' } });
    expect(res.statusCode).toBe(202);
  });

  it('the 202 body echoes the exact payload published', async () => {
    const { app } = await buildTestServer(true);
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'POST',
      url: URL_S1,
      payload: { action: 'reading', state: 'occupied', retain: true },
    });
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      sensorId: 's1',
      topic: SENSOR_TOPIC,
      action: 'reading',
      retain: true,
      payload: { state: 'occupied' },
    });
    expect(typeof body.publishedAt).toBe('string');
  });

  it('an unknown action is rejected with 400 and nothing is published', async () => {
    const { app, mqtt } = await buildTestServer(true);
    await authenticateAsOperator(app);
    const res = await app.inject({ method: 'POST', url: URL_S1, payload: { action: 'bogus' } });
    expect(res.statusCode).toBe(400);
    expect(entriesFor(mqtt, SENSOR_TOPIC)).toHaveLength(0);
  });

  it('an unknown malformed variant is rejected with 400', async () => {
    const { app } = await buildTestServer(true);
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'POST',
      url: URL_S1,
      payload: { action: 'malformed', variant: 'not-a-real-variant' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('an extra field is rejected with 400 (.strict())', async () => {
    const { app } = await buildTestServer(true);
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'POST',
      url: URL_S1,
      payload: { action: 'reading', state: 'occupied', sneaky: 'field' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('retain on clear-retained is rejected with 400', async () => {
    const { app } = await buildTestServer(true);
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'POST',
      url: URL_S1,
      payload: { action: 'clear-retained', retain: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('an unknown sensor is refused with 404', async () => {
    const { app } = await buildTestServer(true);
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/sensors/ghost/simulate-reading`,
      payload: { action: 'clear-retained' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('a foreign :layoutId is refused with 404, naming the layout', async () => {
    const { app } = await buildTestServer(true);
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/some-other-layout/sensors/s1/simulate-reading`,
      payload: { action: 'clear-retained' },
    });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Other Layout');
  });

  it('an out-of-service sensor is refused with 409 and nothing is published', async () => {
    const { app, mqtt } = await buildTestServer(true);
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/sensors/s2/simulate-reading`,
      payload: { action: 'clear-retained' },
    });
    expect(res.statusCode).toBe(409);
    expect(entriesFor(mqtt, SENSOR_OUT_OF_SERVICE.mqttTopic)).toHaveLength(0);
  });
});
