import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LayoutService,
  PointLockedError,
  SensorFaultNotArmedError,
  SensorNotFaultedError,
  SensorNotFoundError,
} from '../../../src/services/LayoutService';
import { ReservationService } from '../../../src/services/ReservationService';
import { NameBookCache } from '../../../src/services/nameBook';
import { LayoutStateManager } from '../../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository, LocoRecord, SensorRecord } from '../../../src/ports/ILayoutRepository';
import { BlockEdgeRowInvalidError } from '../../../src/services/validation';
import { BlockEdge, RouteHoldKind, RouteReservation, RouteStatus } from '../../../src/domain/types';

const LOCO_3: LocoRecord = {
  id: 'loco-3',
  layoutId: 'test',
  name: 'Loco 3',
  address: 3,
  type: 'diesel',
  maxSpeed: 126,
  brakingFactor: 0.5,
};

/** A two-block edge, b1 -> b2, gated by point p1 required 'normal' — used by the route-locking tests below. */
const EDGE_WITH_POINT: BlockEdge = {
  id: 'e1',
  layoutId: 'test',
  fromBlockId: 'b1',
  fromEnd: 'east',
  toBlockId: 'b2',
  toEnd: 'west',
  pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
  lengthMm: null,
};

// ── In-memory repository stub ─────────────────────────────────────────────────
//
// The route reservation methods are a real in-memory store, not bare mocks —
// LayoutService's route-locking tests exercise a genuine ReservationService,
// which needs create/get/update/markReleased to actually round-trip.

const SENSOR_S1: SensorRecord = {
  id: 's1',
  layoutId: 'test',
  name: 'Sensor 1',
  type: 'block_detection',
  blockId: 'b1',
  mqttTopic: 'layout/test/sensor/s1/reading',
  inService: true,
};

function makeRepo(): ILayoutRepository {
  const reservations = new Map<
    string,
    { row: Omit<RouteReservation, 'holds'>; holds: Map<string, RouteReservation['holds'][number]> }
  >();
  let sensors: SensorRecord[] = [SENSOR_S1];

  function toReservation(id: string): RouteReservation {
    const entry = reservations.get(id)!;
    return { ...entry.row, holds: [...entry.holds.values()] };
  }

  return {
    listLayouts: vi.fn().mockResolvedValue([]),
    getLayout: vi.fn().mockResolvedValue(null),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn().mockResolvedValue([LOCO_3]),
    getLoco: vi.fn().mockResolvedValue(null),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([{ id: 'b1', layoutId: 'test', name: 'Block 1' }]),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn().mockResolvedValue([
      { id: 'p1', layoutId: 'test', name: 'Point 1', dccAddress: 10, blockId: 'b1', positionFeedback: 'none' },
    ]),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn().mockImplementation(async (layoutId: string) =>
      sensors.filter((s) => s.layoutId === layoutId),
    ),
    createSensor: vi.fn().mockImplementation(async (data: Omit<SensorRecord, 'id'>) => {
      const created: SensorRecord = { id: `sensor-${sensors.length + 1}`, ...data };
      sensors = [...sensors, created];
      return created;
    }),
    updateSensor: vi
      .fn()
      .mockImplementation(async (id: string, data: Partial<Omit<SensorRecord, 'id' | 'layoutId'>>) => {
        const index = sensors.findIndex((s) => s.id === id);
        if (index === -1) throw new Error(`Sensor ${id} not found after update`);
        const updated = { ...sensors[index], ...data };
        sensors = sensors.map((s, i) => (i === index ? updated : s));
        return updated;
      }),
    deleteSensor: vi.fn().mockImplementation(async (id: string) => {
      sensors = sensors.filter((s) => s.id !== id);
    }),
    listGridTiles: vi.fn().mockResolvedValue([]),
    upsertGridTile: vi.fn(),
    deleteTile: vi.fn().mockResolvedValue(undefined),
    clearGrid: vi.fn(),
    listBlockEdges: vi.fn().mockResolvedValue([]),
    getBlockEdge: vi.fn().mockResolvedValue(null),
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),

    listReservations: vi.fn().mockImplementation(async (layoutId: string, statuses?: RouteStatus[]) =>
      [...reservations.keys()]
        .map(toReservation)
        .filter((r) => r.layoutId === layoutId && (!statuses || statuses.includes(r.status))),
    ),
    getReservation: vi.fn().mockImplementation(async (id: string) => (reservations.has(id) ? toReservation(id) : null)),
    createReservation: vi
      .fn()
      .mockImplementation(async (data: Omit<RouteReservation, 'createdAt' | 'updatedAt'>) => {
        const now = new Date();
        reservations.set(data.id, {
          row: {
            id: data.id,
            layoutId: data.layoutId,
            locoAddress: data.locoAddress,
            authority: data.authority,
            status: data.status,
            path: data.path,
            confirmedIndex: data.confirmedIndex,
            reason: data.reason,
            createdAt: now,
            updatedAt: now,
          },
          holds: new Map(data.holds.map((h) => [`${h.kind}:${h.targetId}`, { ...h }])),
        });
        return toReservation(data.id);
      }),
    updateReservation: vi
      .fn()
      .mockImplementation(
        async (id: string, data: { status?: RouteStatus; confirmedIndex?: number; reason?: string | null }) => {
          const entry = reservations.get(id);
          if (!entry) throw new Error(`Route reservation ${id} not found after update`);
          entry.row = { ...entry.row, ...data, updatedAt: new Date() };
          return toReservation(id);
        },
      ),
    markHoldsReleased: vi
      .fn()
      .mockImplementation(async (routeId: string, holds: Array<{ kind: RouteHoldKind; targetId: string }>) => {
        const entry = reservations.get(routeId);
        if (!entry) return;
        for (const h of holds) {
          const key = `${h.kind}:${h.targetId}`;
          const existing = entry.holds.get(key);
          if (existing) entry.holds.set(key, { ...existing, released: true });
        }
      }),
  };
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ── Test helpers ──────────────────────────────────────────────────────────────

async function buildStartedService() {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const repo = makeRepo();
  const stateManager = new LayoutStateManager('test');
  const reservations = new ReservationService(repo, stateManager, silentLogger);
  const service = new LayoutService(dcc, mqtt, repo, stateManager, reservations, silentLogger);
  await service.start('test');
  return { service, dcc, mqtt, repo, stateManager, reservations };
}

/** A started service with a second block, an edge from b1 to b2 gated by point p1, and loco 3 in the roster — the fixture the route-locking (D6) tests grant a route over. */
async function buildStartedServiceWithGraph() {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const repo = makeRepo();
  vi.mocked(repo.listBlocks).mockResolvedValue([
    { id: 'b1', layoutId: 'test', name: 'Block 1' },
    { id: 'b2', layoutId: 'test', name: 'Block 2' },
  ]);
  vi.mocked(repo.listBlockEdges).mockResolvedValue([EDGE_WITH_POINT]);
  const stateManager = new LayoutStateManager('test');
  const reservations = new ReservationService(repo, stateManager, silentLogger);
  const service = new LayoutService(dcc, mqtt, repo, stateManager, reservations, silentLogger);
  await service.start('test');
  stateManager.updateBlockOccupancy('b1', 'occupied', 3);
  stateManager.updateBlockOccupancy('b2', 'clear');
  return { service, dcc, mqtt, repo, stateManager, reservations };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('LayoutService — startup', () => {
  it('sets system status to online after start', async () => {
    const { service } = await buildStartedService();
    expect(service.getSystemStatus().status).toBe('online');
    await service.stop();
  });

  it('registers blocks and points from the repository', async () => {
    const { stateManager, service } = await buildStartedService();
    expect(stateManager.getBlock('b1')).toBeDefined();
    expect(stateManager.getPoint('p1')).toBeDefined();
    await service.stop();
  });
});

describe('LayoutService — throttle commands', () => {
  it('issues a DCC speed command and updates loco state', async () => {
    const { service, dcc } = await buildStartedService();

    // #149: connecting commands track power on, so the log is not empty before
    // this call. Filtering rather than indexing keeps the assertion about the
    // throttle command instead of about how many other commands precede it.
    dcc.clearLog();
    await service.handleThrottleCommand({ locoAddress: 3, speed: 50, direction: 'fwd' });

    expect(dcc.commandLog).toHaveLength(1);
    expect(dcc.commandLog[0].type).toBe('SET_SPEED');
    expect(dcc.commandLog[0].data).toMatchObject({ address: 3, speed: 50, direction: 'fwd' });
    await service.stop();
  });

  it('emits a LOCO_STATE event', async () => {
    const { service } = await buildStartedService();
    const events: unknown[] = [];
    service.on('event', (e) => events.push(e));

    await service.handleThrottleCommand({ locoAddress: 3, speed: 40, direction: 'rev' });

    const locoEvents = (events as Array<{ type: string }>).filter((e) => e.type === 'LOCO_STATE');
    expect(locoEvents).toHaveLength(1);
    await service.stop();
  });

  it('rejects an invalid speed', async () => {
    const { service } = await buildStartedService();
    await expect(
      service.handleThrottleCommand({ locoAddress: 3, speed: 200, direction: 'fwd' }),
    ).rejects.toThrow(/speed/i);
    await service.stop();
  });

  it('rejects an invalid loco address', async () => {
    const { service } = await buildStartedService();
    await expect(
      service.handleThrottleCommand({ locoAddress: 0, speed: 50, direction: 'fwd' }),
    ).rejects.toThrow(/address/i);
    await service.stop();
  });

  it('a manual throttle command for a loco under an auto-authority route cancels that route (D6)', async () => {
    const { service, stateManager } = await buildStartedServiceWithGraph();
    const grant = await service.requestRoute({
      locoAddress: 3,
      authority: 'auto',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: ['e1'] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');

    await service.handleThrottleCommand({ locoAddress: 3, speed: 50, direction: 'fwd' });

    expect(service.listRoutes(['active']).map((r) => r.id)).not.toContain(grant.reservation.id);
    expect(stateManager.getBlock('b2')?.lockedByRoute).toBeNull();
    await service.stop();
  });

  it('a manual throttle command for a loco under a manual-authority route does nothing to the route (D6)', async () => {
    const { service, stateManager } = await buildStartedServiceWithGraph();
    const grant = await service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: ['e1'] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');

    await service.handleThrottleCommand({ locoAddress: 3, speed: 50, direction: 'fwd' });

    expect(service.listRoutes(['active']).map((r) => r.id)).toContain(grant.reservation.id);
    expect(stateManager.getBlock('b2')?.lockedByRoute).toBe(grant.reservation.id);
    await service.stop();
  });
});

describe('LayoutService — emergency stop', () => {
  it('stops all locos and issues DCC emergency stop', async () => {
    const { service, dcc, stateManager } = await buildStartedService();

    await service.handleThrottleCommand({ locoAddress: 3, speed: 50, direction: 'fwd' });
    dcc.clearLog();

    await service.handleEmergencyStop();

    expect(dcc.commandLog[0].type).toBe('EMERGENCY_STOP');
    expect(stateManager.getLoco(3)?.speed).toBe(0);
    await service.stop();
  });
});

describe('LayoutService — point commands', () => {
  it('issues a DCC point command and updates point state', async () => {
    const { service, dcc, stateManager } = await buildStartedService();

    // #149: connecting commands track power on, so clear before asserting.
    dcc.clearLog();
    await service.handlePointCommand({ pointId: 'p1', position: 'reverse' });

    expect(dcc.commandLog).toHaveLength(1);
    expect(dcc.commandLog[0].type).toBe('SET_POINT');
    // p1 is `positionFeedback: 'none'` — commandedPosition is set, but D7's
    // trust model for an uninstrumented point falls back to it (there is no
    // reading yet to disagree).
    expect(stateManager.getPoint('p1')?.commandedPosition).toBe('reverse');
    await service.stop();
  });

  it('rejects a command on a locked point without force, with a typed PointLockedError', async () => {
    const { service } = await buildStartedServiceWithGraph();
    const grant = await service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: ['e1'] },
    });
    expect(grant.granted).toBe(true);

    await expect(service.handlePointCommand({ pointId: 'p1', position: 'reverse' })).rejects.toThrow(
      PointLockedError,
    );
    await service.stop();
  });

  it('a force override on a locked point cancels the holding route, releases its locks, and stops its loco when the route is auto-authority (D6)', async () => {
    const { service, dcc, stateManager } = await buildStartedServiceWithGraph();
    const grant = await service.requestRoute({
      locoAddress: 3,
      authority: 'auto',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: ['e1'] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');
    dcc.clearLog();

    await service.handlePointCommand({ pointId: 'p1', position: 'reverse', force: true });

    // The route is cancelled and every lock released.
    expect(service.listRoutes(['active']).map((r) => r.id)).not.toContain(grant.reservation.id);
    expect(stateManager.getBlock('b1')?.lockedByRoute).toBeNull();
    expect(stateManager.getBlock('b2')?.lockedByRoute).toBeNull();
    // The point command itself still goes through.
    expect(stateManager.getPoint('p1')?.commandedPosition).toBe('reverse');
    // Its (auto-authority) loco is stopped.
    expect(dcc.commandLog.some((c) => c.type === 'SET_SPEED' && c.data.speed === 0)).toBe(true);
    // No system-wide Safe-Stop — a deliberate, authorised operator action.
    expect(service.getSystemStatus().status).toBe('online');
    await service.stop();
  });

  it('force in auto mode is refused outright — no manual authority in auto (D6)', async () => {
    const { service } = await buildStartedServiceWithGraph();
    const grant = await service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: ['e1'] },
    });
    expect(grant.granted).toBe(true);

    await service.handleSetMode({ mode: 'auto' });

    await expect(
      service.handlePointCommand({ pointId: 'p1', position: 'reverse', force: true }),
    ).rejects.toThrow(/force/i);
    // The route survives the refused override.
    expect(service.listRoutes(['active'])).toHaveLength(1);
    await service.stop();
  });
});

describe('LayoutService — point confirmation ingestion (see docs/point-feedback.md)', () => {
  /** A started service with p1 and p2 both `positionFeedback: 'required'` — the failure paths below need a topic/payload id-mismatch pair and a lone unknown point. */
  async function buildServiceWithRequiredPoints() {
    const dcc = new SimulatedDccAdapter(silentLogger);
    const mqtt = new SimulatedMqttAdapter();
    const repo = makeRepo();
    vi.mocked(repo.listPoints).mockResolvedValue([
      { id: 'p1', layoutId: 'test', name: 'Point 1', dccAddress: 10, blockId: 'b1', positionFeedback: 'required' },
      { id: 'p2', layoutId: 'test', name: 'Point 2', dccAddress: 11, blockId: 'b1', positionFeedback: 'required' },
    ]);
    const stateManager = new LayoutStateManager('test');
    const reservations = new ReservationService(repo, stateManager, silentLogger);
    const service = new LayoutService(dcc, mqtt, repo, stateManager, reservations, silentLogger);
    await service.start('test');
    return { service, dcc, mqtt, repo, stateManager, reservations };
  }

  it('a malformed reading enters Safe-Stop with a populated safeStopReason', async () => {
    const { service, mqtt } = await buildServiceWithRequiredPoints();

    mqtt.simulateIncoming('layout/test/point/p1/reading', { garbage: true });
    await new Promise((r) => setImmediate(r));

    const status = service.getSystemStatus();
    expect(status.status).toBe('safe-stop');
    expect(status.reason).toBeTruthy();
    expect(service.getPointFaults()).toHaveLength(1);
    expect(service.getPointFaults()[0]).toMatchObject({ pointId: 'p1', kind: 'malformed-payload' });

    await service.stop();
  });

  it('a payload/topic id mismatch enters Safe-Stop and leaves both points state untouched', async () => {
    const { service, mqtt, stateManager } = await buildServiceWithRequiredPoints();
    const before1 = stateManager.getPoint('p1');
    const before2 = stateManager.getPoint('p2');

    mqtt.simulateIncoming('layout/test/point/p1/reading', {
      pointId: 'p2',
      position: 'normal',
      source: 'sensor',
    });
    await new Promise((r) => setImmediate(r));

    const status = service.getSystemStatus();
    expect(status.status).toBe('safe-stop');
    // Latched against the TOPIC point id (p1), never the payload-named one (p2).
    expect(service.getPointFaults().map((f) => f.pointId)).toEqual(['p1']);
    expect(stateManager.getPoint('p1')).toEqual(before1);
    expect(stateManager.getPoint('p2')).toEqual(before2);

    await service.stop();
  });

  it('a reading for an unknown point logs and does not Safe-Stop', async () => {
    const { service, mqtt } = await buildServiceWithRequiredPoints();

    mqtt.simulateIncoming('layout/test/point/ghost/reading', {
      pointId: 'ghost',
      position: 'normal',
      source: 'sensor',
    });
    await new Promise((r) => setImmediate(r));

    expect(service.getSystemStatus().status).toBe('online');
    expect(service.getPointFaults()).toEqual([]);

    await service.stop();
  });

  // The order of the two checks above is load-bearing, so it gets its own
  // case: a decommissioned controller nobody unplugged is exactly the thing
  // that publishes garbage under a point id this layout has never heard of,
  // and halting the railway over it is the nuisance trip #25's plan
  // (decision 4) refused. Parse-before-registry would Safe-Stop here.
  it('a malformed reading for an unknown point is dropped, not a Safe-Stop', async () => {
    const { service, mqtt } = await buildServiceWithRequiredPoints();

    mqtt.simulateIncoming('layout/test/point/ghost/reading', { garbage: true });
    await new Promise((r) => setImmediate(r));

    expect(service.getSystemStatus().status).toBe('online');
    expect(service.getPointFaults()).toEqual([]);

    await service.stop();
  });

  it('a retained reading changes nothing', async () => {
    const { service, mqtt, stateManager } = await buildServiceWithRequiredPoints();
    await service.handlePointCommand({ pointId: 'p1', position: 'normal' });
    const before = stateManager.getPoint('p1');

    mqtt.simulateIncoming(
      'layout/test/point/p1/reading',
      { pointId: 'p1', position: 'normal', source: 'sensor' },
      true,
    );
    await new Promise((r) => setImmediate(r));

    expect(stateManager.getPoint('p1')).toEqual(before);
    expect(service.getPointFaults()).toEqual([]);
    expect(service.getSystemStatus().status).toBe('online');

    await service.stop();
  });

  it("queryPointPositions publishes retain: false and skips 'none' points", async () => {
    const dcc = new SimulatedDccAdapter(silentLogger);
    const mqtt = new SimulatedMqttAdapter();
    const repo = makeRepo();
    vi.mocked(repo.listPoints).mockResolvedValue([
      { id: 'p1', layoutId: 'test', name: 'Point 1', dccAddress: 10, blockId: 'b1', positionFeedback: 'required' },
      { id: 'p2', layoutId: 'test', name: 'Point 2', dccAddress: 11, blockId: 'b1', positionFeedback: 'none' },
    ]);
    const stateManager = new LayoutStateManager('test');
    const reservations = new ReservationService(repo, stateManager, silentLogger);
    const service = new LayoutService(dcc, mqtt, repo, stateManager, reservations, silentLogger);

    await service.start('test');

    const queries = mqtt.publishLog.filter((p) => p.topic.endsWith('/query'));
    expect(queries).toHaveLength(1);
    expect(queries[0].topic).toBe('layout/test/point/p1/query');
    expect(queries[0].retain).toBe(false);
    expect(queries[0].qos).toBe(1);

    await service.stop();
  });

  it('queries are re-issued on MQTT reconnect', async () => {
    const dcc = new SimulatedDccAdapter(silentLogger);
    const mqtt = new SimulatedMqttAdapter();
    const repo = makeRepo();
    vi.mocked(repo.listPoints).mockResolvedValue([
      { id: 'p1', layoutId: 'test', name: 'Point 1', dccAddress: 10, blockId: 'b1', positionFeedback: 'required' },
    ]);
    const stateManager = new LayoutStateManager('test');
    const reservations = new ReservationService(repo, stateManager, silentLogger);
    const service = new LayoutService(dcc, mqtt, repo, stateManager, reservations, silentLogger);
    await service.start('test');
    mqtt.clearLog();

    await mqtt.disconnect();
    await new Promise((r) => setImmediate(r));
    await mqtt.connect();
    await new Promise((r) => setImmediate(r));

    const queries = mqtt.publishLog.filter((p) => p.topic.endsWith('/query'));
    expect(queries).toHaveLength(1);
    expect(queries[0].topic).toBe('layout/test/point/p1/query');

    await service.stop();
  });
});

describe('LayoutService — sensor-driven block state', () => {
  it('updates block occupancy when a sensor reading arrives', async () => {
    const { service, mqtt, stateManager } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', {
      state: 'occupied',
      updatedAt: new Date().toISOString(),
    });

    // simulateIncoming is synchronous via the handler called directly
    await new Promise((r) => setImmediate(r));
    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');
    await service.stop();
  });

  it('enters Safe-Stop on a malformed sensor payload, naming the sensor and topic, without mutating block state', async () => {
    const { service, mqtt, stateManager } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', { badField: 'nonsense' });
    await new Promise((r) => setImmediate(r));

    // Block must remain in its initial 'unknown' state — the malformed
    // message must never reach stateManager.updateBlockOccupancy.
    expect(stateManager.getBlock('b1')?.occupancy).toBe('unknown');

    const status = service.getSystemStatus();
    expect(status.status).toBe('safe-stop');
    expect(status.reason).toMatch(/s1/);
    expect(status.reason).toMatch(/layout\/test\/sensor\/s1\/reading/);

    await service.stop();
  });

  it('#54: with a populated NameBookCache, the Safe-Stop reason names the sensor (D9 — baked at generation time)', async () => {
    const dcc = new SimulatedDccAdapter(silentLogger);
    const mqtt = new SimulatedMqttAdapter();
    const repo = makeRepo();
    vi.mocked(repo.listSensors).mockResolvedValue([{ ...SENSOR_S1, name: 'Platform Detector' }]);
    const stateManager = new LayoutStateManager('test');
    const reservations = new ReservationService(repo, stateManager, silentLogger);
    const names = new NameBookCache(repo, 'test');
    const service = new LayoutService(dcc, mqtt, repo, stateManager, reservations, silentLogger, undefined, names);
    await service.start('test');

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', { badField: 'nonsense' });
    await new Promise((r) => setImmediate(r));

    const status = service.getSystemStatus();
    expect(status.status).toBe('safe-stop');
    expect(status.reason).toContain('Platform Detector');
    expect(status.reason).toContain('s1');

    await service.stop();
  });

  it('de-contributes the faulted sensor so its block falls back to unknown (D4)', async () => {
    // Per D4 (docs/sensor-fault-recovery.md), a faulted sensor stops
    // contributing to its block IMMEDIATELY — its last reading is not
    // retained as a going belief. This inverts the pre-#34 assertion
    // ("the last known-good occupancy survives") which is now wrong.
    const { service, mqtt, stateManager } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', {
      state: 'occupied',
      updatedAt: new Date().toISOString(),
    });
    await new Promise((r) => setImmediate(r));
    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', { badField: 'nonsense' });
    await new Promise((r) => setImmediate(r));

    expect(stateManager.getBlock('b1')?.occupancy).toBe('unknown');
    expect(stateManager.getBlock('b1')?.locoAddress).toBeNull();
    expect(service.getSystemStatus().status).toBe('safe-stop');

    await service.stop();
  });
});

describe('LayoutService — recomputeBlock occupancy-change logging (#161)', () => {
  // Same pattern as the describe block below: `silentLogger` is a
  // module-level singleton, cleared per-test so an earlier test's calls
  // cannot be mistaken for this one's.
  beforeEach(() => {
    silentLogger.info.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  it('logs an occupancy change unconditionally, naming both the old and new value', async () => {
    const { service, mqtt } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', {
      state: 'occupied',
      updatedAt: new Date().toISOString(),
    });
    await new Promise((r) => setImmediate(r));

    expect(silentLogger.info).toHaveBeenCalledWith('[LayoutService] Block occupancy changed', {
      blockId: 'b1',
      blockName: undefined,
      from: 'unknown',
      to: 'occupied',
    });

    await service.stop();
  });

  it('an occupied -> unknown transition logs distinguishably from a clear/unknown -> occupied one', async () => {
    // #34/#28: the case the issue is about — a block whose only sensor is
    // flapping reads identically at `info` before this fix, because
    // `isBlockEffectivelyOccupied` (occupancy !== 'clear') is true for both
    // `occupied` and `unknown`. `from`/`to` is what makes the two transitions
    // distinguishable in the journal.
    const { service, mqtt } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', {
      state: 'occupied',
      updatedAt: new Date().toISOString(),
    });
    await new Promise((r) => setImmediate(r));
    silentLogger.info.mockClear();

    // A malformed payload trips the sensor fault, which de-contributes the
    // sensor immediately (D4) and drives the block to `unknown` — the same
    // `recomputeBlock` path, reached from the fault branch rather than the
    // ordinary accepted-reading one.
    mqtt.simulateIncoming('layout/test/sensor/s1/reading', { badField: 'nonsense' });
    await new Promise((r) => setImmediate(r));

    expect(silentLogger.info).toHaveBeenCalledWith('[LayoutService] Block occupancy changed', {
      blockId: 'b1',
      blockName: undefined,
      from: 'occupied',
      to: 'unknown',
    });

    await service.stop();
  });
});

describe('LayoutService — SENSOR_STATE (#76 D-b: pushed on a CONTRIBUTED-value change, never on every reading)', () => {
  function reading(state: 'occupied' | 'clear') {
    return { state, updatedAt: new Date().toISOString() };
  }

  it('emits SENSOR_STATE the first time a sensor reports', async () => {
    const { service, mqtt } = await buildStartedService();
    const events: unknown[] = [];
    service.on('event', (e) => events.push(e));

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', reading('occupied'));
    await new Promise((r) => setImmediate(r));

    const sensorStates = (events as Array<{ type: string; payload: unknown }>).filter(
      (e) => e.type === 'SENSOR_STATE',
    );
    expect(sensorStates).toHaveLength(1);
    expect(sensorStates[0].payload).toMatchObject({
      sensorId: 's1',
      lastReading: 'occupied',
      trusted: true,
      faulted: false,
      inService: true,
    });

    await service.stop();
  });

  it('does NOT emit SENSOR_STATE on a re-assert at the same value — the whole point of D-b', async () => {
    const { service, mqtt } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', reading('occupied'));
    await new Promise((r) => setImmediate(r));

    const events: unknown[] = [];
    service.on('event', (e) => events.push(e));

    // A healthy sensor re-asserting the identical reading, exactly what #28
    // obliges hardware to do every 30s inside the freshness window.
    mqtt.simulateIncoming('layout/test/sensor/s1/reading', reading('occupied'));
    await new Promise((r) => setImmediate(r));

    expect((events as Array<{ type: string }>).filter((e) => e.type === 'SENSOR_STATE')).toEqual([]);

    await service.stop();
  });

  it('emits SENSOR_STATE on a transition (occupied -> clear) — the flap stays visible', async () => {
    const { service, mqtt } = await buildStartedService();
    mqtt.simulateIncoming('layout/test/sensor/s1/reading', reading('occupied'));
    await new Promise((r) => setImmediate(r));

    const events: unknown[] = [];
    service.on('event', (e) => events.push(e));

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', reading('clear'));
    await new Promise((r) => setImmediate(r));

    const sensorStates = (events as Array<{ type: string; payload: unknown }>).filter(
      (e) => e.type === 'SENSOR_STATE',
    );
    expect(sensorStates).toHaveLength(1);
    expect(sensorStates[0].payload).toMatchObject({ lastReading: 'clear' });

    await service.stop();
  });

  it('emits SENSOR_STATE when a malformed payload faults the sensor — faulted flips even though lastReading is nulled', async () => {
    const { service, mqtt } = await buildStartedService();
    mqtt.simulateIncoming('layout/test/sensor/s1/reading', reading('occupied'));
    await new Promise((r) => setImmediate(r));

    const events: unknown[] = [];
    service.on('event', (e) => events.push(e));

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', { badField: 'nonsense' });
    await new Promise((r) => setImmediate(r));

    const sensorStates = (events as Array<{ type: string; payload: unknown }>).filter(
      (e) => e.type === 'SENSOR_STATE',
    );
    expect(sensorStates).toHaveLength(1);
    expect(sensorStates[0].payload).toMatchObject({ faulted: true, lastReading: null });

    await service.stop();
  });

  it('an untrusted (retained-only) observation is still projected — never omitted (D-d)', async () => {
    const { service, mqtt } = await buildStartedService();
    const events: unknown[] = [];
    service.on('event', (e) => events.push(e));

    // A retained delivery from a controller nobody has heard from live —
    // recorded but never trusted (#28 D7). Still a real contributed-value
    // change (null -> a reading), so it still emits.
    mqtt.simulateIncoming('layout/test/sensor/s1/reading', reading('clear'), true);
    await new Promise((r) => setImmediate(r));

    const sensorStates = (events as Array<{ type: string; payload: unknown }>).filter(
      (e) => e.type === 'SENSOR_STATE',
    );
    expect(sensorStates).toHaveLength(1);
    expect(sensorStates[0].payload).toMatchObject({
      lastReading: 'clear',
      trusted: false,
      source: 'retained',
    });

    await service.stop();
  });
});

describe('LayoutService — empty sensor payload is a retained-clear, not a fault (#65 D7, docs/sensor-fault-recovery.md D9)', () => {
  // `silentLogger` is a module-level singleton shared by every test in this
  // file with no reset — cleared here (scoped to this describe only, same
  // pattern as mqttAdapter.test.ts) so the ordering-guard test below can
  // assert on which log line fired without tripping over an identical call
  // recorded by an earlier test in this same block.
  beforeEach(() => {
    silentLogger.info.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  it('an empty sensor payload is ignored: no fault, no Safe-Stop, occupancy unchanged', async () => {
    const { service, mqtt, stateManager } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', {
      state: 'occupied',
      updatedAt: new Date().toISOString(),
    });
    await new Promise((r) => setImmediate(r));
    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', '');
    await new Promise((r) => setImmediate(r));

    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');
    expect(service.getSystemStatus().status).toBe('online');
    expect(service.getSensorFaults()).toEqual([]);

    await service.stop();
  });

  it('an empty payload from an out-of-service sensor is dropped by the in-service check, not 2b', async () => {
    const { service, mqtt, stateManager } = await buildStartedService();
    // Simulates DD4's "a handler that somehow still fires" case (a stale
    // subscription) — the registry is told the sensor is out of service
    // WITHOUT going through updateSensorConfig, which would also unsubscribe
    // and make the topic undeliverable, short-circuiting the very ordering
    // this test exists to prove.
    stateManager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: false });

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', '');
    await new Promise((r) => setImmediate(r));

    expect(silentLogger.warn).toHaveBeenCalledWith(
      '[LayoutService] Sensor reading from an out-of-service sensor — dropping before validation',
      expect.objectContaining({ sensorId: 's1' }),
    );
    expect(silentLogger.info).not.toHaveBeenCalledWith(
      '[LayoutService] Empty (retained-clear) sensor payload — ignored, not a fault',
      expect.anything(),
    );
    expect(stateManager.getBlock('b1')?.occupancy).toBe('unknown');
    expect(service.getSystemStatus().status).toBe('online');

    await service.stop();
  });

  it('a whitespace-only payload is still malformed and trips a sensor fault', async () => {
    const { service, mqtt } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', ' ');
    await new Promise((r) => setImmediate(r));

    expect(service.getSystemStatus().status).toBe('safe-stop');
    expect(service.getSensorFaults()).toHaveLength(1);

    await service.stop();
  });

  it('a null payload is still malformed and trips a sensor fault', async () => {
    const { service, mqtt } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', null);
    await new Promise((r) => setImmediate(r));

    expect(service.getSystemStatus().status).toBe('safe-stop');
    expect(service.getSensorFaults()).toHaveLength(1);

    await service.stop();
  });
});

describe('LayoutService — sensor fault recovery (see docs/sensor-fault-recovery.md)', () => {
  const SENSOR_TOPIC = 'layout/test/sensor/s1/reading';

  function validReading(): { state: 'occupied' | 'clear'; updatedAt: string } {
    return { state: 'occupied', updatedAt: new Date().toISOString() };
  }

  async function faultSensor(mqtt: SimulatedMqttAdapter) {
    mqtt.simulateIncoming(SENSOR_TOPIC, { garbage: true });
    await new Promise((r) => setImmediate(r));
  }

  it('constructor throws for a non-integer clearAfterValidReadings', () => {
    const dcc = new SimulatedDccAdapter(silentLogger);
    const mqtt = new SimulatedMqttAdapter();
    const repo = makeRepo();
    const stateManager = new LayoutStateManager('test');
    const reservations = new ReservationService(repo, stateManager, silentLogger);
    expect(
      () =>
        new LayoutService(dcc, mqtt, repo, stateManager, reservations, silentLogger, {
          clearAfterValidReadings: 0,
        }),
    ).toThrow(/clearAfterValidReadings/);
  });

  it('counts each valid, non-retained reading toward the arming threshold', async () => {
    const { service, mqtt } = await buildStartedService();
    await faultSensor(mqtt);

    mqtt.simulateIncoming(SENSOR_TOPIC, validReading());
    await new Promise((r) => setImmediate(r));

    const [fault] = service.getSensorFaults();
    expect(fault.consecutiveValidReadings).toBe(1);
    expect(fault.armed).toBe(false);
    await service.stop();
  });

  it('does not count a retained valid reading toward arming', async () => {
    const { service, mqtt } = await buildStartedService();
    await faultSensor(mqtt);

    mqtt.simulateIncoming(SENSOR_TOPIC, validReading(), true);
    await new Promise((r) => setImmediate(r));

    expect(service.getSensorFaults()[0].consecutiveValidReadings).toBe(0);
    await service.stop();
  });

  it('resets an in-progress arming count to 0 on a later malformed reading', async () => {
    const { service, mqtt } = await buildStartedService();
    await faultSensor(mqtt);
    mqtt.simulateIncoming(SENSOR_TOPIC, validReading());
    await new Promise((r) => setImmediate(r));
    expect(service.getSensorFaults()[0].consecutiveValidReadings).toBe(1);

    await faultSensor(mqtt);

    expect(service.getSensorFaults()[0].consecutiveValidReadings).toBe(0);
    await service.stop();
  });

  it('a re-fault keeps the original faultedAt and reason (DD5)', async () => {
    const { service, mqtt } = await buildStartedService();
    await faultSensor(mqtt);
    const first = service.getSensorFaults()[0];

    await new Promise((r) => setTimeout(r, 5));
    mqtt.simulateIncoming(SENSOR_TOPIC, { garbage: true, second: true });
    await new Promise((r) => setImmediate(r));

    const second = service.getSensorFaults()[0];
    expect(second.faultedAt).toBe(first.faultedAt);
    expect(second.reason).toBe(first.reason);
    await service.stop();
  });

  it('acknowledge before the threshold throws SensorFaultNotArmedError with the correct outstanding count', async () => {
    const { service, mqtt } = await buildStartedService();
    await faultSensor(mqtt);
    mqtt.simulateIncoming(SENSOR_TOPIC, validReading());
    await new Promise((r) => setImmediate(r));

    await expect(service.acknowledgeSensorFault('test', 's1')).rejects.toThrow(
      SensorFaultNotArmedError,
    );
    try {
      await service.acknowledgeSensorFault('test', 's1');
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(SensorFaultNotArmedError);
      expect((err as SensorFaultNotArmedError).outstanding).toBe(2);
    }
    expect(service.getSystemStatus().status).toBe('safe-stop');
    await service.stop();
  });

  it('acknowledge at the threshold clears the fault and Safe-Stop, and leaves the block unknown until a further reading (D6)', async () => {
    const { service, mqtt, stateManager } = await buildStartedService();
    await faultSensor(mqtt);
    for (let i = 0; i < 3; i++) {
      mqtt.simulateIncoming(SENSOR_TOPIC, validReading());
      await new Promise((r) => setImmediate(r));
    }

    const result = await service.acknowledgeSensorFault('test', 's1');
    expect(result.cleared).toBe(true);
    expect(result.systemStatus).toBe('online');
    expect(result.faults).toEqual([]);
    expect(service.getSystemStatus().status).toBe('online');
    // D6: the acknowledge itself supplies no reading — unknown until a real one arrives.
    expect(stateManager.getBlock('b1')?.occupancy).toBe('unknown');

    mqtt.simulateIncoming(SENSOR_TOPIC, validReading());
    await new Promise((r) => setImmediate(r));
    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');

    await service.stop();
  });

  it('acknowledge with no fault latched throws SensorNotFaultedError', async () => {
    const { service } = await buildStartedService();
    await expect(service.acknowledgeSensorFault('test', 's1')).rejects.toThrow(
      SensorNotFaultedError,
    );
  });

  it('acknowledge for an unknown sensor throws SensorNotFoundError', async () => {
    const { service } = await buildStartedService();
    await expect(service.acknowledgeSensorFault('test', 'ghost')).rejects.toThrow(
      SensorNotFoundError,
    );
    await service.stop();
  });

  it('with two faults, acknowledging one leaves Safe-Stop latched on the other', async () => {
    const repo = makeRepo();
    vi.mocked(repo.listSensors).mockResolvedValue([
      SENSOR_S1,
      { ...SENSOR_S1, id: 's2', mqttTopic: 'layout/test/sensor/s2/reading', blockId: 'b1' },
    ]);
    const dcc = new SimulatedDccAdapter(silentLogger);
    const mqtt = new SimulatedMqttAdapter();
    const stateManager = new LayoutStateManager('test');
    const reservations = new ReservationService(repo, stateManager, silentLogger);
    const service = new LayoutService(dcc, mqtt, repo, stateManager, reservations, silentLogger);
    await service.start('test');

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', { garbage: true });
    await new Promise((r) => setImmediate(r));
    mqtt.simulateIncoming('layout/test/sensor/s2/reading', { garbage: true });
    await new Promise((r) => setImmediate(r));

    for (let i = 0; i < 3; i++) {
      mqtt.simulateIncoming('layout/test/sensor/s1/reading', validReading());
      await new Promise((r) => setImmediate(r));
    }
    await service.acknowledgeSensorFault('test', 's1');

    expect(service.getSystemStatus().status).toBe('safe-stop');
    expect(service.getSensorFaults().map((f) => f.sensorId)).toEqual(['s2']);

    await service.stop();
  });

  it('out-of-service clears the fault and Safe-Stop, and unsubscribes the sensor', async () => {
    const { service, mqtt } = await buildStartedService();
    await faultSensor(mqtt);
    expect(service.getSystemStatus().status).toBe('safe-stop');

    await service.updateSensorConfig('test', 's1', { inService: false });

    expect(service.getSystemStatus().status).toBe('online');
    expect(service.getSensorFaults()).toEqual([]);

    // A malformed payload on the (now unsubscribed) topic must not re-trip.
    mqtt.simulateIncoming(SENSOR_TOPIC, { garbage: true });
    await new Promise((r) => setImmediate(r));
    expect(service.getSystemStatus().status).toBe('online');

    await service.stop();
  });

  it('an IR fault with the detector in service leaves occupancy unaffected', async () => {
    const repo = makeRepo();
    vi.mocked(repo.listSensors).mockResolvedValue([
      SENSOR_S1,
      {
        id: 's-ir',
        layoutId: 'test',
        name: 'IR 1',
        type: 'ir_position',
        blockId: 'b1',
        mqttTopic: 'layout/test/sensor/s-ir/reading',
        inService: true,
      },
    ]);
    const { service, mqtt, stateManager } = await buildStartedServiceFrom(repo);

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', validReading());
    await new Promise((r) => setImmediate(r));
    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');

    mqtt.simulateIncoming('layout/test/sensor/s-ir/reading', { garbage: true });
    await new Promise((r) => setImmediate(r));

    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');
    expect(service.getSystemStatus().status).toBe('safe-stop'); // the fault itself still trips Safe-Stop

    await service.stop();
  });

  it('a detector fault with the IR in service yields unknown — IR cannot assert clear', async () => {
    const repo = makeRepo();
    vi.mocked(repo.listSensors).mockResolvedValue([
      SENSOR_S1,
      {
        id: 's-ir',
        layoutId: 'test',
        name: 'IR 1',
        type: 'ir_position',
        blockId: 'b1',
        mqttTopic: 'layout/test/sensor/s-ir/reading',
        inService: true,
      },
    ]);
    const { mqtt, stateManager } = await buildStartedServiceFrom(repo);

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', validReading());
    await new Promise((r) => setImmediate(r));
    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');

    // The IR sensor is in service and reporting — a 'clear' from it must
    // still be discarded for occupancy purposes (D3 clause 3), so the block
    // stays 'occupied' on the detector's word alone at this point.
    mqtt.simulateIncoming('layout/test/sensor/s-ir/reading', {
      state: 'clear',
      updatedAt: new Date().toISOString(),
    });
    await new Promise((r) => setImmediate(r));
    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', { garbage: true });
    await new Promise((r) => setImmediate(r));

    // With the detector faulted, only the in-service IR's 'clear' remains —
    // and D3 clause 2 only ever looks at block_detection sensors, so it
    // cannot rescue the block. Fail-safe 'unknown', not 'clear'.
    expect(stateManager.getBlock('b1')?.occupancy).toBe('unknown');
  });

  async function buildStartedServiceFrom(repo: ILayoutRepository) {
    const dcc = new SimulatedDccAdapter(silentLogger);
    const mqtt = new SimulatedMqttAdapter();
    const stateManager = new LayoutStateManager('test');
    const reservations = new ReservationService(repo, stateManager, silentLogger);
    const service = new LayoutService(dcc, mqtt, repo, stateManager, reservations, silentLogger);
    await service.start('test');
    return { service, dcc, mqtt, repo, stateManager, reservations };
  }
});

describe('LayoutService — topology', () => {
  const selfLoopEdge: BlockEdge = {
    id: 'e-loop',
    layoutId: 'test',
    fromBlockId: 'b1',
    fromEnd: 'north',
    toBlockId: 'b1',
    toEnd: 'south',
    pointConditions: [],
    lengthMm: null,
  };

  function buildService(repo: ILayoutRepository) {
    const dcc = new SimulatedDccAdapter(silentLogger);
    const mqtt = new SimulatedMqttAdapter();
    const stateManager = new LayoutStateManager('test');
    const reservations = new ReservationService(repo, stateManager, silentLogger);
    const service = new LayoutService(dcc, mqtt, repo, stateManager, reservations, silentLogger);
    return { service, dcc, mqtt };
  }

  it('resolves start(), enters safe-stop, and leaves the graph null when a self-loop edge exists at boot', async () => {
    const repo = makeRepo();
    vi.mocked(repo.listBlockEdges).mockResolvedValue([selfLoopEdge]);
    const { service } = buildService(repo);

    await expect(service.start('test')).resolves.toBeUndefined();

    expect(service.getSystemStatus().status).toBe('safe-stop');
    expect(service.getSystemStatus().reason).toMatch(/self-loop/i);
    expect(service.getTrackGraph()).toBeNull();

    await service.stop();
  });

  it('does not clear safe-stop on an MQTT reconnect while the topology is still invalid (regression guard for #10)', async () => {
    const repo = makeRepo();
    vi.mocked(repo.listBlockEdges).mockResolvedValue([selfLoopEdge]);
    const { service, mqtt } = buildService(repo);

    await service.start('test');
    expect(service.getSystemStatus().status).toBe('safe-stop');

    // Simulate the MQTT broker dropping and reconnecting — connection health
    // recovers, but nothing has fixed the topology.
    await mqtt.disconnect();
    await new Promise((r) => setImmediate(r));
    await mqtt.connect();
    await new Promise((r) => setImmediate(r));

    expect(service.getSystemStatus().status).toBe('safe-stop');
    expect(service.getSystemStatus().reason).toMatch(/self-loop/i);

    await service.stop();
  });

  it('enters safe-stop without crashing when the repository throws BlockEdgeRowInvalidError', async () => {
    const repo = makeRepo();
    vi.mocked(repo.listBlockEdges).mockRejectedValue(new BlockEdgeRowInvalidError('e1', []));
    const { service } = buildService(repo);

    await expect(service.start('test')).resolves.toBeUndefined();
    expect(service.getSystemStatus().status).toBe('safe-stop');
    expect(service.getTrackGraph()).toBeNull();

    await service.stop();
  });

  it('lets a generic repository error propagate — start() rejects, proving the catch in loadTopology is narrow', async () => {
    const repo = makeRepo();
    vi.mocked(repo.listBlockEdges).mockRejectedValue(new Error('DB exploded'));
    const { service } = buildService(repo);

    await expect(service.start('test')).rejects.toThrow('DB exploded');
  });

  it('builds the track graph and stays online when the topology is valid', async () => {
    const repo = makeRepo();
    vi.mocked(repo.listBlocks).mockResolvedValue([
      { id: 'b1', layoutId: 'test', name: 'Block 1' },
      { id: 'b2', layoutId: 'test', name: 'Block 2' },
    ]);
    vi.mocked(repo.listBlockEdges).mockResolvedValue([
      {
        id: 'e1',
        layoutId: 'test',
        fromBlockId: 'b1',
        fromEnd: 'east',
        toBlockId: 'b2',
        toEnd: 'west',
        pointConditions: [],
        lengthMm: null,
      },
    ]);
    const { service } = buildService(repo);

    await service.start('test');

    expect(service.getSystemStatus().status).toBe('online');
    expect(service.getTrackGraph()?.edges.size).toBe(1);

    await service.stop();
  });
});

describe('LayoutService — safe-stop on connection loss', () => {
  it('enters safe-stop when MQTT disconnects', async () => {
    const { service, mqtt } = await buildStartedService();

    // Simulate broker going offline
    (mqtt as SimulatedMqttAdapter).disconnect();
    await new Promise((r) => setImmediate(r));

    expect(service.getSystemStatus().status).toBe('safe-stop');
    await service.stop();
  });

  it('suspends an active route (retaining its locks) when Safe-Stop is entered, per D8', async () => {
    const { service, mqtt, stateManager } = await buildStartedServiceWithGraph();
    const grant = await service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: ['e1'] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');

    (mqtt as SimulatedMqttAdapter).disconnect();
    await new Promise((r) => setImmediate(r));

    expect(service.getSystemStatus().status).toBe('safe-stop');
    const suspended = service.listRoutes(['suspended']).find((r) => r.id === grant.reservation.id);
    expect(suspended).toBeDefined();
    // Locks retained.
    expect(stateManager.getBlock('b2')?.lockedByRoute).toBe(grant.reservation.id);

    await service.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gaps in the compiled graph gate automatic modes (#103, D6/D-C).
 *
 * The property is narrow and worth stating plainly: a gappy graph refuses
 * *new* automatic authority, and withdraws authority the graph can no longer
 * support — and does **neither** by halting the layout. A refused mode change
 * is an ordinary rejection. A Safe-Stop is what happens when a train's position
 * is in doubt, and an unfinished drawing is not that.
 */
describe('LayoutService — the compiled graph gates automatic modes (#103)', () => {
  /** A started service whose compiled graph reports `gaps` holes. */
  async function withGaps(gaps: number) {
    const dcc = new SimulatedDccAdapter(silentLogger);
    const mqtt = new SimulatedMqttAdapter();
    const repo = makeRepo();
    const stateManager = new LayoutStateManager('test');
    const reservations = new ReservationService(repo, stateManager, silentLogger);
    const gapCount = vi.fn().mockResolvedValue(gaps);
    const service = new LayoutService(
      dcc,
      mqtt,
      repo,
      stateManager,
      reservations,
      silentLogger,
      undefined,
      undefined,
      { gapCount },
    );
    await service.start('test');
    return { service, stateManager, gapCount };
  }

  it('permits auto when the graph has no gaps', async () => {
    const { service, stateManager } = await withGaps(0);

    await service.handleSetMode({ mode: 'auto' });

    expect(stateManager.getState().systemMode).toBe('auto');
    await service.stop();
  });

  it('refuses auto when the graph has gaps, naming the count', async () => {
    const { service, stateManager } = await withGaps(3);

    await expect(service.handleSetMode({ mode: 'auto' })).rejects.toThrow(/3 gaps/);

    expect(stateManager.getState().systemMode).toBe('manual');
    // Not a Safe-Stop. Nothing about the railway has gone wrong; the operator
    // asked for an authority the graph cannot support and was told no.
    expect(service.getSystemStatus().status).toBe('online');
    await service.stop();
  });

  it('refuses hybrid too, because it can issue automated commands', async () => {
    // D6 names only `auto`, but `canIssueAutoCommand` returns true for `hybrid`,
    // so gating `auto` alone would leave the automated path open through the
    // side door.
    const { service, stateManager } = await withGaps(1);

    await expect(service.handleSetMode({ mode: 'hybrid' })).rejects.toThrow(/1 gap\b/);

    expect(stateManager.getState().systemMode).toBe('manual');
    await service.stop();
  });

  it('never gates manual, whatever the graph looks like', async () => {
    // Manual is the mode an operator drops into in order to *fix* things.
    // Gating it would be a trap with no way out.
    const { service, stateManager } = await withGaps(99);

    await service.handleSetMode({ mode: 'manual' });

    expect(stateManager.getState().systemMode).toBe('manual');
    await service.stop();
  });

  it('does not consult the compiler for a manual mode change', async () => {
    const { service, gapCount } = await withGaps(0);
    gapCount.mockClear();

    await service.handleSetMode({ mode: 'manual' });

    expect(gapCount).not.toHaveBeenCalled();
    await service.stop();
  });

  it('drops an auto mode to manual when a reload leaves the graph gappy', async () => {
    // The gate covers *entering* an automatic mode; this covers the graph
    // changing underneath one. Applying a compile that leaves holes, or
    // deleting a block, does exactly that while the layout is already in auto.
    const { service, stateManager, gapCount } = await withGaps(0);
    await service.handleSetMode({ mode: 'auto' });
    expect(stateManager.getState().systemMode).toBe('auto');

    gapCount.mockResolvedValue(2);
    await service.reloadTopology();

    expect(stateManager.getState().systemMode).toBe('manual');
    // Authority removed, layout still running — not a Safe-Stop and not a fault
    // latch. D9 forbids a compile from being able to halt a railway.
    expect(service.getSystemStatus().status).toBe('online');
    await service.stop();
  });

  it('leaves an auto mode alone when a reload finds no gaps', async () => {
    const { service, stateManager } = await withGaps(0);
    await service.handleSetMode({ mode: 'auto' });

    await service.reloadTopology();

    expect(stateManager.getState().systemMode).toBe('auto');
    await service.stop();
  });

  it('leaves a manual mode alone on a gappy reload, and does not ask', async () => {
    const { service, stateManager, gapCount } = await withGaps(4);
    gapCount.mockClear();

    await service.reloadTopology();

    expect(stateManager.getState().systemMode).toBe('manual');
    // Already manual: there is no authority to withdraw, so there is nothing
    // worth asking about.
    expect(gapCount).not.toHaveBeenCalled();
    await service.stop();
  });

  it('gates nothing when no compiler is wired', async () => {
    // The inert default. An unwired service has been told nothing about
    // completeness, and refusing on that basis would be reporting a limitation
    // nobody stated.
    const { service, stateManager } = await buildStartedService();

    await service.handleSetMode({ mode: 'auto' });

    expect(stateManager.getState().systemMode).toBe('auto');
    await service.stop();
  });
});
