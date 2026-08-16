/**
 * Braking HTTP route integration tests (#6 PR B, docs/braking.md B8/B10).
 *
 * Covers the three surfaces PR B adds to `locos.ts`: B8's standard-stop
 * trigger, the braking-fault read, and the acknowledge. Fastify inject
 * against a started `LayoutService`, mirroring `routes-reservations.test.ts`
 * — the refusal bodies are the interesting part, and they are rendered from
 * a real `NameBook` at the transport edge (D9).
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
import { ManualClock } from '../../src/adapters/clock/ManualClock';
import { BlockRecord, ILayoutRepository, LocoRecord } from '../../src/ports/ILayoutRepository';
import {
  authenticateAsAdmin,
  authenticateAsOperator,
  makeTestAuthService,
  TEST_AUTH_CONFIG,
} from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const LAYOUT_ID = 'layout-1';

const BLOCKS: BlockRecord[] = [{ id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1', lengthMm: 500 }];
const LOCOS: LocoRecord[] = [
  { id: 'loco-1', layoutId: LAYOUT_ID, name: 'Class 08', address: 3, type: 'diesel', maxSpeed: 126, brakingFactor: 0.5 },
];

/** Read-only in-memory repository — nothing in this suite writes. */
function makeRepo(): ILayoutRepository {
  return {
    listLayouts: vi.fn().mockResolvedValue([{ id: LAYOUT_ID, name: 'Test', createdAt: new Date() }]),
    getLayout: vi.fn().mockResolvedValue({ id: LAYOUT_ID, name: 'Test', createdAt: new Date() }),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn().mockResolvedValue(LOCOS),
    getLoco: vi.fn().mockResolvedValue(null),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue(BLOCKS),
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
    getCompiledGraph: vi.fn().mockResolvedValue(null),
    replaceBlockEdges: vi.fn(),
    listReservations: vi.fn().mockResolvedValue([]),
    getReservation: vi.fn().mockResolvedValue(null),
    createReservation: vi.fn(),
    updateReservation: vi.fn(),
    markHoldsReleased: vi.fn(),
  };
}

async function buildTestServer(repo: ILayoutRepository) {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager(LAYOUT_ID);
  const nameBook = new NameBookCache(repo, LAYOUT_ID);
  const reservations = new ReservationService(repo, state, silentLogger, nameBook);
  // A ManualClock so a ramp started by one of these requests never schedules
  // a real timer — no test here advances it, so every run stops after its
  // first (inline) step.
  const service = new LayoutService(
    dcc,
    mqtt,
    repo,
    state,
    reservations,
    silentLogger,
    undefined,
    nameBook,
    undefined,
    new ManualClock(),
  );
  const topologyService = new TopologyService(
    repo,
    () => service.reloadTopology(),
    silentLogger,
    reservations,
    nameBook,
  );
  await service.start(LAYOUT_ID);
  const authService = await makeTestAuthService();
  const app = await buildServer(service, repo, 'silent', topologyService, authService, TEST_AUTH_CONFIG, nameBook);
  return { app, service, state, dcc };
}

describe('Braking routes', () => {
  let repo: ILayoutRepository;
  let app: Awaited<ReturnType<typeof buildTestServer>>['app'];
  let service: Awaited<ReturnType<typeof buildTestServer>>['service'];
  let state: LayoutStateManager;
  let dcc: SimulatedDccAdapter;

  beforeEach(async () => {
    repo = makeRepo();
    ({ app, service, state, dcc } = await buildTestServer(repo));
  });

  it('POST .../locos/:address/brake returns the running schedule and its predicted distance (B8)', async () => {
    await authenticateAsAdmin(app);
    state.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'manual' });
    dcc.clearLog();

    const res = await app.inject({ method: 'POST', url: `/api/layouts/${LAYOUT_ID}/locos/3/brake` });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.schedule.locoAddress).toBe(3);
    expect(body.schedule.steps).toHaveLength(16);
    expect(body.schedule.estimatedStoppingDistanceMm).toBe(500);
    // The first step is already on the wire when this responds.
    expect(dcc.commandLog.filter((c) => c.type === 'SET_SPEED')).toHaveLength(1);
  });

  it('an operator may brake — this is driving, not roster config', async () => {
    await authenticateAsOperator(app);
    state.updateLoco(3, { speed: 60, direction: 'fwd', authority: 'manual' });

    const res = await app.inject({ method: 'POST', url: `/api/layouts/${LAYOUT_ID}/locos/3/brake` });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a stopped loco with 409, carrying both the rendered text and the structured reason', async () => {
    await authenticateAsAdmin(app);
    state.updateLoco(3, { speed: 0, direction: 'stop', authority: 'manual' });

    const res = await app.inject({ method: 'POST', url: `/api/layouts/${LAYOUT_ID}/locos/3/brake` });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.reason).toEqual({ kind: 'already-stopped', locoAddress: 3 });
    // Named from the NameBook, not a bare address (#54, D9).
    expect(body.error).toContain('Class 08');
  });

  it('refuses a loco that has never been commanded — never assumes speed 0 (B6)', async () => {
    await authenticateAsAdmin(app);

    const res = await app.inject({ method: 'POST', url: `/api/layouts/${LAYOUT_ID}/locos/3/brake` });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).reason).toEqual({ kind: 'unknown-loco-state', locoAddress: 3 });
  });

  it('refuses a braking run while Safe-Stopped — a ramp starts with a non-zero speed step (B6)', async () => {
    await authenticateAsAdmin(app);
    state.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'manual' });
    state.enterSafeStop('test-induced safe-stop');

    const res = await app.inject({ method: 'POST', url: `/api/layouts/${LAYOUT_ID}/locos/3/brake` });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).reason).toEqual({ kind: 'system-not-online', status: 'safe-stop' });
  });

  it('404s a layout that is not the running one, and 400s a non-numeric address', async () => {
    await authenticateAsAdmin(app);

    const wrongLayout = await app.inject({ method: 'POST', url: '/api/layouts/other/locos/3/brake' });
    expect(wrongLayout.statusCode).toBe(404);

    const badAddress = await app.inject({ method: 'POST', url: `/api/layouts/${LAYOUT_ID}/locos/abc/brake` });
    expect(badAddress.statusCode).toBe(400);
  });

  it('GET .../automation lists the trains under automation, and 404s another layout (#7 PR C)', async () => {
    await authenticateAsAdmin(app);

    // Nothing is automated on a layout nobody has opted in — every column
    // automation needs is nullable and nothing back-fills one (A7).
    const empty = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/automation` });
    expect(empty.statusCode).toBe(200);
    expect(JSON.parse(empty.body)).toEqual({ runs: [] });

    const wrongLayout = await app.inject({ method: 'GET', url: '/api/layouts/other/automation' });
    expect(wrongLayout.statusCode).toBe(404);
  });

  it('an operator may read automation state — it is a read, like the fault lists', async () => {
    await authenticateAsOperator(app);
    const res = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/automation` });
    expect(res.statusCode).toBe(200);
  });

  it('GET .../braking-faults lists what is latched, and 404s another layout', async () => {
    await authenticateAsAdmin(app);

    const empty = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/braking-faults` });
    expect(empty.statusCode).toBe(200);
    expect(JSON.parse(empty.body)).toEqual({ faults: [] });

    const wrongLayout = await app.inject({ method: 'GET', url: '/api/layouts/other/braking-faults' });
    expect(wrongLayout.statusCode).toBe(404);
  });

  it('acknowledging a loco with no latched fault is a 404 — there is no "not armed" case (B10)', async () => {
    await authenticateAsAdmin(app);

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/locos/3/acknowledge-fault`,
    });

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).locoAddress).toBe(3);
  });

  it('acknowledges a latched fault, clears the Safe-Stop it held, and returns the remaining set', async () => {
    await authenticateAsAdmin(app);
    state.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'manual' });
    // Fault it the way the ramp does: a rejected first command.
    vi.spyOn(dcc, 'setSpeed').mockRejectedValueOnce(new Error('DCC offline'));
    const outcome = await service.startStandardStop(3);
    expect(outcome.started).toBe(false);
    expect(service.getSystemStatus().status).toBe('safe-stop');

    const listed = await app.inject({ method: 'GET', url: `/api/layouts/${LAYOUT_ID}/braking-faults` });
    expect(JSON.parse(listed.body).faults).toHaveLength(1);

    const res = await app.inject({
      method: 'POST',
      url: `/api/layouts/${LAYOUT_ID}/locos/3/acknowledge-fault`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ locoAddress: 3, cleared: true, systemStatus: 'online', faults: [] });
  });
});
