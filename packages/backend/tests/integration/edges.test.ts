/**
 * Edge & Topology HTTP Route Integration Tests
 *
 * Mirrors the conventions in routes.test.ts (Fastify inject, no real
 * database), but backs the repository stub with real mutable in-memory
 * state for layouts/blocks/points/edges — the whole point of this route is
 * server-side topology validation (TopologyService), which needs realistic
 * cross-references to exercise, not a fixed canned response.
 *
 * The LayoutService IS started here (unlike routes.test.ts), because
 * `onTopologyChanged` / `POST .../topology/revalidate` both go through
 * `LayoutService.reloadTopology()`, which requires a started service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../../src/transport/http/server';
import { LayoutService } from '../../src/services/LayoutService';
import { TopologyService } from '../../src/services/TopologyService';
import { ReservationService } from '../../src/services/ReservationService';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository, BlockRecord, PointRecord } from '../../src/ports/ILayoutRepository';
import { IRouteLockView } from '../../src/ports/IRouteLockView';
import { BlockEdge } from '../../src/domain/types';
import {
  authenticateAsAdmin,
  authenticateAsOperator,
  makeTestAuthService,
  TEST_AUTH_CONFIG,
} from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const LAYOUT_ID = 'layout-1';
const OTHER_LAYOUT_ID = 'layout-2';

const BLOCKS: BlockRecord[] = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
  { id: 'b3', layoutId: LAYOUT_ID, name: 'Block 3' },
  { id: 'b-other', layoutId: OTHER_LAYOUT_ID, name: 'Other Layout Block' },
];

const POINTS: PointRecord[] = [{ id: 'p1', layoutId: LAYOUT_ID, name: 'Point 1', dccAddress: 1, blockId: null }];

/** A minimal but real mutable in-memory ILayoutRepository, edges-focused. */
function makeRepo(): ILayoutRepository {
  const edges = new Map<string, BlockEdge>();
  let nextId = 1;

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

    listBlocks: vi.fn().mockImplementation(async (layoutId: string) =>
      BLOCKS.filter((b) => b.layoutId === layoutId),
    ),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn().mockImplementation(async (id: string) => {
      for (const [edgeId, edge] of edges) {
        if (edge.fromBlockId === id || edge.toBlockId === id) edges.delete(edgeId);
      }
    }),

    listPoints: vi.fn().mockImplementation(async (layoutId: string) =>
      POINTS.filter((p) => p.layoutId === layoutId),
    ),
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

    listBlockEdges: vi.fn().mockImplementation(async (layoutId: string) =>
      [...edges.values()].filter((e) => e.layoutId === layoutId),
    ),
    getBlockEdge: vi.fn().mockImplementation(async (id: string) => edges.get(id) ?? null),
    createBlockEdge: vi.fn().mockImplementation(async (data: Omit<BlockEdge, 'id'>) => {
      const edge: BlockEdge = { id: `e${nextId++}`, ...data };
      edges.set(edge.id, edge);
      return edge;
    }),
    updateBlockEdge: vi
      .fn()
      .mockImplementation(async (id: string, data: Partial<Omit<BlockEdge, 'id' | 'layoutId'>>) => {
        const existing = edges.get(id);
        if (!existing) throw new Error(`Edge ${id} not found`);
        const updated = { ...existing, ...data };
        edges.set(id, updated);
        return updated;
      }),
    deleteBlockEdge: vi.fn().mockImplementation(async (id: string) => {
      edges.delete(id);
    }),

    listReservations: vi.fn().mockResolvedValue([]),
    getReservation:   vi.fn().mockResolvedValue(null),
    createReservation: vi.fn(),
    updateReservation: vi.fn(),
    markHoldsReleased: vi.fn(),
  };
}

/**
 * Logs in as the seeded admin by default (unless `skipLogin`) — see
 * testAuthHelpers.ts. Edge/topology writes require the admin role, and this
 * file's existing tests were all written to exercise TopologyService, not
 * auth, so they run as admin unless a test opts out.
 */
async function buildTestServer(
  repo: ILayoutRepository,
  options: { skipLogin?: boolean; lockView?: IRouteLockView } = {},
) {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager(LAYOUT_ID);
  const reservations = new ReservationService(repo, state, silentLogger);
  const service = new LayoutService(dcc, mqtt, repo, state, reservations, silentLogger);
  const topologyService = new TopologyService(
    repo,
    () => service.reloadTopology(),
    silentLogger,
    options.lockView ?? reservations,
  );
  await service.start(LAYOUT_ID);
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

describe('Edge routes', () => {
  let repo: ILayoutRepository;
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    repo = makeRepo();
    app = await buildTestServer(repo);
  });

  it('GET /api/layouts/:layoutId/edges returns an empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/edges` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('lists what the graph actually holds, whoever wrote it', async () => {
    await repo.createBlockEdge({
      layoutId: LAYOUT_ID,
      fromBlockId: 'b1',
      fromEnd: 'east',
      toBlockId: 'b2',
      toEnd: 'west',
      pointConditions: [],
    });

    const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/edges` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toHaveLength(1);
  });

  it('an operator may still read edges', async () => {
    await authenticateAsOperator(app);
    const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/edges` });
    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['POST', `/api/layouts/${LAYOUT_ID}/edges`],
    ['PUT', `/api/layouts/${LAYOUT_ID}/edges/e1`],
    ['DELETE', `/api/layouts/${LAYOUT_ID}/edges/e1`],
  ])('%s is a 404 — the write path does not exist (#103 PR 5, OQ1)', async (method, url) => {
    // **404, not 403 or 405.** The same posture `sensorSimulation` takes for an
    // absent capability: a route that exists and refuses invites "under what
    // conditions would it accept", and the answer here is never. `block_edges`
    // is written by `POST .../topology/compile/apply` and by nothing else, so a
    // second write path would reintroduce at a new seam the two-representations
    // problem #103 exists to end — D3 makes a recompile a replace, and a
    // hand-authored edge would simply vanish at the next apply.
    const res = await app.inject({
      method: method as 'POST' | 'PUT' | 'DELETE',
      url,
      payload: { fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' },
    });

    expect(res.statusCode).toBe(404);
    // Nothing reached the repository — this is an absent route, not a handler
    // that read the body and thought better of it.
    expect(repo.createBlockEdge).not.toHaveBeenCalled();
    expect(repo.updateBlockEdge).not.toHaveBeenCalled();
    expect(repo.deleteBlockEdge).not.toHaveBeenCalled();
  });

  it('answers an unauthenticated caller 401 first — the auth hook precedes routing', async () => {
    // Not 404, and that is the auth hook doing its job rather than an
    // inconsistency: it is a global `onRequest` and runs before Fastify has
    // matched a route, so "this path does not exist" is only ever visible to
    // someone with a session. Pinned because the case above asserts 404 and
    // the difference between the two is worth being deliberate about.
    const anon = await buildTestServer(makeRepo(), { skipLogin: true });
    const res = await anon.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('Topology routes', () => {
  let repo: ILayoutRepository;
  let app: Awaited<ReturnType<typeof buildTestServer>>;

  beforeEach(async () => {
    repo = makeRepo();
    app = await buildTestServer(repo);
  });

  it('GET /api/layouts/:layoutId/topology returns valid status with no edges', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/topology` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ valid: true, violations: [], edgeCount: 0 });
  });

  it('POST /api/layouts/:layoutId/topology/revalidate reloads and reports the current edge count', async () => {
    // Seeded through the repository rather than the API: there is no edge write
    // route any more, and what this asserts is that revalidate re-reads the
    // stored graph — not how the graph got there.
    await repo.createBlockEdge({
      layoutId: LAYOUT_ID,
      fromBlockId: 'b1',
      fromEnd: 'east',
      toBlockId: 'b2',
      toEnd: 'west',
      pointConditions: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/topology/revalidate`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.valid).toBe(true);
    expect(body.edgeCount).toBe(1);
  });
});

