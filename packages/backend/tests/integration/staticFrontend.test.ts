/**
 * Serving the built SPA from the backend (#143).
 *
 * The deployment on the bench box is one process on one port: the API, the
 * `/ws` upgrade and the operator UI all answer on :3000. That makes every
 * browser request same-origin, which is what removes CORS and the cross-site
 * cookie question from a real deployment entirely.
 *
 * The one thing that can silently break it is ordering. `@fastify/static` is
 * registered *before* the global auth hook, so index.html and the bundle are
 * reachable without a session — a 401 on the login screen is a deployment
 * nobody can log into, and it would only be discovered on the layout. These
 * tests pin that ordering from both directions: the SPA is anonymous, and
 * /api is still not.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildServer } from '../../src/transport/http/server';
import { LayoutService } from '../../src/services/LayoutService';
import { TopologyService } from '../../src/services/TopologyService';
import { ReservationService } from '../../src/services/ReservationService';
import { NameBookCache } from '../../src/services/nameBook';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository } from '../../src/ports/ILayoutRepository';
import { CompileService } from '../../src/services/CompileService';
import { makeTestAuthService, TEST_AUTH_CONFIG } from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const LAYOUT_ID = 'layout-1';

const INDEX_HTML = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';
const BUNDLE_JS = 'console.log("operator ui");';

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

async function buildTestServer(frontendDistPath?: string) {
  const repo = makeRepo();
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager(LAYOUT_ID);
  const nameBook = new NameBookCache(repo, LAYOUT_ID);
  const reservations = new ReservationService(repo, state, silentLogger, nameBook);
  const service = new LayoutService(
    dcc,
    mqtt,
    repo,
    state,
    reservations,
    silentLogger,
    undefined,
    nameBook,
  );
  await service.start(LAYOUT_ID);
  const topologyService = new TopologyService(
    repo,
    () => Promise.resolve(),
    silentLogger,
    reservations,
    nameBook,
  );
  const authService = await makeTestAuthService();
  return buildServer(
    service,
    repo,
    'silent',
    topologyService,
    authService,
    TEST_AUTH_CONFIG,
    nameBook,
    undefined,
    new CompileService(repo, topologyService),
    frontendDistPath,
  );
}

let distPath: string;

beforeAll(() => {
  distPath = mkdtempSync(join(tmpdir(), 'layout-dist-'));
  writeFileSync(join(distPath, 'index.html'), INDEX_HTML);
  mkdirSync(join(distPath, 'assets'));
  writeFileSync(join(distPath, 'assets', 'index-abc123.js'), BUNDLE_JS);
});

afterAll(() => {
  rmSync(distPath, { recursive: true, force: true });
});

describe('serving the built SPA (#143)', () => {
  it('serves index.html at / with no session — the login screen must be reachable', async () => {
    const app = await buildTestServer(distPath);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(INDEX_HTML);
  });

  it('serves a hashed bundle out of assets/ with no session', async () => {
    const app = await buildTestServer(distPath);
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(BUNDLE_JS);
  });

  it('still refuses /api without a session — static registration must not widen the auth hook', async () => {
    const app = await buildTestServer(distPath);
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    expect(res.statusCode).toBe(401);
  });

  it('does not serve files from outside the dist root', async () => {
    const app = await buildTestServer(distPath);
    const res = await app.inject({ method: 'GET', url: '/../../package.json' });
    expect(res.statusCode).not.toBe(200);
  });

  it('an unknown path is a 401, not index.html — there is no history-API fallback', async () => {
    // The SPA has no client-side router, so nothing legitimately requests a
    // path other than `/`. If routing is ever added, this expectation is the
    // one that will fail, and the fix is a fallback that answers for the auth
    // hook as well — see the comment in server.ts.
    const app = await buildTestServer(distPath);
    const res = await app.inject({ method: 'GET', url: '/track-editor' });
    expect(res.statusCode).toBe(401);
  });

  it('serves nothing at / when no dist path is configured — development is unaffected', async () => {
    const app = await buildTestServer(undefined);
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(401);
  });
});
