/**
 * Sensor Route Integration Tests (see docs/sensor-fault-recovery.md)
 *
 * Unlike `routes.test.ts`'s `buildTestServer`, these tests need a REAL,
 * STARTED `LayoutService` — a fault must be trippable via
 * `mqtt.simulateIncoming` before exercising the HTTP layer, and
 * `layoutService.test.ts` already proves `start()` works against a mock
 * repo, so this copies that pattern rather than reusing the un-started one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../../src/transport/http/server';
import { LayoutService } from '../../src/services/LayoutService';
import { TopologyService } from '../../src/services/TopologyService';
import { ReservationService } from '../../src/services/ReservationService';
import { NameBookCache } from '../../src/services/nameBook';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository, SensorRecord } from '../../src/ports/ILayoutRepository';
import {
  authenticateAsAdmin,
  authenticateAsOperator,
  makeTestAuthService,
  TEST_AUTH_CONFIG,
} from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const silentTopologyLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

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
  positionTowardBlockId: null,
  positionOffsetMm: null,
};

function makeRepo(): ILayoutRepository {
  let sensors: SensorRecord[] = [SENSOR_S1];

  return {
    // #54: includes a foreign layout too, so the "not the running layout"
    // 404 test below can assert it gets named — buildNameBook's `layouts`
    // map is global (listLayouts takes no layoutId), not scoped to the
    // running layout, which is what closes that inventory gap (Q2).
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
    listBlocks: vi.fn().mockResolvedValue([
      { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1', lengthMm: 1200 },
      { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2', lengthMm: null },
    ]),
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
    createSensor: vi.fn().mockImplementation(async (data: Omit<SensorRecord, 'id'>) => {
      const created: SensorRecord = { id: `sensor-${sensors.length + 1}`, ...data };
      sensors = [...sensors, created];
      return created;
    }),
    updateSensor: vi
      .fn()
      .mockImplementation(async (id: string, data: Partial<Omit<SensorRecord, 'id' | 'layoutId'>>) => {
        const index = sensors.findIndex((s) => s.id === id);
        if (index === -1) throw new Error(`Sensor ${id} not found after update`);
        const updated = { ...sensors[index], ...data };
        sensors = sensors.map((s, i) => (i === index ? updated : s));
        return updated;
      }),
    deleteSensor: vi.fn().mockImplementation(async (id: string) => {
      sensors = sensors.filter((s) => s.id !== id);
    }),
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

async function buildStartedTestServer(repo: ILayoutRepository) {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager(LAYOUT_ID);
  const nameBook = new NameBookCache(repo, LAYOUT_ID);
  const reservations = new ReservationService(repo, state, silentLogger, nameBook);
  const service = new LayoutService(dcc, mqtt, repo, state, reservations, silentLogger, undefined, nameBook);
  await service.start(LAYOUT_ID);
  const topologyService = new TopologyService(
    repo,
    () => Promise.resolve(),
    silentTopologyLogger,
    reservations,
    nameBook,
  );
  const authService = await makeTestAuthService();
  const app = await buildServer(service, repo, 'silent', topologyService, authService, TEST_AUTH_CONFIG, nameBook);
  return { app, service, mqtt, dcc, repo };
}

/** Publishes a malformed payload on s1's topic and flushes microtasks so the fault has latched. */
async function faultSensor(mqtt: SimulatedMqttAdapter): Promise<void> {
  mqtt.simulateIncoming(SENSOR_TOPIC, { garbage: true });
  await new Promise((r) => setImmediate(r));
}

/** Publishes N valid, non-retained readings on s1's topic to arm its fault (default threshold is 3). */
async function armFault(mqtt: SimulatedMqttAdapter, count = 3): Promise<void> {
  for (let i = 0; i < count; i++) {
    mqtt.simulateIncoming(SENSOR_TOPIC, { state: 'occupied', updatedAt: new Date().toISOString() });
    await new Promise((r) => setImmediate(r));
  }
}

describe('Sensor fault-recovery routes', () => {
  let repo: ReturnType<typeof makeRepo>;
  let app: Awaited<ReturnType<typeof buildStartedTestServer>>['app'];
  let mqtt: SimulatedMqttAdapter;

  beforeEach(async () => {
    repo = makeRepo();
    const built = await buildStartedTestServer(repo);
    app = built.app;
    mqtt = built.mqtt;
  });

  describe('POST /api/layouts/:layoutId/sensors/:id/acknowledge-fault', () => {
    it('an unauthenticated request is rejected with 401 (the global hook, not a per-route check)', async () => {
      await faultSensor(mqtt);
      await armFault(mqtt);
      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/sensors/s1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('an operator may acknowledge an armed fault -> 200, faults: []', async () => {
      await authenticateAsOperator(app);
      await faultSensor(mqtt);
      await armFault(mqtt);

      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/sensors/s1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ sensorId: 's1', cleared: true, systemStatus: 'online' });
      expect(body.faults).toEqual([]);
    });

    it('an admin may also acknowledge an armed fault -> 200', async () => {
      await authenticateAsAdmin(app);
      await faultSensor(mqtt);
      await armFault(mqtt);

      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/sensors/s1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(200);
    });

    it('acknowledging before arming is refused with 409, naming the outstanding count', async () => {
      await authenticateAsOperator(app);
      await faultSensor(mqtt);
      await armFault(mqtt, 1); // one of three required

      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/sensors/s1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.outstanding).toBe(2);
      expect(body.consecutiveValidReadings).toBe(1);
      expect(body.requiredValidReadings).toBe(3);
      expect(body.error).toMatch(/2/);
    });

    it('acknowledging a sensor with no fault latched is refused with 409', async () => {
      await authenticateAsOperator(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/sensors/s1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.sensorId).toBe('s1');
    });

    it('acknowledging an unknown sensor is refused with 404', async () => {
      await authenticateAsOperator(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/sensors/ghost/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('acknowledging with a foreign :layoutId is refused with 404', async () => {
      await authenticateAsOperator(app);
      await faultSensor(mqtt);
      await armFault(mqtt);
      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/some-other-layout/sensors/s1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /api/layouts/:layoutId/sensors/:id', () => {
    it('an operator is refused with 403', async () => {
      await authenticateAsOperator(app);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/layouts/${LAYOUT_ID}/sensors/s1`,
        payload: { inService: false },
      });
      expect(res.statusCode).toBe(403);
      expect(repo.updateSensor).not.toHaveBeenCalled();
    });

    it('an admin may set inService: false -> 200, repo.updateSensor called with { inService: false }', async () => {
      await authenticateAsAdmin(app);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/layouts/${LAYOUT_ID}/sensors/s1`,
        payload: { inService: false },
      });
      expect(res.statusCode).toBe(200);
      expect(repo.updateSensor).toHaveBeenCalledWith('s1', { inService: false });
    });

    it('an unknown field is rejected with 400 (.strict())', async () => {
      await authenticateAsAdmin(app);
      const res = await app.inject({
        method: 'PUT',
        url: `/api/layouts/${LAYOUT_ID}/sensors/s1`,
        payload: { inService: false, sneaky: 'field' },
      });
      expect(res.statusCode).toBe(400);
      expect(repo.updateSensor).not.toHaveBeenCalled();
    });
  });

  // ── #77 sub-block position on the config write path (docs/sensor-position.md) ──

  describe('sub-block position (#77)', () => {
    /** A `PUT` carrying just a position, on the shared `s1` fixture. */
    const put = (app: Awaited<ReturnType<typeof buildStartedTestServer>>['app'], payload: unknown) =>
      app.inject({ method: 'PUT', url: `/api/layouts/${LAYOUT_ID}/sensors/s1`, payload });

    it('a measured ir_position sensor stores BOTH columns from one object', async () => {
      await authenticateAsAdmin(app);
      const res = await put(app, { type: 'ir_position', position: { towardBlockId: 'b2', offsetMm: 400 } });
      expect(res.statusCode).toBe(200);
      expect(repo.updateSensor).toHaveBeenCalledWith('s1', {
        type: 'ir_position',
        positionTowardBlockId: 'b2',
        positionOffsetMm: 400,
      });
    });

    it('an omitted position leaves both columns alone; an explicit null clears both together', async () => {
      await authenticateAsAdmin(app);
      await put(app, { type: 'ir_position', position: { towardBlockId: 'b2', offsetMm: 400 } });

      await put(app, { name: 'Renamed' });
      expect(repo.updateSensor).toHaveBeenLastCalledWith('s1', { name: 'Renamed' });

      const cleared = await put(app, { position: null });
      expect(cleared.statusCode).toBe(200);
      expect(repo.updateSensor).toHaveBeenLastCalledWith('s1', {
        positionTowardBlockId: null,
        positionOffsetMm: null,
      });
    });

    it('D4 — a block_detection sensor may not carry a position, and the check sees the MERGED row', async () => {
      await authenticateAsAdmin(app);
      // s1 is `block_detection`; the patch says nothing about type, so nothing
      // in the body alone reveals the problem.
      const res = await put(app, { position: { towardBlockId: 'b2', offsetMm: 400 } });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/only an ir_position sensor/);
      expect(repo.updateSensor).not.toHaveBeenCalled();
    });

    it('D4 — flipping an already-positioned sensor back to block_detection is refused for the same reason', async () => {
      await authenticateAsAdmin(app);
      await put(app, { type: 'ir_position', position: { towardBlockId: 'b2', offsetMm: 400 } });

      const res = await put(app, { type: 'block_detection' });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/only an ir_position sensor/);
    });

    it('D5 — a self-anchored position is refused: a block shares no boundary with itself', async () => {
      await authenticateAsAdmin(app);
      const res = await put(app, { type: 'ir_position', position: { towardBlockId: 'b1', offsetMm: 400 } });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/does not share a boundary with itself/);
    });

    it('D5 — an anchor block that does not exist in this layout is refused', async () => {
      await authenticateAsAdmin(app);
      const res = await put(app, { type: 'ir_position', position: { towardBlockId: 'ghost', offsetMm: 400 } });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/does not exist in layout/);
    });

    it('an offset longer than the block itself is refused; an unmeasured block has nothing to check against', async () => {
      await authenticateAsAdmin(app);
      // b1 is 1200mm.
      const tooLong = await put(app, { type: 'ir_position', position: { towardBlockId: 'b2', offsetMm: 1201 } });
      expect(tooLong.statusCode).toBe(400);
      expect(JSON.parse(tooLong.body).error).toMatch(/longer than block/);

      const exact = await put(app, { type: 'ir_position', position: { towardBlockId: 'b2', offsetMm: 1200 } });
      expect(exact.statusCode).toBe(200);
    });

    it('a zero or negative offset is a Zod 400 — a distance of nothing is not a measurement', async () => {
      await authenticateAsAdmin(app);
      for (const offsetMm of [0, -1, 12.5]) {
        const res = await put(app, { type: 'ir_position', position: { towardBlockId: 'b2', offsetMm } });
        expect(res.statusCode, `offsetMm ${offsetMm}`).toBe(400);
      }
      expect(repo.updateSensor).not.toHaveBeenCalled();
    });

    it('a position anchored to a block the drawing does not connect is ACCEPTED — authoring order is the operator’s business (D5)', async () => {
      await authenticateAsAdmin(app);
      // This repo has no edges at all, so nothing joins b1 to b2. The write
      // stands; the anchor is re-resolved against the live graph where it is
      // consumed, and reads as unmeasured there rather than as a guess.
      const res = await put(app, { type: 'ir_position', position: { towardBlockId: 'b2', offsetMm: 400 } });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/layouts/:layoutId/sensor-faults', () => {
    it('an unauthenticated request is rejected with 401', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/sensor-faults` });
      expect(res.statusCode).toBe(401);
    });

    it('authenticated with one fault returns the exact SensorFaultView shape', async () => {
      await authenticateAsOperator(app);
      await faultSensor(mqtt);
      await armFault(mqtt, 1);

      const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/sensor-faults` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.faults).toHaveLength(1);
      expect(body.faults[0]).toMatchObject({
        sensorId: 's1',
        topic: SENSOR_TOPIC,
        consecutiveValidReadings: 1,
        requiredValidReadings: 3,
        armed: false,
      });
      expect(typeof body.faults[0].reason).toBe('string');
      expect(typeof body.faults[0].faultedAt).toBe('string');
    });

    it('a foreign :layoutId is refused with 404, naming the layout (#54)', async () => {
      await authenticateAsOperator(app);
      const res = await app.inject({
        method: 'GET',
        url: `/api/layouts/some-other-layout/sensor-faults`,
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Layout "Other Layout" (some-oth) is not the running layout');
    });
  });
});
