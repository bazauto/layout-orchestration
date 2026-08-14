/**
 * Grid write-path and diagnostics integration tests.
 *
 * Was `blockEnds.test.ts` (#72). Everything it defended about a *stored* end
 * label — that a label an edge references is never renamed or deleted by
 * anything automatic — went with `block_ends` itself (#103 PR 7). There is no
 * stored label left to protect: a name is derived from the drawing on every
 * compile and referenced by nothing between compiles.
 *
 * What survives is what was never about that table, and is here rather than
 * scattered because it exercises the real HTTP write path against a real
 * repository fake:
 *
 * - the wave-2 tile metadata (#71 classification, #73 point roads, #74
 *   annotations) on the validated write path;
 * - the diagnostics surface — #84's buffer cross-check, #83's diamond blind
 *   spot, #91's `track-not-joined`, #74's duplicate annotation.
 *
 * Posture throughout: ordinary 4xx. Nothing in this file may Safe-Stop — these
 * are admin config surfaces.
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
import { BlockEdge } from '../../src/domain/types';
import {
  authenticateAsAdmin,
  makeTestAuthService,
  TEST_AUTH_CONFIG,
} from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const LAYOUT_ID = 'layout-1';
const BLOCK_A = 'block-a';
const BLOCK_B = 'block-b';
const POINT_ID = 'point-1';
const SENSOR_ID = 'sensor-1';

const GRID_URL = `/api/layouts/${LAYOUT_ID}/grid`;

let tiles: GridTileRecord[];
let edges: BlockEdge[];

function makeRepo(): ILayoutRepository {
  tiles = [];
  edges = [];
  let nextId = 1;

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
      layoutId === LAYOUT_ID
        ? [
            { id: BLOCK_A, layoutId: LAYOUT_ID, name: 'Down Platform' },
            { id: BLOCK_B, layoutId: LAYOUT_ID, name: 'Up Loop' },
          ]
        : [],
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
    listSensors: vi.fn(async (layoutId: string) =>
      layoutId === LAYOUT_ID
        ? [
            {
              id: SENSOR_ID,
              layoutId: LAYOUT_ID,
              name: 'Platform Beam',
              type: 'ir_position' as const,
              blockId: BLOCK_A,
              mqttTopic: 'layout/sensor/1/reading',
              inService: true,
            },
          ]
        : [],
    ),
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
      const created = { id: `tile-${nextId++}`, ...data };
      tiles.push(created);
      return created;
    }),
    deleteTile: vi.fn(async (id: string) => {
      tiles = tiles.filter((t) => t.id !== id);
    }),
    clearGrid: vi.fn(async (layoutId: string) => {
      tiles = tiles.filter((t) => t.layoutId !== layoutId);
    }),
    listBlockEdges: vi.fn(async (layoutId: string) => edges.filter((e) => e.layoutId === layoutId)),
    getBlockEdge: vi.fn(async (id: string) => edges.find((e) => e.id === id) ?? null),
    // Functional so a diagnostic that compares the drawing against the graph
    // has a graph to compare against — `buffer-contradicted-by-edge` is the
    // only one left that reads `block_edges`, and it is the reason this fake
    // stores edges rather than returning a fixed list.
    createBlockEdge: vi.fn(async (data: Omit<BlockEdge, 'id'>) => {
      const created = { id: `edge-${nextId++}`, ...data };
      edges.push(created);
      return created;
    }),
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
  const service = new LayoutService(dcc, mqtt, repo, state, reservations, silentLogger, undefined, nameBook);
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

const putTile = (payload: unknown) => app.inject({ method: 'PUT', url: GRID_URL, payload });

/** A three-tile block running west→east, ending in a buffer. */
async function drawSiding(blockId: string, y: number, bufferAtEnd = true) {
  await putTile({ x: 0, y, tileType: 'straight-h', metadata: { blockId } });
  await putTile({ x: 1, y, tileType: 'straight-h', metadata: { blockId } });
  await putTile({
    x: 2,
    y,
    tileType: bufferAtEnd ? 'buffer' : 'straight-h',
    metadata: { blockId },
  });
}

// ─── Tile metadata (#71, #73, #74) ─────────────────────────────────────────

describe('PUT .../grid — wave 2 metadata', () => {
  it('accepts a decorative tile and persists the classification', async () => {
    const res = await putTile({
      x: 5,
      y: 5,
      tileType: 'straight-h',
      metadata: { trackRole: 'decorative' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(JSON.parse(res.body).metadata)).toEqual({ trackRole: 'decorative' });
  });

  it('refuses a tile claiming to be both decorative and part of a block', async () => {
    // Contradictory assertions: the tile would classify differently depending
    // on which check ran first, so the write is refused rather than resolved.
    const res = await putTile({
      x: 5,
      y: 5,
      tileType: 'straight-h',
      metadata: { trackRole: 'decorative', blockId: BLOCK_A },
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('decorative');
  });

  it('accepts a leg-list point road mapping and resolves its point in this layout', async () => {
    const res = await putTile({
      x: 5,
      y: 5,
      tileType: 'point-left',
      metadata: {
        pointId: POINT_ID,
        pointRoads: [
          { when: [{ pointId: POINT_ID, position: 'normal' }], legs: ['w', 'e'] },
          { when: [{ pointId: POINT_ID, position: 'reverse' }], legs: ['w', 'n'] },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it('refuses a point road naming a point from another layout', async () => {
    const res = await putTile({
      x: 5,
      y: 5,
      tileType: 'point-left',
      metadata: {
        pointRoads: [{ when: [{ pointId: 'not-here' }], legs: ['w', 'e'] }],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('refuses two roads selected by the same point positions', async () => {
    // An ambiguous mapping: the renderer would have to pick one, and picking
    // silently is how a mimic ends up drawing the wrong road.
    const res = await putTile({
      x: 5,
      y: 5,
      tileType: 'point-left',
      metadata: {
        pointRoads: [
          { when: [{ pointId: POINT_ID, position: 'normal' }], legs: ['w', 'e'] },
          { when: [{ pointId: POINT_ID, position: 'normal' }], legs: ['w', 'n'] },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
  });

  it('accepts a sensor annotation and refuses one naming an unknown entity', async () => {
    const ok = await putTile({
      x: 5,
      y: 5,
      tileType: 'straight-h',
      metadata: { annotations: [{ entityType: 'sensor', entityId: SENSOR_ID }] },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await putTile({
      x: 6,
      y: 5,
      tileType: 'straight-h',
      metadata: { annotations: [{ entityType: 'sensor', entityId: 'nope' }] },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('refuses an annotation of an unknown entity type rather than storing an unresolvable id', async () => {
    const res = await putTile({
      x: 5,
      y: 5,
      tileType: 'straight-h',
      metadata: { annotations: [{ entityType: 'signal', entityId: 'sig-1' }] },
    });

    expect(res.statusCode).toBe(400);
  });

  it('keeps a burst of refused writes an ordinary 400 and the layout online', async () => {
    for (let i = 0; i < 5; i++) {
      await putTile({ x: i, y: 0, tileType: 'straight-h', metadata: { trackRole: 'nonsense' } });
    }
    expect(service.getSystemStatus().status).toBe('online');
  });
});

// ─── Block ends (#72) ───────────────────────────────────────────────────────

describe('GET .../grid/diagnostics', () => {
  const fetchDiagnostics = async () =>
    JSON.parse((await app.inject({ method: 'GET', url: `${GRID_URL}/diagnostics` })).body);

  it('flags an unclassified tile as a to-do, not an error', async () => {
    await putTile({ x: 0, y: 0, tileType: 'straight-h' });

    const found = (await fetchDiagnostics()).find(
      (d: { kind: string }) => d.kind === 'unclassified-tile',
    );
    expect(found).toMatchObject({ severity: 'info', at: { x: 0, y: 0 } });
  });

  it('does not flag a tile that is deliberately decorative', async () => {
    await putTile({ x: 0, y: 0, tileType: 'straight-h', metadata: { trackRole: 'decorative' } });

    expect(
      (await fetchDiagnostics()).some((d: { kind: string }) => d.kind === 'unclassified-tile'),
    ).toBe(false);
  });

  it('reports a buffered opening that an edge nonetheless leaves', async () => {
    // The one end-related diagnostic left (OQ3), and the one that still has two
    // representations to compare: the drawing, and the `block_edges` some
    // earlier compile wrote. No `/generate` step any more — the label the edge
    // names is the one `compileOpenings` derives from the drawing itself.
    await drawSiding(BLOCK_A, 0);
    edges.push({
      id: 'edge-1',
      layoutId: LAYOUT_ID,
      fromBlockId: BLOCK_A,
      fromEnd: 'east',
      toBlockId: BLOCK_B,
      toEnd: 'west',
      pointConditions: [],
    });

    const found = (await fetchDiagnostics()).find(
      (d: { kind: string }) => d.kind === 'buffer-contradicted-by-edge',
    );
    expect(found).toMatchObject({ severity: 'warning', blockId: BLOCK_A, label: 'east' });
  });

  it('warns that a drawn plain diamond is a known blind spot', async () => {
    await putTile({ x: 0, y: 0, tileType: 'crossing', metadata: { blockId: BLOCK_A } });

    const found = (await fetchDiagnostics()).find(
      (d: { kind: string }) => d.kind === 'diamond-blind-spot',
    );
    // #26: two routes fouling at a plain diamond are not detected. The editor
    // will let you draw one, so the editor is where it must be said.
    expect(found).toMatchObject({ severity: 'warning', at: { x: 0, y: 0 } });
  });

  it('warns when one sensor is placed on two tiles', async () => {
    const annotation = { annotations: [{ entityType: 'sensor', entityId: SENSOR_ID }] };
    await putTile({ x: 0, y: 0, tileType: 'straight-h', metadata: annotation });
    await putTile({ x: 5, y: 5, tileType: 'straight-h', metadata: annotation });

    const found = (await fetchDiagnostics()).find(
      (d: { kind: string }) => d.kind === 'duplicate-annotation',
    );
    // Surfaced, not refused on write: moving a sensor is a two-step edit, and
    // refusing the first step would make it impossible without deleting first.
    expect(found).toMatchObject({ entityId: SENSOR_ID, severity: 'warning' });
    expect(found.at).toHaveLength(2);
  });

  it('flags a point tile with no leg mapping', async () => {
    await putTile({ x: 0, y: 0, tileType: 'point-left', metadata: { pointId: POINT_ID } });

    const found = (await fetchDiagnostics()).find(
      (d: { kind: string }) => d.kind === 'point-tile-unmapped',
    );
    expect(found).toMatchObject({ pointId: POINT_ID, severity: 'info' });
  });

  it('does not demand a leg mapping from a point’s companion tile', async () => {
    // #92. A point is drawn as two tiles: the point tile, and a `straight-45`
    // carrying the divergent road across to the adjacent row. Both are tagged
    // with the same point. Only the first has legs — `defaultPointRoads`
    // returns nothing for the companion and the editor hides the control — so
    // demanding a mapping asked for something no operator could give.
    await putTile({ x: 0, y: 0, tileType: 'straight-45', metadata: { pointId: POINT_ID } });

    expect(
      (await fetchDiagnostics()).some((d: { kind: string }) => d.kind === 'point-tile-unmapped'),
    ).toBe(false);
  });

  it('gives two sidings drawn on adjacent rows two openings each (#91)', async () => {
    // The shape #91 is about, through the real write path and repository: two
    // yard roads touch along their whole length and connect nowhere.
    //
    // This was asserted through `POST .../block-ends/generate` until #103 PR 7.
    // The surface changed and the property did not, so it moved to
    // `GET .../grid/openings` rather than going with the route — before the
    // fix each block got a *single* opening named for the row above or below
    // it, sitting in the middle of its own siding.
    await drawSiding(BLOCK_A, 0);
    await drawSiding(BLOCK_B, 1);

    const res = await app.inject({ method: 'GET', url: `${GRID_URL}/openings` });
    expect(res.statusCode).toBe(200);

    const openings = JSON.parse(res.body) as Array<{ blockId: string; label: string }>;
    const labelsOf = (blockId: string) =>
      openings
        .filter((o) => o.blockId === blockId)
        .map((o) => o.label)
        .sort();

    expect(labelsOf(BLOCK_A)).toEqual(['east', 'west']);
    expect(labelsOf(BLOCK_B)).toEqual(['east', 'west']);
  });

  it('warns when drawn track runs into a tile that does not meet it (#91)', async () => {
    // Horizontal track butted against a tile drawn vertically. It looks
    // continuous and is not, and the block silently ends at that edge — so the
    // end it produces needs an explanation on the same screen.
    await putTile({ x: 0, y: 0, tileType: 'straight-h', metadata: { blockId: BLOCK_A } });
    await putTile({
      x: 1,
      y: 0,
      tileType: 'straight-h',
      metadata: { blockId: BLOCK_B, rotation: 90 },
    });

    const found = (await fetchDiagnostics()).find(
      (d: { kind: string }) => d.kind === 'track-not-joined',
    );
    expect(found).toMatchObject({
      severity: 'warning',
      at: { x: 0, y: 0 },
      edge: 'e',
      against: { x: 1, y: 0 },
    });
  });

  it('says nothing about track that is properly joined (#91)', async () => {
    // The false-positive guard, and the reason this is safe to turn on for a
    // layout that is already drawn: two ordinary sidings produce none.
    await drawSiding(BLOCK_A, 0);
    await drawSiding(BLOCK_B, 1);

    expect(
      (await fetchDiagnostics()).some((d: { kind: string }) => d.kind === 'track-not-joined'),
    ).toBe(false);
  });

  it('never Safe-Stops, however much it finds', async () => {
    await putTile({ x: 0, y: 0, tileType: 'crossing' });
    await fetchDiagnostics();
    expect(service.getSystemStatus().status).toBe('online');
  });
});
