/**
 * WebSocket Broadcast Integration Tests
 *
 * `wsAuth.test.ts` proves a client can *open* the socket and receive the
 * initial STATE_SNAPSHOT. That snapshot is written with `socket.send` inside
 * the connection handler, so it kept working even while every subsequent
 * broadcast was dead: the fan-out loop guarded each client with
 * `WebSocket.OPEN`, taken from a `@fastify/websocket` export that exists only
 * as a TypeScript type. At runtime it was `undefined`, so the first client in
 * the set threw a TypeError — inside a `layoutService.on('event')` listener,
 * which meant the throw unwound back into whichever domain call had emitted
 * the event. Operators saw a command apply on the server (a page refresh
 * showed the new state) while the live UI never moved.
 *
 * These tests pin the property the snapshot test cannot: an event emitted
 * *after* the connection is open actually reaches the client.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildServer } from '../../src/transport/http/server';
import { LayoutService } from '../../src/services/LayoutService';
import { TopologyService } from '../../src/services/TopologyService';
import { ReservationService } from '../../src/services/ReservationService';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository } from '../../src/ports/ILayoutRepository';
import { HEARTBEAT_INTERVAL_MS } from '../../src/domain/liveness';
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

/**
 * Opens an authenticated socket and collects every frame after the initial
 * STATE_SNAPSHOT. As in wsAuth.test.ts the listener is attached via `onOpen`,
 * the earliest hook `injectWS` exposes.
 */
async function openCollectingClient(app: Awaited<ReturnType<typeof buildTestServer>>['app']) {
  const cookie = await loginCookie(app, TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);
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

describe('WebSocket broadcast', () => {
  let harness: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    harness = await buildTestServer();
  });

  it('delivers a LayoutEvent emitted after connect to a connected client', async () => {
    const { ws, frames } = await openCollectingClient(harness.app);

    harness.service.emit('event', {
      type: 'BLOCK_STATE',
      payload: {
        blockId: 'block-1',
        occupancy: 'occupied',
        locoAddress: null,
        lockedByRoute: null,
        lastUpdated: new Date(),
      },
    });
    await settle();

    expect(frames.map((f) => JSON.parse(f).type)).toContain('BLOCK_STATE');

    ws.close();
  });

  // #76: SENSOR_STATE mirrors BLOCK_STATE's own delta path — no separate
  // broadcast mechanism, just another `LayoutEvent` variant on the same
  // fan-out this describe block exists to pin.
  it('delivers a SENSOR_STATE event emitted after connect to a connected client', async () => {
    const { ws, frames } = await openCollectingClient(harness.app);

    harness.service.emit('event', {
      type: 'SENSOR_STATE',
      payload: {
        sensorId: 'sensor-1',
        blockId: 'block-1',
        type: 'block_detection',
        lastReading: 'occupied',
        trusted: true,
        inService: true,
        faulted: false,
        lastReadingAt: new Date().toISOString(),
        source: 'live',
      },
    });
    await settle();

    const sensorState = frames.map((f) => JSON.parse(f)).find((m) => m.type === 'SENSOR_STATE');
    expect(sensorState).toBeDefined();
    expect(sensorState.payload).toMatchObject({ sensorId: 'sensor-1', lastReading: 'occupied' });

    ws.close();
  });

  it('broadcasts SYSTEM_STATUS when a client sends SET_MODE, rather than erroring', async () => {
    const { ws, frames } = await openCollectingClient(harness.app);

    ws.send(JSON.stringify({ type: 'SET_MODE', payload: { mode: 'auto' } }));
    await settle();

    const parsed = frames.map((f) => JSON.parse(f));
    // The bug surfaced as an ERROR frame, so assert its absence explicitly:
    // the TypeError from the broadcast loop unwound into `handleSetMode` and
    // was reported back as a failed command.
    expect(parsed.filter((m) => m.type === 'ERROR')).toEqual([]);

    const statuses = parsed.filter((m) => m.type === 'SYSTEM_STATUS');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].payload.mode).toBe('auto');
    // Server-side state and the broadcast must agree — the failure mode was
    // precisely that the state moved while the client was never told.
    expect(harness.state.getState().systemMode).toBe('auto');

    ws.close();
  });

  it('reaches every connected client, not just the first in the set', async () => {
    const a = await openCollectingClient(harness.app);
    const b = await openCollectingClient(harness.app);

    a.ws.send(JSON.stringify({ type: 'SET_MODE', payload: { mode: 'hybrid' } }));
    await settle();

    for (const frames of [a.frames, b.frames]) {
      const statuses = frames.map((f) => JSON.parse(f)).filter((m) => m.type === 'SYSTEM_STATUS');
      expect(statuses).toHaveLength(1);
      expect(statuses[0].payload.mode).toBe('hybrid');
    }

    a.ws.close();
    b.ws.close();
  });

  it('keeps broadcasting to the remaining client after another disconnects', async () => {
    const a = await openCollectingClient(harness.app);
    const b = await openCollectingClient(harness.app);

    a.ws.close();
    await settle();

    b.ws.send(JSON.stringify({ type: 'SET_MODE', payload: { mode: 'auto' } }));
    await settle();

    expect(b.frames.map((f) => JSON.parse(f).type)).toContain('SYSTEM_STATUS');

    b.ws.close();
  });
});

// ─── Heartbeat (#82 D5/D7) ──────────────────────────────────────────────────

describe('WebSocket heartbeat (#82)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('broadcasts a HEARTBEAT ServerMessage to every connected client on the interval', async () => {
    // Fakes ONLY setInterval/clearInterval — settle() below still needs a
    // real setTimeout to let the in-process socket actually deliver the
    // frame, and openCollectingClient's setImmediate must stay real too.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const harness = await buildTestServer();
    const a = await openCollectingClient(harness.app);
    const b = await openCollectingClient(harness.app);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    await settle();

    for (const { frames } of [a, b]) {
      const heartbeats = frames.map((f) => JSON.parse(f)).filter((m) => m.type === 'HEARTBEAT');
      expect(heartbeats).toHaveLength(1);
      expect(typeof heartbeats[0].payload.serverTime).toBe('string');
      // A real ISO 8601 timestamp, not just any string.
      expect(new Date(heartbeats[0].payload.serverTime).toISOString()).toBe(
        heartbeats[0].payload.serverTime,
      );
    }

    a.ws.close();
    b.ws.close();
  });

  it('stops broadcasting once the client disconnects (no crash on a closed socket)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    const harness = await buildTestServer();
    const { ws, frames } = await openCollectingClient(harness.app);
    ws.close();
    await settle();

    expect(() => vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)).not.toThrow();
    await settle();

    expect(frames.map((f) => JSON.parse(f).type)).not.toContain('HEARTBEAT');
  });
});

// ─── Reconnect resynchronisation (#82 open question 2) ─────────────────────
//
// Verified rather than assumed, per docs/liveness.md: `registerWebSocket`
// sends a full STATE_SNAPSHOT to every NEW connection before anything else,
// and it carries the CURRENT state — including after a prior connection to
// the same layout has already closed. There is no delta stream resumed from
// an unknown point, so a reconnect cannot desynchronise from what a stale
// delta would imply.

describe('WebSocket reconnect resynchronisation (#82 open question 2)', () => {
  it('a new connection receives a STATE_SNAPSHOT as its first frame, reflecting state changed by a since-closed connection', async () => {
    const harness = await buildTestServer();

    // First connection changes system state, then disconnects.
    const first = await openCollectingClient(harness.app);
    first.ws.send(JSON.stringify({ type: 'SET_MODE', payload: { mode: 'auto' } }));
    await settle();
    first.ws.close();
    await settle();

    // A second, independent connection — its STATE_SNAPSHOT is the first
    // thing it receives, and it already carries the mode the first
    // connection set, not the mode the layout started in.
    const cookie = await loginCookie(harness.app, TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);
    const messages: string[] = [];
    const second = await harness.app.injectWS(
      '/ws',
      { headers: { cookie } },
      {
        onOpen: (socket: { on: (event: string, cb: (data: Buffer) => void) => void }) =>
          socket.on('message', (data: Buffer) => messages.push(data.toString())),
      },
    );
    await new Promise((r) => setImmediate(r));

    expect(messages.length).toBeGreaterThan(0);
    const snapshot = JSON.parse(messages[0]);
    expect(snapshot.type).toBe('STATE_SNAPSHOT');
    expect(snapshot.payload.systemMode).toBe('auto');

    second.close();
  });
});
