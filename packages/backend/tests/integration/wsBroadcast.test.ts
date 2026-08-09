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
