/**
 * HTTP Route Integration Tests
 *
 * Uses Fastify's `inject()` to exercise every REST endpoint without a real
 * database or network.  A minimal in-memory repo stub is wired into
 * `buildServer` so each test verifies the full request→route→repo pipeline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../../src/transport/http/server';
import { LayoutService } from '../../src/services/LayoutService';
import { TopologyService } from '../../src/services/TopologyService';
import { ReservationService } from '../../src/services/ReservationService';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository } from '../../src/ports/ILayoutRepository';
import {
  authenticateAsAdmin,
  authenticateAsOperator,
  makeTestAuthService,
  TEST_AUTH_CONFIG,
} from './testAuthHelpers';

const silentTopologyLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const LAYOUT = {
  id: 'layout-1',
  name: 'Test Layout',
  description: null,
  createdAt: new Date('2026-01-01'),
};

const BLOCK  = { id: 'b1', layoutId: 'layout-1', name: 'Platform 1' };
const POINT  = { id: 'pt1', layoutId: 'layout-1', name: 'Point 1', dccAddress: 10, blockId: 'b1' };
const SENSOR = { id: 's1', layoutId: 'layout-1', name: 'Sensor 1', type: 'block_detection' as const, blockId: 'b1', mqttTopic: 'sensor/s1', inService: true };
const TILE   = { id: 't1', layoutId: 'layout-1', x: 2, y: 3, tileType: 'straight-h', metadata: '{}' };

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeRepo(): ILayoutRepository {
  return {
    listLayouts:   vi.fn().mockResolvedValue([LAYOUT]),
    getLayout:     vi.fn().mockResolvedValue(LAYOUT),
    createLayout:  vi.fn().mockResolvedValue({ ...LAYOUT, id: 'new-layout' }),
    deleteLayout:  vi.fn().mockResolvedValue(undefined),

    listLocos:     vi.fn().mockResolvedValue([]),
    getLoco:       vi.fn().mockResolvedValue(null),
    createLoco:    vi.fn().mockResolvedValue({ id: 'loco-1', layoutId: 'layout-1', name: 'Loco 1', address: 3, type: 'steam', maxSpeed: 126, brakingFactor: 0.5 }),
    updateLoco:    vi.fn().mockResolvedValue({ id: 'loco-1', layoutId: 'layout-1', name: 'Loco 1', address: 3, type: 'steam', maxSpeed: 126, brakingFactor: 0.5 }),
    deleteLoco:    vi.fn().mockResolvedValue(undefined),

    listBlocks:    vi.fn().mockResolvedValue([BLOCK]),
    createBlock:   vi.fn().mockResolvedValue(BLOCK),
    updateBlock:   vi.fn().mockResolvedValue(BLOCK),
    deleteBlock:   vi.fn().mockResolvedValue(undefined),

    listPoints:    vi.fn().mockResolvedValue([POINT]),
    createPoint:   vi.fn().mockResolvedValue(POINT),
    updatePoint:   vi.fn().mockResolvedValue(POINT),
    deletePoint:   vi.fn().mockResolvedValue(undefined),

    listSensors:   vi.fn().mockResolvedValue([SENSOR]),
    createSensor:  vi.fn().mockResolvedValue(SENSOR),
    updateSensor:  vi.fn().mockResolvedValue(SENSOR),
    deleteSensor:  vi.fn().mockResolvedValue(undefined),

    listGridTiles: vi.fn().mockResolvedValue([TILE]),
    upsertGridTile: vi.fn().mockResolvedValue(TILE),
    deleteTile:    vi.fn().mockResolvedValue(undefined),
    clearGrid:     vi.fn().mockResolvedValue(undefined),

    listBlockEdges: vi.fn().mockResolvedValue([]),
    getBlockEdge:   vi.fn().mockResolvedValue(null),
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn().mockResolvedValue(undefined),

    listReservations: vi.fn().mockResolvedValue([]),
    getReservation:   vi.fn().mockResolvedValue(null),
    createReservation: vi.fn(),
    updateReservation: vi.fn(),
    markHoldsReleased: vi.fn(),
  };
}

/**
 * Builds a test server and, unless `skipLogin` is set, logs it in as the
 * seeded admin account so every existing `app.inject(...)` call site below
 * — none of which were written with auth in mind — keeps working unchanged
 * (see testAuthHelpers.ts#authenticateAsAdmin). Tests that need to exercise
 * the unauthenticated or operator-role path opt out explicitly.
 */
async function buildTestServer(
  repo: ILayoutRepository,
  options: { skipLogin?: boolean } = {},
) {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager('layout-1');
  const reservations = new ReservationService(repo, state, silentLogger);
  const service = new LayoutService(dcc, mqtt, repo, state, reservations, silentLogger);
  // service.start() is never called here — these tests exercise the HTTP
  // layer only — so onTopologyChanged is a no-op rather than
  // service.reloadTopology(), which requires a started service.
  const topologyService = new TopologyService(
    repo,
    () => Promise.resolve(),
    silentTopologyLogger,
    reservations,
  );
  const authService = await makeTestAuthService();
  const app = await buildServer(
    service,
    repo,
    'silent',
    topologyService,
    authService,
    TEST_AUTH_CONFIG,
  );
  if (!options.skipLogin) {
    await authenticateAsAdmin(app);
  }
  return app;
}

// ─── /health ─────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns 200 with ok:true', async () => {
    const repo = makeRepo();
    const app = await buildTestServer(repo);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true });
  });
});

// ─── Layouts ─────────────────────────────────────────────────────────────────

describe('Layout routes', () => {
  let repo: ReturnType<typeof makeRepo>;
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    repo = makeRepo();
    app = await buildTestServer(repo);
  });

  it('GET /api/layouts returns list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/layouts' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
    expect(repo.listLayouts).toHaveBeenCalledOnce();
  });

  it('GET /api/layouts/:id returns single layout', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/layouts/layout-1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('layout-1');
  });

  it('GET /api/layouts/:id returns 404 when not found', async () => {
    vi.mocked(repo.getLayout).mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/api/layouts/missing' });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/layouts creates and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      payload: { name: 'New Layout' },
    });
    expect(res.statusCode).toBe(201);
    expect(repo.createLayout).toHaveBeenCalledWith({ name: 'New Layout', description: null });
  });

  it('DELETE /api/layouts/:id returns 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/layouts/layout-1' });
    expect(res.statusCode).toBe(204);
    expect(repo.deleteLayout).toHaveBeenCalledWith('layout-1');
  });
});

// ─── Blocks ──────────────────────────────────────────────────────────────────

describe('Block routes', () => {
  let repo: ReturnType<typeof makeRepo>;
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    repo = makeRepo();
    app = await buildTestServer(repo);
  });

  it('GET /api/layouts/:layoutId/blocks returns list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/layouts/layout-1/blocks' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
    expect(repo.listBlocks).toHaveBeenCalledWith('layout-1');
  });

  it('POST /api/layouts/:layoutId/blocks creates block', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts/layout-1/blocks',
      payload: { name: 'Platform 1' },
    });
    expect(res.statusCode).toBe(201);
    expect(repo.createBlock).toHaveBeenCalledWith({ layoutId: 'layout-1', name: 'Platform 1' });
  });

  it('PUT /api/layouts/:layoutId/blocks/:id updates block', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/layouts/layout-1/blocks/b1',
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(repo.updateBlock).toHaveBeenCalledWith('b1', { name: 'Renamed' });
  });

  it('DELETE /api/layouts/:layoutId/blocks/:id deletes the block and its edges, returning 200 with removedEdges', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/layouts/layout-1/blocks/b1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ removedEdges: 0 });
    expect(repo.deleteBlock).toHaveBeenCalledWith('layout-1', 'b1');
  });
});

// ─── Points ──────────────────────────────────────────────────────────────────

describe('Point routes', () => {
  let repo: ReturnType<typeof makeRepo>;
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    repo = makeRepo();
    app = await buildTestServer(repo);
  });

  it('PUT /api/layouts/:layoutId/points/:id updates a point', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/layouts/layout-1/points/pt1',
      payload: { name: 'Renamed Point' },
    });
    expect(res.statusCode).toBe(200);
    expect(repo.listPoints).toHaveBeenCalledWith('layout-1');
    expect(repo.updatePoint).toHaveBeenCalledWith('pt1', { name: 'Renamed Point' });
  });

  it('PUT /api/layouts/:layoutId/points/:id returns 404 for an unknown point id', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/layouts/layout-1/points/does-not-exist',
      payload: { name: 'Renamed Point' },
    });
    expect(res.statusCode).toBe(404);
    expect(repo.updatePoint).not.toHaveBeenCalled();
  });

  it('PUT /api/layouts/:layoutId/points/:id returns 400 for a malformed body (unknown field)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/layouts/layout-1/points/pt1',
      // .strict() — `id` is path/server-owned, never a client-supplied field.
      payload: { name: 'Renamed Point', id: 'sneaky' },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.updatePoint).not.toHaveBeenCalled();
  });

  it('PUT /api/layouts/:layoutId/points/:id returns 400 for a wrong-typed field', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/layouts/layout-1/points/pt1',
      payload: { dccAddress: 'not-a-number' },
    });
    expect(res.statusCode).toBe(400);
    expect(repo.updatePoint).not.toHaveBeenCalled();
  });
});

// ─── Sensors ─────────────────────────────────────────────────────────────────

describe('Sensor routes', () => {
  let repo: ReturnType<typeof makeRepo>;
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    repo = makeRepo();
    app = await buildTestServer(repo);
  });

  it('GET /api/layouts/:layoutId/sensors returns list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/layouts/layout-1/sensors' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
  });

  it('POST /api/layouts/:layoutId/sensors creates sensor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts/layout-1/sensors',
      payload: { name: 'S2', type: 'block_detection', mqttTopic: 'sensor/s2' },
    });
    expect(res.statusCode).toBe(201);
    expect(repo.createSensor).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'S2', mqttTopic: 'sensor/s2', blockId: null }),
    );
  });

  it('DELETE /api/layouts/:layoutId/sensors/:id returns 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/layouts/layout-1/sensors/s1' });
    expect(res.statusCode).toBe(204);
    expect(repo.deleteSensor).toHaveBeenCalledWith('s1');
  });
});

// ─── Grid ─────────────────────────────────────────────────────────────────────

describe('Grid routes', () => {
  let repo: ReturnType<typeof makeRepo>;
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    repo = makeRepo();
    app = await buildTestServer(repo);
  });

  it('GET /api/layouts/:layoutId/grid returns tile list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/layouts/layout-1/grid' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ x: 2, y: 3, tileType: 'straight-h' });
  });

  it('PUT /api/layouts/:layoutId/grid upserts tile and returns 200', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/layouts/layout-1/grid',
      payload: { x: 5, y: 5, tileType: 'straight-h', metadata: { rotation: 90 } },
    });
    expect(res.statusCode).toBe(200);
    expect(repo.upsertGridTile).toHaveBeenCalledWith(
      expect.objectContaining({ x: 5, y: 5, tileType: 'straight-h', layoutId: 'layout-1' }),
    );
  });

  it('DELETE /api/layouts/:layoutId/grid/tile erases tile at position', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/layouts/layout-1/grid/tile?x=2&y=3',
    });
    expect(res.statusCode).toBe(204);
    // listGridTiles is called to locate the tile, then deleteTile with its id
    expect(repo.listGridTiles).toHaveBeenCalledWith('layout-1');
    expect(repo.deleteTile).toHaveBeenCalledWith('t1');
  });

  it('DELETE /api/layouts/:layoutId/grid clears entire grid', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/layouts/layout-1/grid' });
    expect(res.statusCode).toBe(204);
    expect(repo.clearGrid).toHaveBeenCalledWith('layout-1');
  });
});

// ─── Authentication ─────────────────────────────────────────────────────────
//
// Logs in for real via Fastify inject() rather than any test-only bypass —
// see testAuthHelpers.ts and the "No AUTH_ENABLED flag" decision in the
// issue #20 plan.

describe('Authentication', () => {
  let repo: ReturnType<typeof makeRepo>;
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    repo = makeRepo();
    // skipLogin: these tests manage their own session state.
    app = await buildTestServer(repo, { skipLogin: true });
  });

  it('an unauthenticated GET to a config endpoint is rejected with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/layouts' });
    expect(res.statusCode).toBe(401);
  });

  it('an unauthenticated POST to a config endpoint is rejected with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts',
      payload: { name: 'New Layout' },
    });
    expect(res.statusCode).toBe(401);
    expect(repo.createLayout).not.toHaveBeenCalled();
  });

  it('GET /health requires no authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('POST /api/emergency-stop requires no authentication', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/emergency-stop' });
    expect(res.statusCode).toBe(200);
  });

  it('login with the wrong password is rejected with 401 and sets no cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test-admin', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('login with an unknown username is rejected with the same 401 as a wrong password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'anything' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('a malformed login payload is rejected with 400, not 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test-admin' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('login with the correct password sets a cookie and returns the username/role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test-admin', password: 'correct-horse-battery-staple' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ username: 'test-admin', role: 'admin' });
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    // COOKIE_SECURE is false in TEST_AUTH_CONFIG — pre-TLS, Secure would
    // make the browser silently refuse to send the cookie at all.
    expect(raw).not.toContain('Secure');
  });

  it('a session cookie from login authenticates a subsequent request', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test-admin', password: 'correct-horse-battery-staple' },
    });
    const setCookie = loginRes.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];

    const res = await app.inject({ method: 'GET', url: '/api/layouts', headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('GET /api/auth/me returns the logged-in user', async () => {
    await authenticateAsAdmin(app);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ username: 'test-admin', role: 'admin' });
  });

  it('logout clears the session — a subsequent request with the same cookie is rejected', async () => {
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test-admin', password: 'correct-horse-battery-staple' },
    });
    const setCookie = loginRes.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)!.split(';')[0];

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logoutRes.statusCode).toBe(204);

    const res = await app.inject({ method: 'GET', url: '/api/layouts', headers: { cookie } });
    expect(res.statusCode).toBe(401);
  });

  it('logout is not in the auth-hook exemption list, so an unauthenticated call is rejected with 401 like any other route', async () => {
    // Only /health, POST /api/auth/login, and POST /api/emergency-stop are
    // exempt (see transport/http/auth/hook.ts) — logout is not among them.
    // AuthService.logout() is itself idempotent for an unknown/expired
    // token, but the request never reaches it without a valid session; a
    // stale cookie is instead cleared by the hook's own 401 path.
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(res.statusCode).toBe(401);
  });

  it('an operator may read a config endpoint', async () => {
    await authenticateAsOperator(app);
    const res = await app.inject({ method: 'GET', url: '/api/layouts' });
    expect(res.statusCode).toBe(200);
  });

  it('an operator writing a config endpoint (creating a block) is refused with 403', async () => {
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts/layout-1/blocks',
      payload: { name: 'Sneaky Block' },
    });
    expect(res.statusCode).toBe(403);
    expect(repo.createBlock).not.toHaveBeenCalled();
  });

  it('an unauthenticated PUT to a point is rejected with 401', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/layouts/layout-1/points/pt1',
      payload: { name: 'Sneaky Point' },
    });
    expect(res.statusCode).toBe(401);
    expect(repo.updatePoint).not.toHaveBeenCalled();
  });

  it('an operator updating a point is refused with 403', async () => {
    await authenticateAsOperator(app);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/layouts/layout-1/points/pt1',
      payload: { name: 'Sneaky Point' },
    });
    expect(res.statusCode).toBe(403);
    expect(repo.updatePoint).not.toHaveBeenCalled();
  });

  it('an admin may update a point', async () => {
    await authenticateAsAdmin(app);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/layouts/layout-1/points/pt1',
      payload: { name: 'Renamed Point' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('an admin may write a config endpoint (creating a block)', async () => {
    await authenticateAsAdmin(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts/layout-1/blocks',
      payload: { name: 'Platform 3' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('a session cookie from admin login carries the admin role, not a hardcoded default', async () => {
    await authenticateAsAdmin(app);
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(JSON.parse(res.body).role).toBe('admin');
  });

  it('rate-limits the login route after 5 attempts within the window', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'test-admin', password: 'wrong-password' },
      });
      expect(res.statusCode).toBe(401);
    }
    const sixth = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'test-admin', password: 'wrong-password' },
    });
    expect(sixth.statusCode).toBe(429);
  });
});
