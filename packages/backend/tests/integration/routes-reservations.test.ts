/**
 * Route Reservation HTTP Route Integration Tests
 *
 * Named routes-reservations.test.ts so it does not collide with the
 * existing routes.test.ts (general REST route coverage). Mirrors
 * edges.test.ts's conventions: Fastify inject, a real mutable in-memory
 * repository (not a fixed canned response), and a started LayoutService
 * since granting/cancelling/resuming routes needs the running track graph
 * and reservation lifecycle, not just a stub.
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
import {
  BlockRecord,
  ILayoutRepository,
  LocoRecord,
  PointRecord,
} from '../../src/ports/ILayoutRepository';
import { BlockEdge, RouteHoldKind, RouteReservation, RouteStatus } from '../../src/domain/types';
import { authenticateAsAdmin, authenticateAsOperator, makeTestAuthService, TEST_AUTH_CONFIG } from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const LAYOUT_ID = 'layout-1';

const BLOCKS: BlockRecord[] = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
];
const POINTS: PointRecord[] = [];
const LOCOS: LocoRecord[] = [
  { id: 'loco-1', layoutId: LAYOUT_ID, name: 'Loco 3', address: 3, type: 'diesel', maxSpeed: 126, brakingFactor: 0.5 },
];
const EDGE: BlockEdge = {
  id: 'e1',
  layoutId: LAYOUT_ID,
  fromBlockId: 'b1',
  fromEnd: 'east',
  toBlockId: 'b2',
  toEnd: 'west',
  pointConditions: [],
  lengthMm: null,
};

/** A minimal but real mutable in-memory ILayoutRepository, reservations-focused (mirrors edges.test.ts's edges-focused fake). */
function makeRepo(): ILayoutRepository {
  const reservations = new Map<
    string,
    { row: Omit<RouteReservation, 'holds'>; holds: Map<string, RouteReservation['holds'][number]> }
  >();

  function toReservation(id: string): RouteReservation {
    const entry = reservations.get(id)!;
    return { ...entry.row, holds: [...entry.holds.values()] };
  }

  return {
    listLayouts: vi.fn().mockResolvedValue([]),
    getLayout: vi.fn().mockResolvedValue(null),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn().mockImplementation(async (layoutId: string) => LOCOS.filter((l) => l.layoutId === layoutId)),
    getLoco: vi.fn().mockResolvedValue(null),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),

    listBlocks: vi.fn().mockImplementation(async (layoutId: string) => BLOCKS.filter((b) => b.layoutId === layoutId)),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),

    listPoints: vi.fn().mockImplementation(async (layoutId: string) => POINTS.filter((p) => p.layoutId === layoutId)),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),

    listSensors: vi.fn().mockResolvedValue([]),
    createSensor: vi.fn(),
    updateSensor: vi.fn(),
    deleteSensor: vi.fn(),

    listGridTiles: vi.fn().mockResolvedValue([]),
    upsertGridTile: vi.fn(),
    deleteTile: vi.fn(),
    clearGrid: vi.fn(),

    listBlockEdges: vi.fn().mockImplementation(async (layoutId: string) => (layoutId === LAYOUT_ID ? [EDGE] : [])),
    getBlockEdge: vi.fn().mockImplementation(async (id: string) => (id === EDGE.id ? EDGE : null)),
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),

    listReservations: vi.fn().mockImplementation(async (layoutId: string, statuses?: RouteStatus[]) =>
      [...reservations.keys()]
        .map(toReservation)
        .filter((r) => r.layoutId === layoutId && (!statuses || statuses.includes(r.status))),
    ),
    getReservation: vi.fn().mockImplementation(async (id: string) => (reservations.has(id) ? toReservation(id) : null)),
    createReservation: vi
      .fn()
      .mockImplementation(async (data: Omit<RouteReservation, 'createdAt' | 'updatedAt'>) => {
        const now = new Date();
        reservations.set(data.id, {
          row: {
            id: data.id,
            layoutId: data.layoutId,
            locoAddress: data.locoAddress,
            authority: data.authority,
            status: data.status,
            path: data.path,
            confirmedIndex: data.confirmedIndex,
            reason: data.reason,
            createdAt: now,
            updatedAt: now,
          },
          holds: new Map(data.holds.map((h) => [`${h.kind}:${h.targetId}`, { ...h }])),
        });
        return toReservation(data.id);
      }),
    updateReservation: vi
      .fn()
      .mockImplementation(
        async (id: string, data: { status?: RouteStatus; confirmedIndex?: number; reason?: string | null }) => {
          const entry = reservations.get(id);
          if (!entry) throw new Error(`Route reservation ${id} not found after update`);
          entry.row = { ...entry.row, ...data, updatedAt: new Date() };
          return toReservation(id);
        },
      ),
    markHoldsReleased: vi
      .fn()
      .mockImplementation(async (routeId: string, holds: Array<{ kind: RouteHoldKind; targetId: string }>) => {
        const entry = reservations.get(routeId);
        if (!entry) return;
        for (const h of holds) {
          const key = `${h.kind}:${h.targetId}`;
          const existing = entry.holds.get(key);
          if (existing) entry.holds.set(key, { ...existing, released: true });
        }
      }),
  };
}

async function buildTestServer(repo: ILayoutRepository, options: { skipLogin?: boolean } = {}) {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager(LAYOUT_ID);
  // #54: a real NameBookCache (not INERT_NAME_BOOK), so this suite proves
  // the whole naming chain end to end — the 422 body from a route rejection
  // is the exact case #54 was raised from.
  const nameBook = new NameBookCache(repo, LAYOUT_ID);
  const reservations = new ReservationService(repo, state, silentLogger, nameBook);
  const service = new LayoutService(dcc, mqtt, repo, state, reservations, silentLogger, undefined, nameBook);
  const topologyService = new TopologyService(
    repo,
    () => service.reloadTopology(),
    silentLogger,
    reservations,
    nameBook,
  );
  await service.start(LAYOUT_ID);
  const authService = await makeTestAuthService();
  const app = await buildServer(service, repo, 'silent', topologyService, authService, TEST_AUTH_CONFIG, nameBook);
  if (!options.skipLogin) {
    await authenticateAsAdmin(app);
  }
  return { app, service, state, mqtt };
}

describe('Route reservation routes', () => {
  let repo: ILayoutRepository;
  let app: Awaited<ReturnType<typeof buildTestServer>>['app'];
  let service: Awaited<ReturnType<typeof buildTestServer>>['service'];
  let state: LayoutStateManager;
  let mqtt: Awaited<ReturnType<typeof buildTestServer>>['mqtt'];

  beforeEach(async () => {
    repo = makeRepo();
    ({ app, service, state, mqtt } = await buildTestServer(repo));
    // The grant precondition (D13): the start block must read occupied by
    // the requesting loco.
    state.updateBlockOccupancy('b1', 'occupied', 3);
    state.updateBlockOccupancy('b2', 'clear');
  });

  it('GET /api/layouts/:layoutId/routes returns an empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/routes` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('POST with a valid request returns 201 and the reservation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1'] },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ layoutId: LAYOUT_ID, locoAddress: 3, authority: 'manual', status: 'active' });
  });

  it('POST with an unknown key returns 400 (.strict())', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1'], sneaky: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST rejects with 422 and carries EVERY rejection when the loco is unknown and the path is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 999, authority: 'manual', startBlockId: 'b1', edgeIds: [] },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    const kinds = body.rejections.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain('empty-path');
    expect(kinds).toContain('unknown-loco');
  });

  it('POST while the system is safe-stop returns 422 with system-not-online', async () => {
    state.enterSafeStop('test-induced safe-stop');
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1'] },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.rejections).toContainEqual({ kind: 'system-not-online', status: 'safe-stop' });
  });

  it('DELETE cancels a granted route and returns 204', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1'] },
    });
    const created = JSON.parse(createRes.body);

    const res = await app.inject({ method: 'DELETE', url: `/api/layouts/${LAYOUT_ID}/routes/${created.id}` });
    expect(res.statusCode).toBe(204);

    const listRes = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/routes` });
    const routes = JSON.parse(listRes.body);
    expect(routes.find((r: { id: string }) => r.id === created.id).status).toBe('cancelled');
  });

  it('DELETE of an unknown route returns 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/layouts/${LAYOUT_ID}/routes/does-not-exist` });
    expect(res.statusCode).toBe(404);
  });

  it('POST .../resume on a route that is not suspended (still active) returns 409', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1'] },
    });
    const created = JSON.parse(createRes.body);

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes/${created.id}/resume`,
    });
    expect(res.statusCode).toBe(409);
  });

  it('POST .../resume refused with 409 when a remaining block reads unknown after a real Safe-Stop suspension', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1'] },
    });
    const created = JSON.parse(createRes.body);

    // A real Safe-Stop trigger (MQTT drop) — this is what actually suspends
    // the route (D8), locks retained. handleMqttConnectionChange fires
    // evaluateAndApplySafeStop as fire-and-forget, so flush a microtask.
    mqtt.disconnect();
    await new Promise((r) => setImmediate(r));
    expect(service.getSystemStatus().status).toBe('safe-stop');

    // The remaining block's occupancy lapses to unknown while suspended.
    state.updateBlockOccupancy('b2', 'unknown');

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes/${created.id}/resume`,
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/unknown/i);
  });

  it('POST .../resume on an unknown route returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes/does-not-exist/resume`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('an operator (not just admin) may grant and cancel a route — routes are not role-gated beyond authentication', async () => {
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1'] },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── Pathfinding (#4) ──────────────────────────────────────────────────────

  it('POST with a destinationBlockId returns 201 and a searched path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', destinationBlockId: 'b2' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.path.map((s: { blockId: string }) => s.blockId)).toEqual(['b1', 'b2']);
  });

  it('POST with neither edgeIds nor destinationBlockId returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST with BOTH edgeIds and destinationBlockId returns 400 rather than silently favouring one', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: {
        locoAddress: 3,
        authority: 'manual',
        startBlockId: 'b1',
        edgeIds: ['e1'],
        destinationBlockId: 'b2',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST with startExitEnd alongside edgeIds returns 400 — it applies only to a searched path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: {
        locoAddress: 3,
        authority: 'manual',
        startBlockId: 'b1',
        edgeIds: ['e1'],
        startExitEnd: 'east',
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST to an unreachable destination returns 422 with a no-path rejection', async () => {
    // b2 is occupied by something else, so there is no clear road to it.
    state.updateBlockOccupancy('b2', 'occupied');
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', destinationBlockId: 'b2' },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.rejections).toContainEqual(
      expect.objectContaining({ kind: 'no-path', destinationBlockId: 'b2' }),
    );
    // The human-readable summary names what is in the way — #54: rendered
    // through the live NameBookCache this suite wires up, not a raw id.
    expect(body.error).toMatch(/block "Block 2" \(b2\) is occupied/);
  });

  it('POST to a destination that is the start block returns 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', destinationBlockId: 'b1' },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).rejections).toContainEqual({
      kind: 'destination-is-start',
      blockId: 'b1',
    });
  });

  it('#54: the 422 body names the block — the exact circular-route failure the issue was raised from', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', destinationBlockId: 'b1' },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('destination block "Block 1" (b1) is the start block');
  });

  // ── Route faults (#4) ─────────────────────────────────────────────────────

  it('GET /api/layouts/:layoutId/route-faults returns an empty list when nothing is faulted', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/route-faults` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ faults: [] });
  });

  it('GET .../route-faults for a layout that is not the running one returns 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/layouts/other-layout/route-faults' });
    expect(res.statusCode).toBe(404);
  });

  it('POST .../acknowledge-fault on a route with no latched fault returns 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes/no-such-route/acknowledge-fault`,
    });
    expect(res.statusCode).toBe(404);
  });

  // The acknowledge is deliberately not `requireAdmin` (it mirrors the
  // sensor-fault acknowledge — see the route's doc comment), so an operator
  // must reach the handler and get its 404, never a 403. The fault lifecycle
  // itself — latching, Safe-Stop, clearing — is covered end to end in
  // tests/scenario/pathfinding.scenario.test.ts.
  it('an operator reaches the acknowledge-fault handler rather than being refused by role', async () => {
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes/no-such-route/acknowledge-fault`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('an operator may read route-faults', async () => {
    await authenticateAsOperator(app);
    const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/route-faults` });
    expect(res.statusCode).toBe(200);
  });
});

describe('Route reservation routes — unauthenticated', () => {
  it('an unauthenticated grant is rejected with 401', async () => {
    const repo = makeRepo();
    // skipLogin: this app's inject() is never patched with a session cookie.
    const { app: unauthApp } = await buildTestServer(repo, { skipLogin: true });
    const res = await unauthApp.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/routes`,
      payload: { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1'] },
    });
    expect(res.statusCode).toBe(401);
  });
});
