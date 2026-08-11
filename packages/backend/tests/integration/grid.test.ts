/**
 * Grid write-path integration tests (#70, see docs/track-grid.md).
 *
 * The route previously declared its body with a Fastify `Body` generic and
 * nothing else, so every assertion in it was erased at compile time: any
 * `tileType` string, any coordinate, and any `metadata` object persisted
 * verbatim. These tests are written against the boundary the generic only
 * claimed to guard.
 *
 * Posture under test throughout: a malformed grid write is an ordinary
 * **400**. Nothing here may Safe-Stop — that rule is scoped to sensor and
 * control topics (CLAUDE.md Traps), and turning a bad Track Editor request
 * into a layout halt would itself be a bug.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildServer } from '../../src/transport/http/server';
import { LayoutService } from '../../src/services/LayoutService';
import { TopologyService } from '../../src/services/TopologyService';
import { ReservationService } from '../../src/services/ReservationService';
import { NameBookCache } from '../../src/services/nameBook';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { GridTileRecord, ILayoutRepository } from '../../src/ports/ILayoutRepository';
import {
  authenticateAsAdmin,
  authenticateAsOperator,
  makeTestAuthService,
  TEST_AUTH_CONFIG,
} from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const LAYOUT_ID = 'layout-1';
const BLOCK_ID = 'block-1';
const POINT_ID = 'point-1';

const GRID_URL = `/api/layouts/${LAYOUT_ID}/grid`;

let tiles: GridTileRecord[];

/**
 * Repository stub whose grid methods are backed by a real array, so an upsert
 * is actually observable — the persisted `metadata` string is the whole point
 * of several assertions below.
 */
function makeRepo(): ILayoutRepository {
  tiles = [];
  let nextTileId = 1;

  return {
    listLayouts: vi.fn().mockResolvedValue([]),
    getLayout: vi.fn(async (id: string) =>
      id === LAYOUT_ID ? { id: LAYOUT_ID, name: 'Westgate Hollow', createdAt: new Date() } : null,
    ),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn().mockResolvedValue([]),
    getLoco: vi.fn().mockResolvedValue(null),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn(async (layoutId: string) =>
      layoutId === LAYOUT_ID ? [{ id: BLOCK_ID, layoutId: LAYOUT_ID, name: 'Down Platform' }] : [],
    ),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn(async (layoutId: string) =>
      layoutId === LAYOUT_ID
        ? [{ id: POINT_ID, layoutId: LAYOUT_ID, name: 'Yard Throat', dccAddress: 7, blockId: null }]
        : [],
    ),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn().mockResolvedValue([]),
    createSensor: vi.fn(),
    updateSensor: vi.fn(),
    deleteSensor: vi.fn(),
    listGridTiles: vi.fn(async (layoutId: string) => tiles.filter((t) => t.layoutId === layoutId)),
    upsertGridTile: vi.fn(async (data: Omit<GridTileRecord, 'id'>) => {
      const existing = tiles.find(
        (t) => t.layoutId === data.layoutId && t.x === data.x && t.y === data.y,
      );
      if (existing) {
        existing.tileType = data.tileType;
        existing.metadata = data.metadata;
        return existing;
      }
      const created = { id: `tile-${nextTileId++}`, ...data };
      tiles.push(created);
      return created;
    }),
    deleteTile: vi.fn(async (id: string) => {
      tiles = tiles.filter((t) => t.id !== id);
    }),
    clearGrid: vi.fn(async (layoutId: string) => {
      tiles = tiles.filter((t) => t.layoutId !== layoutId);
    }),
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
  } as unknown as ILayoutRepository;
}

async function buildTestServer() {
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
  const app = await buildServer(
    service,
    repo,
    'silent',
    topologyService,
    authService,
    TEST_AUTH_CONFIG,
    nameBook,
  );
  return { app, repo, service };
}

let app: Awaited<ReturnType<typeof buildTestServer>>['app'];
let service: LayoutService;

beforeEach(async () => {
  const built = await buildTestServer();
  app = built.app;
  service = built.service;
  await authenticateAsAdmin(app);
});

function put(payload: unknown) {
  return app.inject({ method: 'PUT', url: GRID_URL, payload });
}

describe('PUT /api/layouts/:layoutId/grid — payload shape', () => {
  it('accepts a well-formed tile and persists the metadata it validated', async () => {
    const res = await put({
      x: 3,
      y: 4,
      tileType: 'point-left',
      metadata: { rotation: 90, blockId: BLOCK_ID, pointId: POINT_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ x: 3, y: 4, tileType: 'point-left' });
    expect(JSON.parse(JSON.parse(res.body).metadata)).toEqual({
      rotation: 90,
      blockId: BLOCK_ID,
      pointId: POINT_ID,
    });
  });

  it('omitting metadata entirely is legitimate and stores {}', async () => {
    const res = await put({ x: 1, y: 1, tileType: 'straight-h' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).metadata).toBe('{}');
  });

  // The concrete failure the issue names: an unknown tileType renders as
  // nothing (`TilePath`'s `default: return null`) but still occupies its cell
  // and still blocks placement, so it is an invisible obstruction.
  it('rejects an unknown tileType rather than persisting an invisible tile', async () => {
    const res = await put({ x: 0, y: 0, tileType: 'not-a-real-tile' });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Invalid grid tile payload');
    expect(tiles).toHaveLength(0);
  });

  it("rejects 'empty' — the absence of a tile is a DELETE, not a row claiming to be nothing", async () => {
    const res = await put({ x: 0, y: 0, tileType: 'empty' });

    expect(res.statusCode).toBe(400);
    expect(tiles).toHaveLength(0);
  });

  it('keeps accepting the legacy tile types already present in authored grids', async () => {
    for (const tileType of ['straight-v', 'curve-ne', 'curve-nw', 'curve-se', 'curve-sw']) {
      const res = await put({ x: 0, y: 0, tileType });
      expect(res.statusCode, tileType).toBe(200);
    }
  });

  it.each([
    ['a negative coordinate', { x: -1, y: 0, tileType: 'straight-h' }],
    ['a non-integer coordinate', { x: 1.5, y: 0, tileType: 'straight-h' }],
    ['an absurd coordinate', { x: 1_000_000, y: 0, tileType: 'straight-h' }],
    ['a string coordinate', { x: '3', y: 0, tileType: 'straight-h' }],
    ['a missing coordinate', { y: 0, tileType: 'straight-h' }],
  ])('rejects %s', async (_label, payload) => {
    const res = await put(payload);

    expect(res.statusCode).toBe(400);
    expect(tiles).toHaveLength(0);
  });

  // `.strict()`, matching every sibling write schema: `id` and `layoutId` are
  // path/server-owned, so a body carrying either is a 400 rather than a
  // silently ignored field.
  it('rejects a body carrying server-owned fields', async () => {
    const res = await put({ x: 0, y: 0, tileType: 'straight-h', layoutId: 'other-layout' });

    expect(res.statusCode).toBe(400);
    expect(tiles).toHaveLength(0);
  });
});

describe('PUT .../grid — metadata is a closed schema', () => {
  it('rejects an unknown metadata key rather than storing it verbatim', async () => {
    const res = await put({
      x: 0,
      y: 0,
      tileType: 'straight-h',
      metadata: { rotation: 0, decrative: true },
    });

    expect(res.statusCode).toBe(400);
    expect(tiles).toHaveLength(0);
  });

  it('rejects a rotation that is not one of the eight 45° steps the editor authors', async () => {
    const res = await put({ x: 0, y: 0, tileType: 'straight-h', metadata: { rotation: 37 } });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).details.fieldErrors.metadata[0]).toContain('Rotation must be one of');
  });

  it('rejects a rotation of 360 — the wrapped-around duplicate of 0', async () => {
    const res = await put({ x: 0, y: 0, tileType: 'straight-h', metadata: { rotation: 360 } });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a metadata blob that is not an object', async () => {
    const res = await put({ x: 0, y: 0, tileType: 'straight-h', metadata: 'rotation=90' });

    expect(res.statusCode).toBe(400);
  });
});

describe('PUT .../grid — referential integrity (GridService)', () => {
  it('rejects a blockId that is not a block in this layout', async () => {
    const res = await put({
      x: 0,
      y: 0,
      tileType: 'straight-h',
      metadata: { blockId: 'block-from-another-layout' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('block-from-another-layout');
    expect(tiles).toHaveLength(0);
  });

  it('rejects a pointId that is not a point in this layout', async () => {
    const res = await put({
      x: 0,
      y: 0,
      tileType: 'point-left',
      metadata: { pointId: 'ghost-point' },
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('ghost-point');
    expect(tiles).toHaveLength(0);
  });

  // D3 in docs/track-grid.md. A point tile's `metadata.blockId` says which
  // block's tint it draws in; `points.blockId` says which block the point sits
  // in. They are allowed to differ, and this test is what stops a later change
  // from quietly making them agree.
  it("accepts a point tile whose blockId differs from the point's own blockId", async () => {
    const res = await put({
      x: 0,
      y: 0,
      tileType: 'point-left',
      metadata: { blockId: BLOCK_ID, pointId: POINT_ID },
    });

    expect(res.statusCode).toBe(200);
  });

  it('answers 404 for a layout that does not exist, rather than writing an orphan row', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/layouts/no-such-layout/grid',
      payload: { x: 0, y: 0, tileType: 'straight-h' },
    });

    expect(res.statusCode).toBe(404);
    expect(tiles).toHaveLength(0);
  });
});

describe('DELETE .../grid/tile — coordinate query', () => {
  beforeEach(async () => {
    await put({ x: 2, y: 2, tileType: 'straight-h' });
  });

  it('deletes the tile at a valid coordinate', async () => {
    const res = await app.inject({ method: 'DELETE', url: `${GRID_URL}/tile?x=2&y=2` });

    expect(res.statusCode).toBe(204);
    expect(tiles).toHaveLength(0);
  });

  // `parseInt('abc')` is NaN, which matched no tile, so the route answered 204
  // — a successful-looking delete that deleted nothing.
  it.each(['?x=abc&y=2', '?x=&y=2', '?y=2', '?x=-1&y=2', '?x=2.5&y=2'])(
    'rejects the malformed coordinate query %s instead of reporting a phantom success',
    async (query) => {
      const res = await app.inject({ method: 'DELETE', url: `${GRID_URL}/tile${query}` });

      expect(res.statusCode).toBe(400);
      expect(tiles).toHaveLength(1);
    },
  );

  // Not an error: right-drag erase sweeps across cells that may hold no tile,
  // and 404-ing half a drag would make ordinary authoring a stream of errors.
  it('erasing an empty cell is a 204, not a 404', async () => {
    const res = await app.inject({ method: 'DELETE', url: `${GRID_URL}/tile?x=9&y=9` });

    expect(res.statusCode).toBe(204);
  });

  it('answers 404 for a layout that does not exist', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/layouts/no-such-layout/grid/tile?x=0&y=0',
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('grid writes remain admin-only, and a rejection never halts the layout', () => {
  it('an operator is refused every write', async () => {
    await authenticateAsOperator(app);

    const upsert = await put({ x: 0, y: 0, tileType: 'straight-h' });
    const eraseOne = await app.inject({ method: 'DELETE', url: `${GRID_URL}/tile?x=0&y=0` });
    const eraseAll = await app.inject({ method: 'DELETE', url: GRID_URL });

    expect([upsert.statusCode, eraseOne.statusCode, eraseAll.statusCode]).toEqual([403, 403, 403]);
  });

  it('an operator may still read the grid', async () => {
    await authenticateAsOperator(app);

    const res = await app.inject({ method: 'GET', url: GRID_URL });

    expect(res.statusCode).toBe(200);
  });

  // The rule this pins: config surfaces fail with 400, not Safe-Stop. A run
  // of malformed writes must leave the system exactly as online as it started.
  it('a burst of rejected writes leaves the system online', async () => {
    expect(service.getSystemStatus().status).toBe('online');

    await put({ x: 0, y: 0, tileType: 'not-a-real-tile' });
    await put({ x: -5, y: 0, tileType: 'straight-h' });
    await put({ x: 0, y: 0, tileType: 'straight-h', metadata: { blockId: 'ghost' } });
    await app.inject({ method: 'DELETE', url: `${GRID_URL}/tile?x=abc&y=abc` });

    expect(service.getSystemStatus().status).toBe('online');
    expect(service.getSystemStatus().safeStopReason ?? null).toBeNull();
  });
});
