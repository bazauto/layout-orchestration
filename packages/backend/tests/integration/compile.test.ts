/**
 * Compile integration tests (#103, `docs/track-graph-compilation.md`).
 *
 * Two read-only surfaces: `GET .../topology/compile`, which walks the drawing
 * and diffs the graph it implies against the live one, and
 * `GET .../grid/openings`, which answers the cheaper question of where each
 * block opens.
 *
 * The posture every test here defends is that **nothing on this path can move
 * or halt anything**. It reads a drawing. A layout that does not exist is a
 * 404, a drawing that compiles to nothing but gaps is a 200 with gaps in it,
 * and `getSystemStatus().status` is `online` before and after either way — an
 * authoring surface that can Safe-Stop the layout is a worse bug than anything
 * it could report (D9).
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
import {
  CompiledGraphRecord,
  GridTileRecord,
  ILayoutRepository,
} from '../../src/ports/ILayoutRepository';
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
const BLOCK_A = 'block-a';
const BLOCK_B = 'block-b';
const POINT_ID = 'point-1';

const GRID_URL = `/api/layouts/${LAYOUT_ID}/grid`;
const COMPILE_URL = `/api/layouts/${LAYOUT_ID}/topology/compile`;
const OPENINGS_URL = `/api/layouts/${LAYOUT_ID}/grid/openings`;

let tiles: GridTileRecord[];
let edges: BlockEdge[];
/** Set by a test that wants a previously-compiled layout; `null` is "never compiled". */
let compiled: CompiledGraphRecord | null;
/** Which blocks have an in-service sensor, so `block-without-detection` can be exercised. */
let detectedBlocks: string[];
/**
 * Forces the route-lock view to report a hold, so the apply's 409 can be
 * exercised without granting a real route.
 *
 * The genuine article — a granted reservation actually blocking an apply — is
 * `tests/scenario/compile-apply.scenario.test.ts`. This one is about the HTTP
 * mapping.
 */
let heldRouteId: string | null;

function makeRepo(): ILayoutRepository {
  tiles = [];
  edges = [];
  compiled = null;
  detectedBlocks = [BLOCK_A, BLOCK_B];
  heldRouteId = null;
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
            { id: BLOCK_A, layoutId: LAYOUT_ID, name: 'Down Platform', lengthMm: null },
            { id: BLOCK_B, layoutId: LAYOUT_ID, name: 'Up Loop', lengthMm: null },
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
        ? detectedBlocks.map((blockId, i) => ({
            id: `sensor-${i}`,
            layoutId: LAYOUT_ID,
            name: `Detector ${i}`,
            type: 'block_detection' as const,
            blockId,
            mqttTopic: `layout/sensor/${i}/reading`,
            inService: true,
          }))
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
    createBlockEdge: vi.fn(async (data: Omit<BlockEdge, 'id'>) => {
      const created = { id: `edge-${nextId++}`, ...data };
      edges.push(created);
      return created;
    }),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),
    listBlockEnds: vi.fn().mockResolvedValue([]),
    getBlockEnd: vi.fn().mockResolvedValue(null),
    createBlockEnd: vi.fn(),
    updateBlockEnd: vi.fn(),
    deleteBlockEnd: vi.fn(),
    replaceGeneratedBlockEnds: vi.fn(),
    getCompiledGraph: vi.fn(async () => compiled),
    // Functional, so the apply path can be exercised end to end and the
    // idempotence claim (re-compile after apply shows an empty diff) is a real
    // assertion rather than a restatement of the mock.
    replaceBlockEdges: vi.fn(
      async (
        layoutId: string,
        candidates: readonly Omit<BlockEdge, 'id' | 'layoutId'>[],
        fingerprint: string,
        compiledAt: Date,
      ) => {
        edges = edges.filter((e) => e.layoutId !== layoutId);
        for (const c of candidates) edges.push({ id: `edge-${nextId++}`, layoutId, ...c });
        compiled = { layoutId, drawingFingerprint: fingerprint, compiledAt };
        return edges.filter((e) => e.layoutId === layoutId);
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
  const lockView: IRouteLockView = {
    findRouteHoldingBlock: (l, b) => reservations.findRouteHoldingBlock(l, b),
    findRouteHoldingPoint: (l, p) => reservations.findRouteHoldingPoint(l, p),
    findRouteHoldingEdge: (l, e) => reservations.findRouteHoldingEdge(l, e),
    findAnyHeldRoute: (l) => heldRouteId ?? reservations.findAnyHeldRoute(l),
  };
  const topologyService = new TopologyService(
    repo,
    () => Promise.resolve(),
    silentLogger,
    lockView,
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
  return { app, service };
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

/**
 * Two blocks meeting end to end, each buffered at its outer end:
 *
 * ```
 *  ]==A==  ==B==[
 *   0  1    2  3
 * ```
 *
 * The buffer at (0,0) is rotated 180 so its stub faces east, into the block;
 * the one at (3,0) faces west by default. Every opening is therefore either
 * edged or terminated, which is what makes this a zero-gap drawing.
 */
async function drawTwoBlocks() {
  await putTile({ x: 0, y: 0, tileType: 'buffer', metadata: { blockId: BLOCK_A, rotation: 180 } });
  await putTile({ x: 1, y: 0, tileType: 'straight-h', metadata: { blockId: BLOCK_A } });
  await putTile({ x: 2, y: 0, tileType: 'straight-h', metadata: { blockId: BLOCK_B } });
  await putTile({ x: 3, y: 0, tileType: 'buffer', metadata: { blockId: BLOCK_B } });
}

const compileView = async () => {
  const res = await app.inject({ method: 'GET', url: COMPILE_URL });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body);
};

// ─── GET .../topology/compile ────────────────────────────────────────────────

describe('GET .../topology/compile', () => {
  it('reports an unauthored graph as entirely added, from a drawing with no gaps', async () => {
    // Westgate Hollow's actual state: the drawing is finished and `block_edges`
    // is empty, so there is no window in which the pathfinder plans on a
    // half-migrated graph — it already plans on nothing.
    await drawTwoBlocks();

    const view = await compileView();

    expect(view.report.edges).toHaveLength(2);
    expect(view.report.gaps).toEqual([]);
    expect(view.report.components).toHaveLength(1);
    expect(view.diff.added).toHaveLength(2);
    expect(view.diff.removed).toEqual([]);
    expect(view.diff.unchanged).toEqual([]);
    expect(view.diff.changed).toEqual([]);
    expect(view.diff.relabelled).toEqual([]);
  });

  it('emits both directions of the connection, each naming the other block', async () => {
    await drawTwoBlocks();

    const view = await compileView();
    const pairs = view.report.edges
      .map((e: { fromBlockId: string; toBlockId: string }) => `${e.fromBlockId}->${e.toBlockId}`)
      .sort();

    expect(pairs).toEqual([`${BLOCK_A}->${BLOCK_B}`, `${BLOCK_B}->${BLOCK_A}`]);
    // Never `null`: an unnameable opening is the unreferenceable end #103 exists
    // to abolish, and `compileOpenings` names every one of them (D-I).
    for (const edge of view.report.edges) {
      expect(typeof edge.fromEnd).toBe('string');
      expect(typeof edge.toEnd).toBe('string');
    }
  });

  it('reports a never-compiled layout as stale, with no compiled fingerprint', async () => {
    await drawTwoBlocks();

    const view = await compileView();

    expect(view.status.compiledAt).toBeNull();
    expect(view.status.compiledFingerprint).toBeNull();
    expect(view.status.drawingFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // "Never compiled" is behind the drawing by definition.
    expect(view.status.stale).toBe(true);
    expect(view.status.gapCount).toBe(0);
  });

  it('is not stale when the stored fingerprint matches the drawing, and goes stale on the next edit', async () => {
    await drawTwoBlocks();
    const first = await compileView();

    compiled = {
      layoutId: LAYOUT_ID,
      drawingFingerprint: first.status.drawingFingerprint,
      compiledAt: new Date('2026-08-13T10:00:00.000Z'),
    };

    const matched = await compileView();
    expect(matched.status.stale).toBe(false);
    expect(matched.status.compiledAt).toBe('2026-08-13T10:00:00.000Z');

    // One more tile, and the graph is behind the drawing. A warning, never a
    // gate: gating on this would stop an operator moving a platform tile.
    await putTile({ x: 6, y: 6, tileType: 'straight-h', metadata: { trackRole: 'decorative' } });

    const after = await compileView();
    expect(after.status.drawingFingerprint).not.toBe(first.status.drawingFingerprint);
    expect(after.status.stale).toBe(true);
  });

  it('does not stale the graph when a sensor annotation moves', async () => {
    // `annotations` are excluded from the fingerprint on purpose (D-G): the walk
    // never reads one, so placing a sensor marker must not invalidate a review
    // an operator is part-way through.
    await drawTwoBlocks();
    const before = await compileView();

    await putTile({
      x: 1,
      y: 0,
      tileType: 'straight-h',
      metadata: { blockId: BLOCK_A, annotations: [] },
    });

    const after = await compileView();
    expect(after.status.drawingFingerprint).toBe(before.status.drawingFingerprint);
  });

  it('reports an already-authored edge as unchanged rather than added', async () => {
    await drawTwoBlocks();
    const view = await compileView();
    const first = view.diff.added[0];

    edges.push({
      id: 'edge-live',
      layoutId: LAYOUT_ID,
      fromBlockId: first.fromBlockId,
      fromEnd: first.fromEnd,
      toBlockId: first.toBlockId,
      toEnd: first.toEnd,
      pointConditions: first.pointConditions,
    });

    const after = await compileView();
    expect(after.diff.unchanged.map((e: BlockEdge) => e.id)).toEqual(['edge-live']);
    expect(after.diff.added).toHaveLength(1);
  });

  it('names a block with no in-service detection as a gap', async () => {
    // Load-bearing rather than tidy (D7/D9): the argument that a mis-mapped
    // point is caught on first movement depends entirely on the train's wrong
    // block being *detected*.
    await drawTwoBlocks();
    detectedBlocks = [BLOCK_A];

    const view = await compileView();

    expect(view.report.gaps).toContainEqual({
      kind: 'block-without-detection',
      blockId: BLOCK_B,
    });
    expect(view.status.gapCount).toBeGreaterThan(0);
  });

  it('names an unreadable tile as its own gap, not as an empty cell', async () => {
    // `parseTileMetadata` degrades a corrupt blob to `{}` rather than throwing,
    // which makes corruption look exactly like a to-do. Both block the walk, so
    // both fail safe — but only one of them can be finished by drawing (D9).
    await drawTwoBlocks();
    tiles.push({
      id: 'tile-corrupt',
      layoutId: LAYOUT_ID,
      x: 9,
      y: 9,
      tileType: 'straight-h',
      metadata: '{not json',
    });

    const view = await compileView();

    expect(view.report.gaps).toContainEqual({
      kind: 'tile-metadata-unreadable',
      at: { x: 9, y: 9 },
    });
  });

  it('returns 404 for a layout that does not exist, never a 500', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/layouts/nope/topology/compile',
    });

    expect(res.statusCode).toBe(404);
  });

  it('is readable by an operator: the write is what is gated, not the review', async () => {
    await drawTwoBlocks();
    await authenticateAsOperator(app);

    const res = await app.inject({ method: 'GET', url: COMPILE_URL });

    expect(res.statusCode).toBe(200);
  });

  it('never Safe-Stops, however much it finds', async () => {
    // A drawing full of holes: unclassified track, a tile naming a deleted
    // block, and a corrupt blob. Every one of them is a gap; none of them is a
    // reason to halt a railway.
    expect(service.getSystemStatus().status).toBe('online');

    await putTile({ x: 0, y: 0, tileType: 'straight-h', metadata: {} });
    await putTile({ x: 1, y: 0, tileType: 'straight-h', metadata: { blockId: BLOCK_A } });
    tiles.push({
      id: 'tile-ghost',
      layoutId: LAYOUT_ID,
      x: 2,
      y: 0,
      tileType: 'straight-h',
      metadata: JSON.stringify({ blockId: 'deleted-block' }),
    });
    tiles.push({
      id: 'tile-corrupt',
      layoutId: LAYOUT_ID,
      x: 3,
      y: 0,
      tileType: 'straight-h',
      metadata: 'not json at all',
    });

    const view = await compileView();

    expect(view.report.gaps.length).toBeGreaterThan(0);
    expect(view.report.gaps.map((g: { kind: string }) => g.kind)).toContain(
      'dangling-block-reference',
    );
    // The point of the case: a tile naming a deleted block yields no edge that
    // names it, so it can never become the `unknown-block` violation that
    // Safe-Stops the layout on the next reload.
    for (const edge of view.report.edges) {
      expect(edge.fromBlockId).not.toBe('deleted-block');
      expect(edge.toBlockId).not.toBe('deleted-block');
    }
    expect(service.getSystemStatus().status).toBe('online');
  });
});

// ─── POST .../topology/compile/apply ─────────────────────────────────────────

const APPLY_URL = `${COMPILE_URL}/apply`;

const apply = (fingerprint: unknown) =>
  app.inject({ method: 'POST', url: APPLY_URL, payload: { fingerprint } });

describe('POST .../topology/compile/apply', () => {
  it('writes the compiled graph, and the next compile is provably a no-op', async () => {
    // D10's idempotence, asserted rather than argued: same drawing, same
    // output, so re-compiling after an apply must show nothing to do.
    await drawTwoBlocks();
    const before = await compileView();

    const res = await apply(before.status.drawingFingerprint);
    expect(res.statusCode).toBe(200);

    const after = JSON.parse(res.body);
    expect(after.diff.added).toEqual([]);
    expect(after.diff.removed).toEqual([]);
    expect(after.diff.unchanged).toHaveLength(2);
    expect(after.status.stale).toBe(false);
    expect(after.status.compiledAt).not.toBeNull();

    const stored = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/edges` });
    expect(JSON.parse(stored.body)).toHaveLength(2);
  });

  it('is a no-op 200 when applied twice, not an error', async () => {
    await drawTwoBlocks();
    const { status } = await compileView();

    expect((await apply(status.drawingFingerprint)).statusCode).toBe(200);
    const second = await apply(status.drawingFingerprint);

    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).diff.added).toEqual([]);
    expect(edges).toHaveLength(2);
  });

  it('replaces a hand-authored edge the compile does not reproduce', async () => {
    // A recompile is a replace, not a merge (D3). A mixed graph would
    // reintroduce the two-representations problem at a new seam — an authored
    // edge nothing ever checks against the picture, forever.
    await drawTwoBlocks();
    edges.push({
      id: 'edge-by-hand',
      layoutId: LAYOUT_ID,
      fromBlockId: BLOCK_A,
      fromEnd: 'invented',
      toBlockId: BLOCK_B,
      toEnd: 'fictional',
      pointConditions: [],
    });

    const { status } = await compileView();
    expect((await apply(status.drawingFingerprint)).statusCode).toBe(200);

    expect(edges.map((e) => e.id)).not.toContain('edge-by-hand');
    expect(edges).toHaveLength(2);
  });

  it('refuses with 409 when the drawing moved between the review and the apply, writing nothing', async () => {
    // The time-of-check/time-of-use guard, and the reason no draft table is
    // needed: you cannot review one graph and apply another.
    await drawTwoBlocks();
    const { status } = await compileView();

    await putTile({ x: 7, y: 7, tileType: 'straight-h', metadata: { trackRole: 'decorative' } });

    const res = await apply(status.drawingFingerprint);

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.expected).toBe(status.drawingFingerprint);
    expect(body.actual).not.toBe(status.drawingFingerprint);
    expect(edges).toEqual([]);
  });

  it('refuses with 409 while a route holds the layout, writing nothing', async () => {
    // Not a per-edge guard (D-E): every row is about to be rewritten with
    // regenerated labels, so nothing may be holding a stale one.
    await drawTwoBlocks();
    const { status } = await compileView();
    heldRouteId = 'route-42';

    const res = await apply(status.drawingFingerprint);

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).routeId).toBe('route-42');
    expect(edges).toEqual([]);
  });

  it('refuses with 422 and names the violations when the drawing compiles to a graph the validator rejects', async () => {
    // OQ7's latent case, drawn: a point tile tinted as the block it serves and
    // reached through its toe. Every road covers the toe, so the arrival rule
    // correctly emits one edge per road — two rows differing only in point
    // conditions, which collide on `block_edges_connection_unq` because that
    // index excludes them.
    //
    // The point of this test is that it is a **named 422 before any write**,
    // not an opaque 500 from SQLite half way through a batch. That falls out of
    // validating the whole candidate set first; no special case was needed.
    await putTile({ x: 0, y: 0, tileType: 'straight-h', metadata: { blockId: BLOCK_A } });
    await putTile({
      x: 1,
      y: 0,
      tileType: 'point-left',
      metadata: {
        blockId: BLOCK_B,
        pointId: POINT_ID,
        pointRoads: [
          { when: [{ pointId: POINT_ID, position: 'normal' }], legs: ['w', 'e'] },
          { when: [{ pointId: POINT_ID, position: 'reverse' }], legs: ['w', 'n'] },
        ],
      },
    });

    const { report, status } = await compileView();
    const tuples = report.edges.map(
      (e: { fromBlockId: string; fromEnd: string; toBlockId: string; toEnd: string }) =>
        `${e.fromBlockId}|${e.fromEnd}|${e.toBlockId}|${e.toEnd}`,
    );
    // Guard the fixture itself: if the drawing stops producing the collision,
    // this test would pass for the wrong reason.
    expect(new Set(tuples).size).toBeLessThan(tuples.length);

    const res = await apply(status.drawingFingerprint);

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).violations.map((v: { kind: string }) => v.kind)).toContain(
      'duplicate-connection',
    );
    expect(edges).toEqual([]);
  });

  it('refuses a body carrying edges, rather than silently ignoring them', async () => {
    // `.strict()`, and it matters more here than anywhere else in the codebase:
    // a body that could carry rows would be a second authoring path wearing the
    // compiler's name.
    await drawTwoBlocks();
    const { status } = await compileView();

    const res = await app.inject({
      method: 'POST',
      url: APPLY_URL,
      payload: {
        fingerprint: status.drawingFingerprint,
        edges: [{ fromBlockId: BLOCK_A, fromEnd: 'east', toBlockId: BLOCK_B, toEnd: 'west' }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(edges).toEqual([]);
  });

  it('refuses an empty or missing fingerprint', async () => {
    await drawTwoBlocks();

    expect((await apply('')).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: APPLY_URL, payload: {} })).statusCode).toBe(400);
  });

  it('is admin-only: an operator gets 403 and nothing is written', async () => {
    await drawTwoBlocks();
    const { status } = await compileView();
    await authenticateAsOperator(app);

    const res = await apply(status.drawingFingerprint);

    expect(res.statusCode).toBe(403);
    expect(edges).toEqual([]);
  });

  it('returns 404 for a layout that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/layouts/nope/topology/compile/apply',
      payload: { fingerprint: 'anything' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('never Safe-Stops — not on success, not on a 409, not on a 422', async () => {
    // The point of D9. An apply is an authoring action, and an authoring action
    // that can halt a running railway is a worse bug than anything it prevents.
    await drawTwoBlocks();
    const { status } = await compileView();
    expect(service.getSystemStatus().status).toBe('online');

    expect((await apply(status.drawingFingerprint)).statusCode).toBe(200);
    expect(service.getSystemStatus().status).toBe('online');

    expect((await apply('a-fingerprint-from-some-other-drawing')).statusCode).toBe(409);
    expect(service.getSystemStatus().status).toBe('online');

    heldRouteId = 'route-1';
    expect((await apply(status.drawingFingerprint)).statusCode).toBe(409);
    expect(service.getSystemStatus().status).toBe('online');
  });
});

// ─── GET .../grid/openings ───────────────────────────────────────────────────

describe('GET .../grid/openings', () => {
  it('names every opening of every drawn block', async () => {
    await drawTwoBlocks();

    const res = await app.inject({ method: 'GET', url: OPENINGS_URL });
    expect(res.statusCode).toBe(200);

    const openings = JSON.parse(res.body) as Array<{
      blockId: string;
      label: string;
      terminated: boolean;
    }>;

    expect(openings.length).toBeGreaterThan(0);
    expect(new Set(openings.map((o) => o.blockId))).toEqual(new Set([BLOCK_A, BLOCK_B]));
    for (const opening of openings) {
      expect(opening.label).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    }
    // Each block is buffered at its outer end.
    expect(openings.filter((o) => o.terminated).length).toBeGreaterThan(0);
  });

  it('omits an opening of a block that no longer exists', async () => {
    await drawTwoBlocks();
    tiles.push({
      id: 'tile-ghost',
      layoutId: LAYOUT_ID,
      x: 8,
      y: 8,
      tileType: 'straight-h',
      metadata: JSON.stringify({ blockId: 'deleted-block' }),
    });

    const res = await app.inject({ method: 'GET', url: OPENINGS_URL });
    const openings = JSON.parse(res.body) as Array<{ blockId: string }>;

    expect(openings.map((o) => o.blockId)).not.toContain('deleted-block');
  });

  it('is not admin-gated', async () => {
    await drawTwoBlocks();
    await authenticateAsOperator(app);

    const res = await app.inject({ method: 'GET', url: OPENINGS_URL });

    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for a layout that does not exist, never a 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/layouts/nope/grid/openings' });

    expect(res.statusCode).toBe(404);
  });

  it('never Safe-Stops', async () => {
    await drawTwoBlocks();
    await app.inject({ method: 'GET', url: OPENINGS_URL });

    expect(service.getSystemStatus().status).toBe('online');
  });
});
