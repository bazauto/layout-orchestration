/**
 * Point Route Integration Tests — the two routes #25 (docs/point-feedback.md)
 * added: `GET .../point-faults` and `POST .../points/:id/acknowledge-fault`.
 *
 * Mirrors `sensors.test.ts` exactly: unlike `routes.test.ts`'s
 * `buildTestServer`, a fault must be trippable via `mqtt.simulateIncoming`
 * before exercising the HTTP layer, so this needs a REAL, STARTED
 * `LayoutService` rather than the un-started one `routes.test.ts` uses for
 * plain CRUD. Point CRUD itself (`POST`/`PUT`/`DELETE .../points`) is already
 * covered there; this file is scoped to the fault-recovery pair.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../../src/transport/http/server';
import { LayoutService } from '../../src/services/LayoutService';
import { TopologyService } from '../../src/services/TopologyService';
import { ReservationService } from '../../src/services/ReservationService';
import { PointConfirmationService } from '../../src/services/PointConfirmationService';
import { NameBookCache } from '../../src/services/nameBook';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ManualClock } from '../../src/adapters/clock/ManualClock';
import { ILayoutRepository, PointRecord } from '../../src/ports/ILayoutRepository';
import {
  authenticateAsAdmin,
  authenticateAsOperator,
  makeTestAuthService,
  TEST_AUTH_CONFIG,
} from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const silentTopologyLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const LAYOUT_ID = 'layout-1';
const POINT_TOPIC = `layout/${LAYOUT_ID}/point/p1/reading`;

const POINT_P1: PointRecord = {
  id: 'p1',
  layoutId: LAYOUT_ID,
  name: 'Point 1',
  dccAddress: 20,
  blockId: null,
  positionFeedback: 'required',
};

/** Threshold used throughout — deliberately 2 (not the default 1), mirroring sensors.test.ts's use of the sensor default (3) to exercise the not-yet-armed 409 path. */
const FAULT_CLEAR_AFTER_CONFIRMATIONS = 2;

function makeRepo(): ILayoutRepository {
  let points: PointRecord[] = [POINT_P1];

  return {
    // #54: includes a foreign layout too, so the "not the running layout"
    // 404 test below can assert it gets named, mirroring sensors.test.ts.
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
    listBlocks: vi.fn().mockResolvedValue([]),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn().mockImplementation(async (layoutId: string) =>
      points.filter((p) => p.layoutId === layoutId),
    ),
    createPoint: vi.fn().mockImplementation(async (data: Omit<PointRecord, 'id'>) => {
      const created: PointRecord = { id: `point-${points.length + 1}`, ...data };
      points = [...points, created];
      return created;
    }),
    updatePoint: vi
      .fn()
      .mockImplementation(async (id: string, data: Partial<Omit<PointRecord, 'id' | 'layoutId'>>) => {
        const index = points.findIndex((p) => p.id === id);
        if (index === -1) throw new Error(`Point ${id} not found after update`);
        const updated = { ...points[index], ...data };
        points = points.map((p, i) => (i === index ? updated : p));
        return updated;
      }),
    deletePoint: vi.fn().mockImplementation(async (id: string) => {
      points = points.filter((p) => p.id !== id);
    }),
    listSensors: vi.fn().mockResolvedValue([]),
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

async function buildStartedTestServer(repo: ILayoutRepository) {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager(LAYOUT_ID);
  const nameBook = new NameBookCache(repo, LAYOUT_ID);
  const reservations = new ReservationService(repo, state, silentLogger, nameBook);
  // A ManualClock — no real timer runs in this file even though no test
  // here advances it (the two routes under test don't depend on the
  // confirmation timeout; a real SystemClock would still work, but every
  // other point-feedback test in this repo injects the clock, and a Jest/
  // vitest process left holding a live setInterval past the test's own
  // `service.stop()` is exactly what CLAUDE.md's "no real timers" rule
  // guards against).
  const clock = new ManualClock(new Date('2026-01-01T00:00:00.000Z'));
  const pointConfirmations = new PointConfirmationService(state, { timeoutMs: 8000 });
  const service = new LayoutService(
    dcc,
    mqtt,
    repo,
    state,
    reservations,
    silentLogger,
    { pointFaultClearAfterConfirmations: FAULT_CLEAR_AFTER_CONFIRMATIONS },
    nameBook,
    undefined,
    clock,
    pointConfirmations,
  );
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

/** Publishes a malformed payload on p1's topic and flushes microtasks so the fault has latched. */
async function faultPoint(mqtt: SimulatedMqttAdapter): Promise<void> {
  mqtt.simulateIncoming(POINT_TOPIC, { garbage: true });
  await new Promise((r) => setImmediate(r));
}

/**
 * Publishes N valid, non-retained, sensor-sourced readings on p1's topic to
 * arm its fault (threshold is `FAULT_CLEAR_AFTER_CONFIRMATIONS`, 2 here).
 * p1 is never commanded in this file, so `confirmationArms` only requires a
 * non-'unknown' sensor-sourced reading (D4) — position is otherwise
 * arbitrary.
 */
async function armFault(mqtt: SimulatedMqttAdapter, count = FAULT_CLEAR_AFTER_CONFIRMATIONS): Promise<void> {
  for (let i = 0; i < count; i++) {
    mqtt.simulateIncoming(POINT_TOPIC, { pointId: 'p1', position: 'normal', source: 'sensor' });
    await new Promise((r) => setImmediate(r));
  }
}

describe('Point fault-recovery routes (#25)', () => {
  let repo: ReturnType<typeof makeRepo>;
  let app: Awaited<ReturnType<typeof buildStartedTestServer>>['app'];
  let mqtt: SimulatedMqttAdapter;

  beforeEach(async () => {
    repo = makeRepo();
    const built = await buildStartedTestServer(repo);
    app = built.app;
    mqtt = built.mqtt;
  });

  describe('POST /api/layouts/:layoutId/points/:id/acknowledge-fault', () => {
    it('an unauthenticated request is rejected with 401 (the global hook, not a per-route check)', async () => {
      await faultPoint(mqtt);
      await armFault(mqtt);
      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/points/p1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('an operator may acknowledge an armed fault -> 200, faults: []', async () => {
      await authenticateAsOperator(app);
      await faultPoint(mqtt);
      await armFault(mqtt);

      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/points/p1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ pointId: 'p1', cleared: true, systemStatus: 'online' });
      expect(body.faults).toEqual([]);
    });

    it('an admin may also acknowledge an armed fault -> 200', async () => {
      await authenticateAsAdmin(app);
      await faultPoint(mqtt);
      await armFault(mqtt);

      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/points/p1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(200);
    });

    it('acknowledging before arming is refused with 409, naming the outstanding count', async () => {
      await authenticateAsOperator(app);
      await faultPoint(mqtt);
      await armFault(mqtt, 1); // one of two required

      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/points/p1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.outstanding).toBe(1);
      expect(body.consecutiveConfirmations).toBe(1);
      expect(body.requiredConfirmations).toBe(2);
      expect(body.error).toMatch(/1/);
    });

    it('acknowledging a point with no fault latched is refused with 409', async () => {
      await authenticateAsOperator(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/points/p1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.pointId).toBe('p1');
    });

    it('acknowledging an unknown point is refused with 404', async () => {
      await authenticateAsOperator(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/${LAYOUT_ID}/points/ghost/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('acknowledging with a foreign :layoutId is refused with 404', async () => {
      await authenticateAsOperator(app);
      await faultPoint(mqtt);
      await armFault(mqtt);
      const res = await app.inject({
        method: 'POST',
        url: `/api/layouts/some-other-layout/points/p1/acknowledge-fault`,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/layouts/:layoutId/point-faults', () => {
    it('an unauthenticated request is rejected with 401', async () => {
      const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/point-faults` });
      expect(res.statusCode).toBe(401);
    });

    it('authenticated with one fault returns the exact PointFaultView shape', async () => {
      await authenticateAsOperator(app);
      await faultPoint(mqtt);
      await armFault(mqtt, 1);

      const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/point-faults` });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.faults).toHaveLength(1);
      expect(body.faults[0]).toMatchObject({
        pointId: 'p1',
        kind: 'malformed-payload',
        consecutiveConfirmations: 1,
        requiredConfirmations: 2,
        armed: false,
      });
      expect(typeof body.faults[0].reason).toBe('string');
      expect(typeof body.faults[0].faultedAt).toBe('string');
    });

    it('an empty layout (no fault latched) returns faults: []', async () => {
      await authenticateAsOperator(app);
      const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/point-faults` });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).faults).toEqual([]);
    });

    it('a foreign :layoutId is refused with 404, naming the layout (#54)', async () => {
      await authenticateAsOperator(app);
      const res = await app.inject({
        method: 'GET',
        url: `/api/layouts/some-other-layout/point-faults`,
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Layout "Other Layout" (some-oth) is not the running layout');
    });
  });
});
