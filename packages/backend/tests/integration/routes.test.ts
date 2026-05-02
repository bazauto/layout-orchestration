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
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository } from '../../src/ports/ILayoutRepository';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const LAYOUT = {
  id: 'layout-1',
  name: 'Test Layout',
  description: null,
  createdAt: new Date('2026-01-01'),
};

const BLOCK  = { id: 'b1', layoutId: 'layout-1', name: 'Platform 1' };
const POINT  = { id: 'pt1', layoutId: 'layout-1', name: 'Point 1', dccAddress: 10, blockId: 'b1' };
const SENSOR = { id: 's1', layoutId: 'layout-1', name: 'Sensor 1', type: 'block_detection' as const, blockId: 'b1', mqttTopic: 'sensor/s1' };
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
  };
}

async function buildTestServer(repo: ILayoutRepository) {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager('layout-1');
  const service = new LayoutService(dcc, mqtt, repo, state, silentLogger);
  // Don't call service.start() — we only need the HTTP layer here.
  return buildServer(service, repo, 'silent');
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

  it('DELETE /api/layouts/:layoutId/blocks/:id returns 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/layouts/layout-1/blocks/b1' });
    expect(res.statusCode).toBe(204);
    expect(repo.deleteBlock).toHaveBeenCalledWith('b1');
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
