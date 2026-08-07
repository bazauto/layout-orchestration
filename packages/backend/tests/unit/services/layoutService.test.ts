import { describe, it, expect, vi } from 'vitest';
import { LayoutService, PointLockedError } from '../../../src/services/LayoutService';
import { ReservationService } from '../../../src/services/ReservationService';
import { LayoutStateManager } from '../../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository, LocoRecord } from '../../../src/ports/ILayoutRepository';
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

function makeRepo(): ILayoutRepository {
  const reservations = new Map<
    string,
    { row: Omit<RouteReservation, 'holds'>; holds: Map<string, RouteReservation['holds'][number]> }
  >();

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
      { id: 'p1', layoutId: 'test', name: 'Point 1', dccAddress: 10, blockId: 'b1' },
    ]),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn().mockResolvedValue([
      {
        id: 's1',
        layoutId: 'test',
        name: 'Sensor 1',
        type: 'block_detection',
        blockId: 'b1',
        mqttTopic: 'layout/test/sensor/s1/reading',
      },
    ]),
    createSensor: vi.fn(),
    deleteSensor: vi.fn(),
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
      edgeIds: ['e1'],
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
      edgeIds: ['e1'],
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

    await service.handlePointCommand({ pointId: 'p1', position: 'reverse' });

    expect(dcc.commandLog).toHaveLength(1);
    expect(dcc.commandLog[0].type).toBe('SET_POINT');
    expect(stateManager.getPoint('p1')?.position).toBe('reverse');
    await service.stop();
  });

  it('rejects a command on a locked point without force, with a typed PointLockedError', async () => {
    const { service } = await buildStartedServiceWithGraph();
    const grant = await service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      edgeIds: ['e1'],
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
      edgeIds: ['e1'],
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
    expect(stateManager.getPoint('p1')?.position).toBe('reverse');
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
      edgeIds: ['e1'],
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

  it('does not un-mutate an already-tracked block on a later malformed reading for the same sensor', async () => {
    const { service, mqtt, stateManager } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', {
      state: 'occupied',
      updatedAt: new Date().toISOString(),
    });
    await new Promise((r) => setImmediate(r));
    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', { badField: 'nonsense' });
    await new Promise((r) => setImmediate(r));

    // The last known-good occupancy must survive the malformed message.
    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');
    expect(service.getSystemStatus().status).toBe('safe-stop');

    await service.stop();
  });
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
      edgeIds: ['e1'],
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
