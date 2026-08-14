/**
 * WebSocket Role-Gate Integration Tests (#63 D2/D3)
 *
 * `transport/websocket/index.ts` captures `request.user.role` once at the
 * upgrade into a per-connection constant and refuses a driving
 * `ClientMessage` from a `monitor` connection with an `ERROR` reply — never
 * a socket close, matching D3 and the "auth is enforced only at the
 * connection edge" property in docs/auth.md. These tests pin that behaviour
 * per role: monitor is refused every driving command but keeps its socket
 * open and EMERGENCY_STOP still works; admin and operator are unaffected.
 *
 * The final describe block pins the fail-safe DIRECTION of the fallback used
 * when `request.user` is absent (`request.user?.role ?? 'monitor'`) — that
 * branch is meant to be unreachable in normal operation
 * (`registerAuthHook` always populates `request.user` first, per
 * `wsAuth.test.ts`), but an unreachable defensive default must still resolve
 * toward less authority, not more.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import fastifyWebSocket from '@fastify/websocket';
import { buildServer } from '../../src/transport/http/server';
import { registerWebSocket } from '../../src/transport/websocket/index';
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
  TEST_MONITOR_PASSWORD,
  TEST_MONITOR_USERNAME,
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
  const app = await buildServer(service, repo, 'silent', topologyService, authService, TEST_AUTH_CONFIG);
  return { app, service, state };
}

/** Opens an authenticated socket as `username` and collects every frame after the initial STATE_SNAPSHOT. */
async function openCollectingClientAs(
  app: Awaited<ReturnType<typeof buildTestServer>>['app'],
  username: string,
  password: string,
) {
  const cookie = await loginCookie(app, username, password);
  const frames: string[] = [];
  const ws = await app.injectWS(
    '/ws',
    { headers: { cookie } },
    {
      onOpen: (socket: { on: (event: string, cb: (data: Buffer) => void) => void }) =>
        socket.on('message', (data: Buffer) => frames.push(data.toString())),
    },
  );
  await new Promise((r) => setImmediate(r));
  frames.length = 0; // drop the STATE_SNAPSHOT; these tests are about what comes after
  return { ws, frames };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('WebSocket role gate (#63)', () => {
  let harness: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    harness = await buildTestServer();
  });

  const DRIVING_MESSAGES: Array<{ type: string; payload: unknown }> = [
    { type: 'THROTTLE_COMMAND', payload: { locoAddress: 3, speed: 20, direction: 'fwd' } },
    { type: 'POINT_COMMAND', payload: { pointId: 'point-1', position: 'normal' } },
    { type: 'FUNCTION_COMMAND', payload: { locoAddress: 3, fn: 0, state: true } },
    { type: 'SET_MODE', payload: { mode: 'auto' } },
  ];

  for (const msg of DRIVING_MESSAGES) {
    it(`refuses a monitor's ${msg.type} with an ERROR, and keeps the socket open`, async () => {
      const { ws, frames } = await openCollectingClientAs(
        harness.app,
        TEST_MONITOR_USERNAME,
        TEST_MONITOR_PASSWORD,
      );

      ws.send(JSON.stringify(msg));
      await settle();

      expect(ws.readyState).toBe(ws.OPEN); // D3: refused, never a socket close
      // The refusal frame is the ONLY frame — no BLOCK_STATE/POINT_STATE/
      // LOCO_STATE/SYSTEM_STATUS broadcast, proving the message was refused
      // at the gate rather than reaching LayoutService and merely producing
      // a follow-up error.
      const parsed = frames.map((f) => JSON.parse(f));
      expect(parsed).toHaveLength(1);
      expect(parsed[0].type).toBe('ERROR');
      expect(parsed[0].payload.message).toContain(msg.type);

      ws.close();
    });
  }

  it("does not refuse an operator's SET_MODE — only monitor is gated", async () => {
    const { ws, frames } = await openCollectingClientAs(
      harness.app,
      TEST_OPERATOR_USERNAME,
      TEST_OPERATOR_PASSWORD,
    );

    ws.send(JSON.stringify({ type: 'SET_MODE', payload: { mode: 'auto' } }));
    await settle();

    const parsed = frames.map((f) => JSON.parse(f));
    expect(parsed.filter((m) => m.type === 'ERROR')).toEqual([]);
    expect(parsed.some((m) => m.type === 'SYSTEM_STATUS' && m.payload.mode === 'auto')).toBe(true);

    ws.close();
  });

  it("does not refuse an admin's SET_MODE — only monitor is gated", async () => {
    const { ws, frames } = await openCollectingClientAs(
      harness.app,
      TEST_ADMIN_USERNAME,
      TEST_ADMIN_PASSWORD,
    );

    ws.send(JSON.stringify({ type: 'SET_MODE', payload: { mode: 'hybrid' } }));
    await settle();

    const parsed = frames.map((f) => JSON.parse(f));
    expect(parsed.filter((m) => m.type === 'ERROR')).toEqual([]);
    expect(parsed.some((m) => m.type === 'SYSTEM_STATUS' && m.payload.mode === 'hybrid')).toBe(true);

    ws.close();
  });

  // D4: EMERGENCY_STOP is deliberately absent from the gated set — every
  // role, including monitor, may send it. It only moves the system in the
  // fail-safe direction.
  it("a monitor's EMERGENCY_STOP is honoured, not refused", async () => {
    const { ws, frames } = await openCollectingClientAs(
      harness.app,
      TEST_MONITOR_USERNAME,
      TEST_MONITOR_PASSWORD,
    );

    ws.send(JSON.stringify({ type: 'EMERGENCY_STOP' }));
    await settle();

    // Not gated, not refused: no ERROR frame is the observable difference
    // between "processed" and "refused before reaching LayoutService" — same
    // proof shape as the operator/admin SET_MODE tests above.
    const parsed = frames.map((f) => JSON.parse(f));
    expect(parsed.filter((m) => m.type === 'ERROR')).toEqual([]);

    ws.close();
  });
});

// ─── Fail-safe fallback direction ──────────────────────────────────────────
//
// `registerAuthHook` always populates `request.user` before an upgrade
// reaches `registerWebSocket`'s handler — the branch where it doesn't is
// meant to be unreachable, and `wsAuth.test.ts` already proves an
// unauthenticated upgrade never gets that far. What this pins is the OTHER
// half: if that invariant were ever broken by a future change, which way the
// default falls. `request.user ?? '<role>'` must resolve toward LESS
// authority, not more (CLAUDE.md safety rule 1). Reaching the unreachable
// branch on purpose means testing `registerWebSocket` in isolation, with no
// auth hook registered at all — the one legitimate way to exercise "what if
// `request.user` were absent" without weakening the real hook this test
// deliberately does not register.

describe('WebSocket role gate — fail-safe fallback direction', () => {
  async function buildHookless() {
    const repo = makeRepo();
    const dcc = new SimulatedDccAdapter(silentLogger);
    const mqtt = new SimulatedMqttAdapter();
    const state = new LayoutStateManager('layout-1');
    const reservations = new ReservationService(repo, state, silentLogger);
    const service = new LayoutService(dcc, mqtt, repo, state, reservations, silentLogger);

    // No registerAuthHook: this Fastify instance never sets `request.user`
    // for anything, which is exactly the state the fallback exists to defend
    // against — an upgrade reaching the handler carrying no identity.
    const app = Fastify({ logger: { level: 'silent' } });
    await app.register(fastifyWebSocket);
    await registerWebSocket(app, service);
    // `buildServer`'s tests never need this explicitly — `app.inject()`
    // drives the ready lifecycle itself — but `injectWS()` against an
    // instance that skipped the rest of `buildServer`'s plugin registration
    // hangs indefinitely without it.
    await app.ready();
    return { app, service, state };
  }

  async function openCollectingClient(app: Awaited<ReturnType<typeof buildHookless>>['app']) {
    const frames: string[] = [];
    const ws = await app.injectWS(
      '/ws',
      {},
      {
        onOpen: (socket: { on: (event: string, cb: (data: Buffer) => void) => void }) =>
          socket.on('message', (data: Buffer) => frames.push(data.toString())),
      },
    );
    await new Promise((r) => setImmediate(r));
    frames.length = 0; // drop the STATE_SNAPSHOT
    return { ws, frames };
  }

  it('a connection with no request.user is refused a driving command, not granted one', async () => {
    const harness = await buildHookless();
    const { ws, frames } = await openCollectingClient(harness.app);

    ws.send(JSON.stringify({ type: 'SET_MODE', payload: { mode: 'auto' } }));
    await settle();

    expect(ws.readyState).toBe(ws.OPEN); // D3: refused, never a socket close
    const parsed = frames.map((f) => JSON.parse(f));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('ERROR');
    expect(parsed[0].payload.message).toContain('SET_MODE');
    // The command must not have reached LayoutService either — if the
    // fallback were ever 'operator' (or any role above 'monitor'), this
    // would have applied.
    expect(harness.state.getState().systemMode).toBe('manual');

    ws.close();
  });

  it('a connection with no request.user still gets EMERGENCY_STOP (D4) — the fallback restricts driving, not the fail-safe control', async () => {
    const harness = await buildHookless();
    const { ws, frames } = await openCollectingClient(harness.app);

    ws.send(JSON.stringify({ type: 'EMERGENCY_STOP' }));
    await settle();

    const parsed = frames.map((f) => JSON.parse(f));
    expect(parsed.filter((m) => m.type === 'ERROR')).toEqual([]);

    ws.close();
  });
});
