import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { ReservationService } from '../../../src/services/ReservationService';
import { LayoutStateManager } from '../../../src/domain/layoutState';
import { buildTrackGraph } from '../../../src/domain/graph';
import { ILayoutRepository, LocoRecord } from '../../../src/ports/ILayoutRepository';
import { BlockEdge, RouteHoldKind, RouteReservation, RouteStatus } from '../../../src/domain/types';

const LAYOUT = 'layout-1';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function edge(overrides: Partial<BlockEdge> = {}): BlockEdge {
  return {
    id: 'e1',
    layoutId: LAYOUT,
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [],
    lengthMm: null,
    ...overrides,
  };
}

/** Three-block chain b1 -[e1, point p1=normal]-> b2 -[e2]-> b3. */
function threeBlockGraph() {
  const edges = [
    edge({
      id: 'e1',
      fromBlockId: 'b1',
      fromEnd: 'east',
      toBlockId: 'b2',
      toEnd: 'west',
      pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
    }),
    edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west' }),
  ];
  return buildTrackGraph(LAYOUT, edges);
}

/**
 * Minimal but real in-memory ILayoutRepository — reservation methods store
 * actual state (so tests can assert on what was persisted, not just that a
 * mock was called), other methods are unused stubs. Mirrors the fakes in
 * tests/scenario/harness.ts and tests/integration/edges.test.ts.
 */
function makeRepo(locos: LocoRecord[] = []): ILayoutRepository {
  const reservations = new Map<string, { row: Omit<RouteReservation, 'holds'>; holds: Map<string, RouteReservation['holds'][number]> }>();

  function toReservation(id: string): RouteReservation {
    const entry = reservations.get(id);
    if (!entry) throw new Error(`not found: ${id}`);
    return { ...entry.row, holds: [...entry.holds.values()] };
  }

  return {
    listLayouts: vi.fn(),
    getLayout: vi.fn(),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn().mockResolvedValue(locos),
    getLoco: vi.fn(),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([]),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn().mockResolvedValue([]),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn(),
    createSensor: vi.fn(),
    updateSensor: vi.fn(),
    deleteSensor: vi.fn(),
    listGridTiles: vi.fn(),
    upsertGridTile: vi.fn(),
    deleteTile: vi.fn(),
    clearGrid: vi.fn(),
    listBlockEdges: vi.fn().mockResolvedValue([]),
    getBlockEdge: vi.fn(),
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),

    listReservations: vi.fn().mockImplementation(async (layoutId: string, statuses?: RouteStatus[]) =>
      [...reservations.keys()]
        .map(toReservation)
        .filter((r) => r.layoutId === layoutId && (!statuses || statuses.includes(r.status))),
    ),
    getReservation: vi.fn().mockImplementation(async (id: string) =>
      reservations.has(id) ? toReservation(id) : null,
    ),
    createReservation: vi.fn().mockImplementation(async (data: Omit<RouteReservation, 'createdAt' | 'updatedAt'>) => {
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

/** Registers the three-block layout's blocks/points into `stateManager` and marks b1 occupied by `locoAddress` (D13's grant precondition). */
function seedState(stateManager: LayoutStateManager, locoAddress = 3) {
  stateManager.registerBlock('b1');
  stateManager.registerBlock('b2');
  stateManager.registerBlock('b3');
  stateManager.registerPoint('p1');
  stateManager.updateBlockOccupancy('b1', 'occupied', locoAddress);
  stateManager.updateBlockOccupancy('b2', 'clear');
  stateManager.updateBlockOccupancy('b3', 'clear');
}

async function grantThreeBlockRoute(service: ReservationService, stateManager: LayoutStateManager) {
  seedState(stateManager);
  const graph = threeBlockGraph();
  return service.grant(
    LAYOUT,
    { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1', 'e2'] },
    graph,
  );
}

function makeService(locos: LocoRecord[] = [{ id: 'loco-1', layoutId: LAYOUT, name: 'Loco 3', address: 3, type: 'diesel', maxSpeed: 126, brakingFactor: 0.5 }]) {
  const repo = makeRepo(locos);
  const stateManager = new LayoutStateManager(LAYOUT);
  stateManager.setOnline();
  const service = new ReservationService(repo, stateManager, silentLogger);
  return { repo, stateManager, service };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReservationService — grant', () => {
  it('grants a valid route, locks blocks/points, and persists the reservation', async () => {
    const { service, stateManager, repo } = makeService();
    const outcome = await grantThreeBlockRoute(service, stateManager);

    expect(outcome.granted).toBe(true);
    if (!outcome.granted) throw new Error('expected grant');

    expect(stateManager.getBlock('b1')?.lockedByRoute).toBe(outcome.reservation.id);
    expect(stateManager.getBlock('b2')?.lockedByRoute).toBe(outcome.reservation.id);
    expect(stateManager.getBlock('b3')?.lockedByRoute).toBe(outcome.reservation.id);
    expect(stateManager.getPoint('p1')?.lockedByRoute).toBe(outcome.reservation.id);
    expect(stateManager.getPoint('p1')?.locked).toBe(true);
    expect(repo.createReservation).toHaveBeenCalledTimes(1);

    const persisted = await repo.getReservation(outcome.reservation.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe('active');
  });

  it('a rejected grant leaves ZERO locks set and ZERO rows persisted (the atomicity assertion)', async () => {
    const { service, stateManager, repo } = makeService();
    // b1 is 'clear', not 'occupied' — start-block-not-occupied rejection.
    stateManager.registerBlock('b1');
    stateManager.registerBlock('b2');
    stateManager.registerBlock('b3');
    stateManager.registerPoint('p1');
    stateManager.updateBlockOccupancy('b1', 'clear');
    stateManager.updateBlockOccupancy('b2', 'clear');
    stateManager.updateBlockOccupancy('b3', 'clear');

    const graph = threeBlockGraph();
    const outcome = await service.grant(
      LAYOUT,
      { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1', 'e2'] },
      graph,
    );

    expect(outcome.granted).toBe(false);
    if (outcome.granted) throw new Error('expected rejection');
    expect(outcome.rejections.length).toBeGreaterThan(0);

    // Zero locks.
    expect(stateManager.getBlock('b1')?.lockedByRoute).toBeNull();
    expect(stateManager.getBlock('b2')?.lockedByRoute).toBeNull();
    expect(stateManager.getBlock('b3')?.lockedByRoute).toBeNull();
    expect(stateManager.getPoint('p1')?.lockedByRoute).toBeNull();
    // Zero rows persisted.
    expect(repo.createReservation).not.toHaveBeenCalled();
    expect(stateManager.listRoutes()).toEqual([]);
  });

  it('rejects a second grant for a loco that already has an active route', async () => {
    const { service, stateManager } = makeService();
    const first = await grantThreeBlockRoute(service, stateManager);
    expect(first.granted).toBe(true);

    const graph = threeBlockGraph();
    const second = await service.grant(
      LAYOUT,
      { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1'] },
      graph,
    );
    expect(second.granted).toBe(false);
    if (second.granted) throw new Error('expected rejection');
    expect(second.rejections).toContainEqual(
      expect.objectContaining({ kind: 'loco-already-routed' }),
    );
  });
});

describe('ReservationService — cancel', () => {
  it('releases every hold and clears every projection field', async () => {
    const { service, stateManager } = makeService();
    const outcome = await grantThreeBlockRoute(service, stateManager);
    if (!outcome.granted) throw new Error('expected grant');

    const result = await service.cancel(LAYOUT, outcome.reservation.id, 'operator cancel');

    expect(result.reservation?.status).toBe('cancelled');
    expect(result.reservation?.holds.every((h) => h.released)).toBe(true);
    expect(stateManager.getBlock('b1')?.lockedByRoute).toBeNull();
    expect(stateManager.getBlock('b2')?.lockedByRoute).toBeNull();
    expect(stateManager.getBlock('b3')?.lockedByRoute).toBeNull();
    expect(stateManager.getPoint('p1')?.lockedByRoute).toBeNull();
    expect(stateManager.getPoint('p1')?.locked).toBe(false);
  });

  it('throws RouteNotFoundError for an unknown route id', async () => {
    const { service } = makeService();
    await expect(service.cancel(LAYOUT, 'ghost-route', null)).rejects.toThrow(/not found/i);
  });
});

describe('ReservationService — suspendAll / suspendAuto', () => {
  it('suspendAll retains locks while flipping status to suspended', async () => {
    const { service, stateManager } = makeService();
    const outcome = await grantThreeBlockRoute(service, stateManager);
    if (!outcome.granted) throw new Error('expected grant');

    const suspended = await service.suspendAll(LAYOUT, 'MQTT broker disconnected');

    expect(suspended).toHaveLength(1);
    expect(suspended[0].reservation?.status).toBe('suspended');
    // Locks retained — D8.
    expect(stateManager.getBlock('b1')?.lockedByRoute).toBe(outcome.reservation.id);
    expect(stateManager.getBlock('b2')?.lockedByRoute).toBe(outcome.reservation.id);
    expect(stateManager.getPoint('p1')?.lockedByRoute).toBe(outcome.reservation.id);
  });

  it('suspendAuto only suspends auto-authority routes, leaving manual-authority routes active', async () => {
    const { service, stateManager } = makeService();
    seedState(stateManager);
    const graph = threeBlockGraph();
    const manualOutcome = await service.grant(
      LAYOUT,
      { locoAddress: 3, authority: 'manual', startBlockId: 'b1', edgeIds: ['e1', 'e2'] },
      graph,
    );
    if (!manualOutcome.granted) throw new Error('expected grant');

    const suspended = await service.suspendAuto(LAYOUT, 'mode -> manual');

    expect(suspended).toHaveLength(0);
    const cached = service.getRoute(LAYOUT, manualOutcome.reservation.id);
    expect(cached?.status).toBe('active');
  });
});

describe('ReservationService — resume', () => {
  async function grantAndSuspend(service: ReservationService, stateManager: LayoutStateManager) {
    const outcome = await grantThreeBlockRoute(service, stateManager);
    if (!outcome.granted) throw new Error('expected grant');
    await service.suspendAll(LAYOUT, 'MQTT broker disconnected');
    return outcome.reservation;
  }

  it('resumes when the current block reads occupied and every remaining block reads clear', async () => {
    const { service, stateManager } = makeService();
    const reservation = await grantAndSuspend(service, stateManager);

    const result = await service.resume(LAYOUT, reservation.id);
    expect(result.resumed).toBe(true);
    if (!result.resumed) throw new Error('expected resume');
    expect(result.reservation.status).toBe('active');
    expect(result.pointsToRecommand.map((h) => h.targetId)).toContain('p1');
  });

  it('refuses to resume when a remaining block reads unknown (fail-safe)', async () => {
    const { service, stateManager } = makeService();
    const reservation = await grantAndSuspend(service, stateManager);

    // b2 drops to 'unknown' — a detection dropout while suspended.
    stateManager.updateBlockOccupancy('b2', 'unknown');

    const result = await service.resume(LAYOUT, reservation.id);
    expect(result.resumed).toBe(false);
    if (result.resumed) throw new Error('expected refusal');
    expect(result.reason).toMatch(/unknown/i);
  });

  it('refuses to resume a route that is not suspended', async () => {
    const { service, stateManager } = makeService();
    const outcome = await grantThreeBlockRoute(service, stateManager);
    if (!outcome.granted) throw new Error('expected grant');

    const result = await service.resume(LAYOUT, outcome.reservation.id);
    expect(result.resumed).toBe(false);
  });
});

describe('ReservationService — onOccupancyChange', () => {
  it('advances confirmedIndex on progress into the next expected block', async () => {
    const { service, stateManager } = makeService();
    const outcome = await grantThreeBlockRoute(service, stateManager);
    if (!outcome.granted) throw new Error('expected grant');

    const result = await service.onOccupancyChange(LAYOUT, 'b2', 'occupied', 'clear');
    expect(result.reservation?.confirmedIndex).toBe(1);
    expect(result.unexpectedOccupancy).toBe(false);
  });

  it('reports unexpectedOccupancy and cancels the route for a non-adjacent path block', async () => {
    const { service, stateManager } = makeService();
    const outcome = await grantThreeBlockRoute(service, stateManager);
    if (!outcome.granted) throw new Error('expected grant');

    // Train is confirmed at b1 (index 0); b3 (index 2) is not the next
    // expected step (b2, index 1) — a manual train entering track the
    // system did not expect it in.
    const result = await service.onOccupancyChange(LAYOUT, 'b3', 'occupied', 'clear');

    expect(result.unexpectedOccupancy).toBe(true);
    expect(result.reservation?.status).toBe('cancelled');
    expect(stateManager.getBlock('b1')?.lockedByRoute).toBeNull();
    expect(stateManager.getBlock('b2')?.lockedByRoute).toBeNull();
    expect(stateManager.getBlock('b3')?.lockedByRoute).toBeNull();
  });

  it('releases holds progressively as the train advances and the block behind clears', async () => {
    const { service, stateManager } = makeService();
    const outcome = await grantThreeBlockRoute(service, stateManager);
    if (!outcome.granted) throw new Error('expected grant');

    await service.onOccupancyChange(LAYOUT, 'b2', 'occupied', 'clear'); // confirmedIndex -> 1
    const releaseResult = await service.onOccupancyChange(LAYOUT, 'b1', 'clear', 'occupied');

    expect(releaseResult.changedBlocks.map((b) => b.blockId)).toContain('b1');
    expect(stateManager.getBlock('b1')?.lockedByRoute).toBeNull();
    // b2/b3 (ahead) stay locked.
    expect(stateManager.getBlock('b2')?.lockedByRoute).toBe(outcome.reservation.id);
    expect(stateManager.getBlock('b3')?.lockedByRoute).toBe(outcome.reservation.id);
    // The point gating e1 (wholly behind b1) releases too.
    expect(stateManager.getPoint('p1')?.lockedByRoute).toBeNull();
  });

  it('returns a null reservation and ignores a block held by no route', async () => {
    const { service } = makeService();
    const result = await service.onOccupancyChange(LAYOUT, 'unheld-block', 'occupied', 'clear');
    expect(result.reservation).toBeNull();
    expect(result.unexpectedOccupancy).toBe(false);
  });
});

describe('ReservationService — IRouteLockView', () => {
  it('reports the holding route for a locked block/point/edge, and null once released', async () => {
    const { service, stateManager } = makeService();
    const outcome = await grantThreeBlockRoute(service, stateManager);
    if (!outcome.granted) throw new Error('expected grant');

    expect(service.findRouteHoldingBlock(LAYOUT, 'b2')).toBe(outcome.reservation.id);
    expect(service.findRouteHoldingPoint(LAYOUT, 'p1')).toBe(outcome.reservation.id);
    expect(service.findRouteHoldingEdge(LAYOUT, 'e1')).toBe(outcome.reservation.id);
    expect(service.findRouteHoldingBlock(LAYOUT, 'unheld')).toBeNull();

    await service.cancel(LAYOUT, outcome.reservation.id, 'test cleanup');
    expect(service.findRouteHoldingBlock(LAYOUT, 'b2')).toBeNull();
  });
});

describe('ReservationService — loadOnStartup', () => {
  it('revives an active/suspended reservation as suspended with a restart reason, re-applying its locks', async () => {
    const { repo, stateManager: writerState } = makeService();
    const writerService = new ReservationService(repo, writerState, silentLogger);
    const outcome = await grantThreeBlockRoute(writerService, writerState);
    if (!outcome.granted) throw new Error('expected grant');

    // A fresh process: new LayoutStateManager, same repo (persisted data survives).
    const freshState = new LayoutStateManager(LAYOUT);
    freshState.setOnline();
    freshState.registerBlock('b1');
    freshState.registerBlock('b2');
    freshState.registerBlock('b3');
    freshState.registerPoint('p1');
    const freshService = new ReservationService(repo, freshState, silentLogger);

    const { recovered } = await freshService.loadOnStartup(LAYOUT);

    expect(recovered).toHaveLength(1);
    expect(recovered[0].status).toBe('suspended');
    expect(recovered[0].reason).toBe('backend restarted');
    expect(freshState.getBlock('b1')?.lockedByRoute).toBe(outcome.reservation.id);
    expect(freshState.getPoint('p1')?.lockedByRoute).toBe(outcome.reservation.id);
  });

  it('recovers nothing from a clean shutdown (no active/suspended routes)', async () => {
    const { service, stateManager } = makeService();
    const { recovered } = await service.loadOnStartup(LAYOUT);
    expect(recovered).toEqual([]);
    void stateManager;
  });
});
