/**
 * Block end integration tests (#72, see docs/topology.md).
 *
 * The invariant nearly every test here defends is the same one:
 * **a label an edge already references is never renamed and never deleted by
 * anything automatic.** `block_edges.fromEnd`/`toEnd` are free text and are
 * the only link between an edge and a block end, so a rename is a change to
 * the track graph disguised as a naming tidy-up — and the pathfinder plans on
 * that graph.
 *
 * Also covered: the wave-2 tile metadata (#71 classification, #73 point roads,
 * #74 annotations) on the validated write path, and the diagnostics surface
 * (#84's buffer cross-check, #83's diamond blind spot).
 *
 * Posture throughout: ordinary 4xx. Nothing in this file may Safe-Stop — these
 * are admin config surfaces, and an end label is a name.
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
import { BlockEdge, BlockEnd } from '../../src/domain/types';
import {
  authenticateAsAdmin,
  authenticateAsOperator,
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
const ENDS_URL = `/api/layouts/${LAYOUT_ID}/block-ends`;

let tiles: GridTileRecord[];
let ends: BlockEnd[];
let edges: BlockEdge[];

function makeRepo(): ILayoutRepository {
  tiles = [];
  ends = [];
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
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),
    listBlockEnds: vi.fn(async (layoutId: string) => ends.filter((e) => e.layoutId === layoutId)),
    getBlockEnd: vi.fn(async (id: string) => ends.find((e) => e.id === id) ?? null),
    createBlockEnd: vi.fn(async (data: Omit<BlockEnd, 'id'>) => {
      const created = { id: `end-${nextId++}`, ...data };
      ends.push(created);
      return created;
    }),
    updateBlockEnd: vi.fn(async (id: string, data: { label?: string; pinned?: boolean }) => {
      const end = ends.find((e) => e.id === id)!;
      Object.assign(end, data);
      return end;
    }),
    deleteBlockEnd: vi.fn(async (id: string) => {
      ends = ends.filter((e) => e.id !== id);
    }),
    replaceGeneratedBlockEnds: vi.fn(
      async (layoutId: string, blockId: string, labels: readonly string[]) => {
        const pinned = new Set(
          ends.filter((e) => e.blockId === blockId && e.pinned).map((e) => e.label),
        );
        ends = ends.filter((e) => e.blockId !== blockId || e.pinned);
        for (const label of new Set(labels)) {
          if (pinned.has(label)) continue;
          ends.push({ id: `end-${nextId++}`, layoutId, blockId, label, pinned: false });
        }
      },
    ),
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

describe('POST .../block-ends/generate', () => {
  it('generates cardinal labels from the drawing', async () => {
    await drawSiding(BLOCK_A, 0);

    const res = await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` });
    expect(res.statusCode).toBe(200);

    const listed = JSON.parse((await app.inject({ method: 'GET', url: ENDS_URL })).body);
    expect(listed.map((e: BlockEnd) => e.label).sort()).toEqual(['east', 'west']);
    expect(listed.every((e: BlockEnd) => e.pinned === false)).toBe(true);
  });

  it('pins every label an existing edge already references, and never renames one', async () => {
    // The adoption pass. Westgate Hollow's edges were authored long before any
    // of this existed; the first generate must protect them rather than
    // clobber them with whatever the geometry happens to say.
    edges.push({
      id: 'edge-1',
      layoutId: LAYOUT_ID,
      fromBlockId: BLOCK_A,
      fromEnd: 'yard-3',
      toBlockId: BLOCK_B,
      toEnd: 'south',
      pointConditions: [],
      lengthMm: null,
    });
    await drawSiding(BLOCK_A, 0);

    const res = await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` });
    const summary = JSON.parse(res.body);

    expect(summary.adopted).toEqual(
      expect.arrayContaining([
        { blockId: BLOCK_A, label: 'yard-3' },
        { blockId: BLOCK_B, label: 'south' },
      ]),
    );

    const listed: BlockEnd[] = JSON.parse((await app.inject({ method: 'GET', url: ENDS_URL })).body);
    const adopted = listed.find((e) => e.label === 'yard-3')!;
    expect(adopted.pinned).toBe(true);
    // The generated labels sit alongside it; the authored one is untouched.
    expect(listed.filter((e) => e.blockId === BLOCK_A).map((e) => e.label).sort()).toEqual([
      'east',
      'west',
      'yard-3',
    ]);
  });

  it('is idempotent — running it twice changes nothing', async () => {
    await drawSiding(BLOCK_A, 0);
    await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` });
    const first = JSON.parse((await app.inject({ method: 'GET', url: ENDS_URL })).body);

    const second = JSON.parse(
      (await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` })).body,
    );

    expect(second.created).toEqual([]);
    expect(second.removed).toEqual([]);
    const after = JSON.parse((await app.inject({ method: 'GET', url: ENDS_URL })).body);
    expect(after.map((e: BlockEnd) => e.label).sort()).toEqual(
      first.map((e: BlockEnd) => e.label).sort(),
    );
  });

  it('leaves a pinned label alone when the drawing changes underneath it', async () => {
    await drawSiding(BLOCK_A, 0);
    await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` });

    const listed: BlockEnd[] = JSON.parse((await app.inject({ method: 'GET', url: ENDS_URL })).body);
    const west = listed.find((e) => e.label === 'west')!;
    // Renaming to the same label is how an operator says "stop regenerating
    // this one".
    await app.inject({ method: 'PUT', url: `${ENDS_URL}/${west.id}`, payload: { label: 'west' } });

    await app.inject({ method: 'DELETE', url: `${GRID_URL}/tile?x=0&y=0` });
    await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` });

    const after: BlockEnd[] = JSON.parse((await app.inject({ method: 'GET', url: ENDS_URL })).body);
    expect(after.find((e) => e.label === 'west')?.pinned).toBe(true);
  });

  it('reports a collision instead of suffixing a duplicate label', async () => {
    // One block drawn as two parallel roads: both open west, from two places.
    await drawSiding(BLOCK_A, 0);
    await drawSiding(BLOCK_A, 4);

    const summary = JSON.parse(
      (await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` })).body,
    );

    expect(summary.collisions.map((c: { label: string }) => c.label).sort()).toEqual([
      'east',
      'west',
    ]);
    const listed = JSON.parse((await app.inject({ method: 'GET', url: ENDS_URL })).body);
    expect(listed).toEqual([]);
  });

  it('requires admin — an operator may read ends but not regenerate them', async () => {
    await authenticateAsOperator(app);
    expect((await app.inject({ method: 'GET', url: ENDS_URL })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` })).statusCode).toBe(403);
  });
});

describe('block end rename and delete', () => {
  async function seedEnd(label = 'west'): Promise<BlockEnd> {
    const res = await app.inject({
      method: 'POST',
      url: ENDS_URL,
      payload: { blockId: BLOCK_A, label },
    });
    return JSON.parse(res.body);
  }

  it('creates a hand-authored end pinned, and normalises the label', async () => {
    const res = await app.inject({
      method: 'POST',
      url: ENDS_URL,
      payload: { blockId: BLOCK_A, label: '  YARD-3 ' },
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({ label: 'yard-3', pinned: true });
  });

  it('refuses a rename of a label an edge references, and names the edges', async () => {
    const end = await seedEnd('yard-3');
    edges.push({
      id: 'edge-1',
      layoutId: LAYOUT_ID,
      fromBlockId: BLOCK_A,
      fromEnd: 'yard-3',
      toBlockId: BLOCK_B,
      toEnd: 'south',
      pointConditions: [],
      lengthMm: null,
    });

    const res = await app.inject({
      method: 'PUT',
      url: `${ENDS_URL}/${end.id}`,
      payload: { label: 'north' },
    });

    // Not a cascade: rewriting the edges to follow the rename would be a
    // change to the track graph made as a side effect of naming something.
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).edgeIds).toEqual(['edge-1']);
    expect(ends.find((e) => e.id === end.id)!.label).toBe('yard-3');
  });

  it('refuses a delete of a label an edge references', async () => {
    const end = await seedEnd('yard-3');
    edges.push({
      id: 'edge-1',
      layoutId: LAYOUT_ID,
      fromBlockId: BLOCK_B,
      fromEnd: 'south',
      toBlockId: BLOCK_A,
      toEnd: 'yard-3',
      pointConditions: [],
      lengthMm: null,
    });

    const res = await app.inject({ method: 'DELETE', url: `${ENDS_URL}/${end.id}` });
    expect(res.statusCode).toBe(409);
    expect(ends).toHaveLength(1);
  });

  it('refuses a rename onto a label the block already carries', async () => {
    await seedEnd('west');
    const other = await seedEnd('east');

    const res = await app.inject({
      method: 'PUT',
      url: `${ENDS_URL}/${other.id}`,
      payload: { label: 'west' },
    });

    // Merging two ends into one is a topology change; say so explicitly by
    // deleting one rather than having a rename do it quietly.
    expect(res.statusCode).toBe(409);
  });

  it('404s for an end id belonging to another layout, not 200', async () => {
    ends.push({ id: 'foreign', layoutId: 'other', blockId: BLOCK_A, label: 'north', pinned: true });
    const res = await app.inject({
      method: 'PUT',
      url: `${ENDS_URL}/foreign`,
      payload: { label: 'south' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('400s for a blockId that is not in this layout', async () => {
    const res = await app.inject({
      method: 'POST',
      url: ENDS_URL,
      payload: { blockId: 'block-elsewhere', label: 'north' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── Diagnostics (#71, #73, #74, #83, #84) ─────────────────────────────────

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

  it('reports a buffered end that an edge nonetheless leaves', async () => {
    await drawSiding(BLOCK_A, 0);
    await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` });
    edges.push({
      id: 'edge-1',
      layoutId: LAYOUT_ID,
      fromBlockId: BLOCK_A,
      fromEnd: 'east',
      toBlockId: BLOCK_B,
      toEnd: 'west',
      pointConditions: [],
      lengthMm: null,
    });

    const found = (await fetchDiagnostics()).find(
      (d: { kind: string }) => d.kind === 'buffer-contradicted-by-edge',
    );
    expect(found).toMatchObject({ severity: 'warning', blockId: BLOCK_A, label: 'east' });
  });

  it('reports an unfinished end — no edges and no buffer — as a to-do', async () => {
    await drawSiding(BLOCK_A, 0, false);
    await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` });

    const found = (await fetchDiagnostics()).filter(
      (d: { kind: string }) => d.kind === 'end-unfinished',
    );
    // Both ends are unauthored, and neither is a deliberate dead end — the
    // ambiguity #84 exists to resolve, now resolved in the honest direction.
    expect(found.map((d: { label: string }) => d.label).sort()).toEqual(['east', 'west']);
    expect(found.every((d: { severity: string }) => d.severity === 'info')).toBe(true);
  });

  it('does not report an end as unfinished once a buffer terminates it', async () => {
    await drawSiding(BLOCK_A, 0);
    await app.inject({ method: 'POST', url: `${ENDS_URL}/generate` });

    const unfinished = (await fetchDiagnostics()).filter(
      (d: { kind: string }) => d.kind === 'end-unfinished',
    );
    expect(unfinished.map((d: { label: string }) => d.label)).toEqual(['west']);
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

  it('flags a drawn block that no in-service sensor reports on', async () => {
    await drawSiding(BLOCK_B, 0);

    const found = (await fetchDiagnostics()).find(
      (d: { kind: string }) => d.kind === 'block-without-detection',
    );
    expect(found).toMatchObject({ blockId: BLOCK_B, severity: 'info' });
  });

  it('never Safe-Stops, however much it finds', async () => {
    await putTile({ x: 0, y: 0, tileType: 'crossing' });
    await fetchDiagnostics();
    expect(service.getSystemStatus().status).toBe('online');
  });
});
