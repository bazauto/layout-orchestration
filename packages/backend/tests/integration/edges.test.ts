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
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository, BlockRecord, PointRecord } from '../../src/ports/ILayoutRepository';
import { BlockEdge } from '../../src/domain/types';
import { MAX_EDGES_PER_LAYOUT } from '../../src/domain/topology';

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
  };
}

async function buildTestServer(repo: ILayoutRepository) {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager(LAYOUT_ID);
  const service = new LayoutService(dcc, mqtt, repo, state, silentLogger);
  const topologyService = new TopologyService(repo, () => service.reloadTopology(), silentLogger);
  await service.start(LAYOUT_ID);
  return buildServer(service, repo, 'silent', topologyService);
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

  it('POST with a malformed payload (missing required field) returns 400 with details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { fromBlockId: 'b1' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.details).toBeDefined();
  });

  it('POST with an unknown key (id) returns 400 (.strict())', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { id: 'sneaky', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST with a valid payload returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      layoutId: LAYOUT_ID,
      fromBlockId: 'b1',
      fromEnd: 'east',
      toBlockId: 'b2',
      toEnd: 'west',
      pointConditions: [],
      lengthMm: null,
    });
  });

  it('POST with a fromBlockId belonging to another layout returns 422 with a violations[0].kind of unknown-block', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { fromBlockId: 'b-other', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.violations[0].kind).toBe('unknown-block');
  });

  it('POST with fromEnd "  North " normalises to "north" and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { fromBlockId: 'b1', fromEnd: '  North ', toBlockId: 'b3', toEnd: 'south' },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).fromEnd).toBe('north');
  });

  it('PUT updates an existing edge and returns 200', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' },
    });
    const created = JSON.parse(createRes.body);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/layouts/${LAYOUT_ID}/edges/${created.id}`,
      payload: { lengthMm: 500 },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).lengthMm).toBe(500);
  });

  it('PUT on a nonexistent edge returns 404', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/layouts/${LAYOUT_ID}/edges/does-not-exist`,
      payload: { lengthMm: 500 },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PUT that would create a self-loop returns 422', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' },
    });
    const created = JSON.parse(createRes.body);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/layouts/${LAYOUT_ID}/edges/${created.id}`,
      payload: { toBlockId: 'b1' },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.violations.some((v: { kind: string }) => v.kind === 'self-loop')).toBe(true);
  });

  it('DELETE removes an existing edge and returns 204', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' },
    });
    const created = JSON.parse(createRes.body);

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/layouts/${LAYOUT_ID}/edges/${created.id}`,
    });
    expect(res.statusCode).toBe(204);

    const listRes = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/edges` });
    expect(JSON.parse(listRes.body)).toEqual([]);
  });

  it('DELETE on a nonexistent edge returns 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/layouts/${LAYOUT_ID}/edges/does-not-exist`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST at the edge cap returns 409 with limit/current, and a rejected create does not partially apply', async () => {
    // Filled through the repo fake directly, not one HTTP POST per edge — a
    // capped bulk insert through the API would itself be O(N^2) and would
    // dominate the test runtime for no benefit (see the Step 6 plan note).
    for (let i = 0; i < MAX_EDGES_PER_LAYOUT; i++) {
      await repo.createBlockEdge({
        layoutId: LAYOUT_ID,
        fromBlockId: 'b1',
        fromEnd: `east-${i}`,
        toBlockId: 'b2',
        toEnd: `west-${i}`,
        pointConditions: [],
        lengthMm: null,
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { fromBlockId: 'b1', fromEnd: 'north', toBlockId: 'b2', toEnd: 'south' },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.limit).toBe(MAX_EDGES_PER_LAYOUT);
    expect(body.current).toBe(MAX_EDGES_PER_LAYOUT);

    const listRes = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/edges` });
    expect(JSON.parse(listRes.body)).toHaveLength(MAX_EDGES_PER_LAYOUT);
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
    await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/edges`,
      payload: { fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' },
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
