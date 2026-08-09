/**
 * User Management HTTP Route Integration Tests (issue #53)
 *
 * Built with `makeTestAuthService()` + `authenticateAsAdmin`/
 * `authenticateAsOperator` from `testAuthHelpers.ts`, so every request logs
 * in for real — the in-memory `IAuthRepository` there now implements
 * `listUsers`/`updateUserRole`/`deleteUser` too (Step 2), which is what lets
 * `AuthService`'s full user-management surface run against it end to end.
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
  authenticateAsOperator,
  loginCookie,
  makeTestAuthService,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
  TEST_AUTH_CONFIG,
  TEST_OPERATOR_PASSWORD,
  TEST_OPERATOR_USERNAME,
} from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeRepo(): ILayoutRepository {
  return {
    listLayouts: vi.fn().mockResolvedValue([]),
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
    listPoints: vi.fn().mockResolvedValue([]),
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

async function buildTestServer() {
  const repo = makeRepo();
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager('layout-1');
  const reservations = new ReservationService(repo, state, silentLogger);
  const service = new LayoutService(dcc, mqtt, repo, state, reservations, silentLogger);
  const topologyService = new TopologyService(repo, () => Promise.resolve(), silentLogger, reservations);
  const authService = await makeTestAuthService();
  return buildServer(service, repo, 'silent', topologyService, authService, TEST_AUTH_CONFIG);
}

describe('User management routes — unauthenticated', () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    app = await buildTestServer();
  });

  it.each([
    { method: 'GET' as const, url: '/api/users' },
    { method: 'POST' as const, url: '/api/users' },
    { method: 'PATCH' as const, url: '/api/users/some-id' },
    { method: 'DELETE' as const, url: '/api/users/some-id' },
    { method: 'POST' as const, url: '/api/users/some-id/password' },
    { method: 'POST' as const, url: '/api/auth/change-password' },
  ])('$method $url is rejected with 401 with no session cookie', async ({ method, url }) => {
    const res = await app.inject({ method, url, payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('User management routes — operator role enforcement', () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    app = await buildTestServer();
    await authenticateAsOperator(app);
  });

  it.each([
    { method: 'GET' as const, url: '/api/users' },
    { method: 'POST' as const, url: '/api/users' },
    { method: 'PATCH' as const, url: '/api/users/some-id' },
    { method: 'DELETE' as const, url: '/api/users/some-id' },
    { method: 'POST' as const, url: '/api/users/some-id/password' },
  ])('$method $url is refused with 403 for an operator', async ({ method, url }) => {
    const res = await app.inject({ method, url, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe('User management routes — admin CRUD', () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>;
  let adminCookie: string;

  // Deliberately NOT authenticateAsAdmin() here — several tests below need
  // to inspect the behaviour of a SECOND, specific cookie (a just-demoted or
  // just-deleted user's) after an admin-authenticated write. authenticateAs*
  // monkey-patches app.inject to force one fixed cookie onto every request,
  // which would silently override an explicit `headers: { cookie }` on those
  // assertions. A plain loginCookie() + explicit header on every call avoids
  // that trap uniformly across this describe block.
  beforeEach(async () => {
    app = await buildTestServer();
    adminCookie = await loginCookie(app, TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);
  });

  it('creates an operator, GET /api/users shows it, and the new operator can log in for real', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: 'newop', password: 'a-good-password', role: 'operator' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = JSON.parse(createRes.body);
    expect(created.username).toBe('newop');
    expect(created.role).toBe('operator');

    const listRes = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: adminCookie } });
    expect(listRes.statusCode).toBe(200);
    const list = JSON.parse(listRes.body);
    expect(list.some((u: { username: string }) => u.username === 'newop')).toBe(true);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'newop', password: 'a-good-password' },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it('response bodies never contain passwordHash', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: 'nohash', password: 'a-good-password', role: 'operator' },
    });
    expect(createRes.body).not.toContain('passwordHash');

    const listRes = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: adminCookie } });
    expect(listRes.body).not.toContain('passwordHash');
  });

  it('create with a missing role returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: 'norole', password: 'a-good-password' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('create with an unknown extra field returns 400 (.strict())', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: 'extra', password: 'a-good-password', role: 'operator', isAdmin: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('create with a 7-character password returns 400 and says how to fix it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: 'shortpw', password: '1234567', role: 'operator' },
    });
    expect(res.statusCode).toBe(400);

    // The admin only ever sees `details` — the frontend surfaces the field
    // errors in preference to the generic `error` label. Zod's default text
    // ("String must contain at least 8 character(s)") is not an instruction.
    const body = res.json() as { details: { fieldErrors: Record<string, string[]> } };
    expect(body.details.fieldErrors.password).toEqual([
      'Password must be at least 8 characters',
    ]);
  });

  it('create with a duplicate username returns 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: TEST_OPERATOR_USERNAME, password: 'a-good-password', role: 'operator' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('demoting the sole admin returns 409, and the admin can still reach an admin-only route afterwards', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: adminCookie } });
    const admin = JSON.parse(listRes.body).find((u: { username: string }) => u.username === TEST_ADMIN_USERNAME);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${admin.id}`,
      headers: { cookie: adminCookie },
      payload: { role: 'operator' },
    });
    expect(res.statusCode).toBe(409);

    const stillWorks = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: adminCookie } });
    expect(stillWorks.statusCode).toBe(200);
  });

  it('demoting a second admin returns 200, and that admin cookie now returns 401', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: 'second-admin', password: 'a-good-password', role: 'admin' },
    });
    const second = JSON.parse(createRes.body);

    const secondCookie = await loginCookie(app, 'second-admin', 'a-good-password');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${second.id}`,
      headers: { cookie: adminCookie },
      payload: { role: 'operator' },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).role).toBe('operator');

    const afterDemote = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: secondCookie },
    });
    expect(afterDemote.statusCode).toBe(401);
  });

  it('deleting an operator returns 204, and that operator cookie now returns 401', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { username: 'to-delete', password: 'a-good-password', role: 'operator' },
    });
    const created = JSON.parse(createRes.body);
    const cookie = await loginCookie(app, 'to-delete', 'a-good-password');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/users/${created.id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(204);

    const afterDelete = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie },
    });
    expect(afterDelete.statusCode).toBe(401);
  });

  it('PATCHing your own id returns 409', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: adminCookie } });
    const admin = JSON.parse(listRes.body).find((u: { username: string }) => u.username === TEST_ADMIN_USERNAME);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${admin.id}`,
      headers: { cookie: adminCookie },
      payload: { role: 'operator' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('DELETEing your own id returns 409', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: adminCookie } });
    const admin = JSON.parse(listRes.body).find((u: { username: string }) => u.username === TEST_ADMIN_USERNAME);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/users/${admin.id}`,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /api/auth/change-password', () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    app = await buildTestServer();
  });

  it('an operator changing their own password with the correct current password returns 204, clears the cookie, revokes the old session, and the new password works', async () => {
    // Deliberately NOT authenticateAsOperator() here — that monkey-patches
    // app.inject to force every request's cookie header, which would
    // clobber the explicit `headers: { cookie: oldCookie }` below. A plain
    // loginCookie() (same as wsAuth.test.ts) gives an unpatched cookie this
    // test controls directly.
    const oldCookie = await loginCookie(app, TEST_OPERATOR_USERNAME, TEST_OPERATOR_PASSWORD);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie: oldCookie },
      payload: { currentPassword: TEST_OPERATOR_PASSWORD, newPassword: 'a-brand-new-password' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBeDefined();

    const afterChange = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { cookie: oldCookie },
    });
    expect(afterChange.statusCode).toBe(401);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: TEST_OPERATOR_USERNAME, password: 'a-brand-new-password' },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it('the wrong current password returns 403, not 401', async () => {
    const cookie = await loginCookie(app, TEST_OPERATOR_USERNAME, TEST_OPERATOR_PASSWORD);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'totally-wrong', newPassword: 'a-brand-new-password' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a short newPassword returns 400 and the old password still works', async () => {
    const cookie = await loginCookie(app, TEST_OPERATOR_USERNAME, TEST_OPERATOR_PASSWORD);

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: TEST_OPERATOR_PASSWORD, newPassword: '1234567' },
    });
    expect(res.statusCode).toBe(400);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: TEST_OPERATOR_USERNAME, password: TEST_OPERATOR_PASSWORD },
    });
    expect(loginRes.statusCode).toBe(200);
  });
});
