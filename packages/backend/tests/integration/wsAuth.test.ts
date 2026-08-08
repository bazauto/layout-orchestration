/**
 * WebSocket Upgrade Auth Integration Tests
 *
 * `@fastify/websocket`'s `injectWS()` dispatches the upgrade request through
 * the normal Fastify hook pipeline before switching protocols (see its own
 * "TODO: place upgrade context as options" comment in index.js) — so the
 * global onRequest auth hook (transport/http/auth/hook.ts) runs on a WS
 * upgrade exactly as it would on any other route. A rejected upgrade never
 * reaches "101 Switching Protocols".
 *
 * Note for anyone tempted to write the negative case with `injectWS()`:
 * measured behaviour is that an unauthenticated `injectWS('/ws')` **never
 * settles** — the promise neither resolves nor rejects, so the test simply
 * times out. It does not surface the 401 as a rejection. That is why the
 * rejection cases below use a plain `inject()` GET, which asserts the same
 * property (the hook rejects before any protocol switch) and actually
 * terminates. The authenticated case is still proven with a real
 * `injectWS()` handshake, since that one does resolve.
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
  loginCookie,
  makeTestAuthService,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
  TEST_AUTH_CONFIG,
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

async function buildTestServer(repo: ILayoutRepository) {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager('layout-1');
  const reservations = new ReservationService(repo, state, silentLogger);
  const service = new LayoutService(dcc, mqtt, repo, state, reservations, silentLogger);
  const topologyService = new TopologyService(repo, () => Promise.resolve(), silentLogger, reservations);
  const authService = await makeTestAuthService();
  return buildServer(service, repo, 'silent', topologyService, authService, TEST_AUTH_CONFIG);
}

describe('WebSocket upgrade auth', () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    app = await buildTestServer(makeRepo());
  });

  // The onRequest hook runs identically for every route, including /ws — it
  // has no special knowledge of `{ websocket: true }` routes (see
  // transport/http/auth/hook.ts). A plain, non-upgrade `inject()` GET to
  // /ws therefore already proves the hook covers it: the request is
  // rejected before Fastify ever reaches the websocket-specific handling,
  // let alone completes a protocol switch.
  it('rejects an unauthenticated request to /ws with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/ws' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a request to /ws carrying a garbage cookie value with 401, same as no cookie at all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/ws',
      headers: { cookie: 'layout_session=not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  // The full upgrade handshake, proven end-to-end via injectWS() — this is
  // the acceptance criterion itself: an authenticated client can actually
  // open the socket, not just avoid a 401 on a non-upgrade request.
  it('accepts a real upgrade handshake carrying a valid session cookie', async () => {
    const cookie = await loginCookie(app, TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);
    const ws = await app.injectWS('/ws', { headers: { cookie } });
    expect(ws.readyState).toBe(ws.OPEN);
    ws.close();
  });

  // See docs/sensor-fault-recovery.md DD10: the initial STATE_SNAPSHOT gains
  // a sensorFaults field — present and empty here, since this server's
  // LayoutService is never start()-ed (no fault could have been latched).
  // The message listener is attached via `onOpen`, the earliest hook
  // `injectWS` exposes — the server sends the snapshot the instant the
  // connection handler runs, so a listener attached only after `injectWS`
  // resolves can already be too late to observe it.
  it('the initial STATE_SNAPSHOT payload includes sensorFaults: []', async () => {
    const cookie = await loginCookie(app, TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);
    const messages: string[] = [];
    const ws = await app.injectWS(
      '/ws',
      { headers: { cookie } },
      { onOpen: (socket: { on: (event: string, cb: (data: Buffer) => void) => void }) =>
          socket.on('message', (data: Buffer) => messages.push(data.toString())) },
    );
    // Let any already-buffered frame finish draining through the parser.
    await new Promise((r) => setImmediate(r));

    expect(messages.length).toBeGreaterThan(0);
    const snapshot = JSON.parse(messages[0]);
    expect(snapshot.type).toBe('STATE_SNAPSHOT');
    expect(snapshot.payload.sensorFaults).toEqual([]);

    ws.close();
  });
});
