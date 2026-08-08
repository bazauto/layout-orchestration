import { describe, it, expect, vi } from 'vitest';
import { BrakingService } from '../../../src/services/BrakingService';
import { LayoutStateManager } from '../../../src/domain/layoutState';
import { buildTrackGraph } from '../../../src/domain/graph';
import { ILayoutRepository, LocoRecord } from '../../../src/ports/ILayoutRepository';
import { BlockEdge, RoutePathStep, RouteReservation } from '../../../src/domain/types';

const LAYOUT = 'layout-1';
const NOW = new Date('2026-08-08T00:00:00Z');

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function loco(overrides: Partial<LocoRecord> = {}): LocoRecord {
  return {
    id: 'loco-1',
    layoutId: LAYOUT,
    name: 'Class 08',
    address: 3,
    type: 'diesel-shunter',
    maxSpeed: 126,
    brakingFactor: 0.5,
    ...overrides,
  };
}

/**
 * Every `ILayoutRepository` method as a `vi.fn()` stub, so a test can assert
 * none of the write methods were ever called (BrakingService is
 * planning-only). `listLocos` is the one method BrakingService actually
 * reads from.
 */
function makeRepo(locos: LocoRecord[] = []): ILayoutRepository {
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
    listBlocks: vi.fn(),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn(),
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
    listBlockEdges: vi.fn(),
    getBlockEdge: vi.fn(),
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),
    listReservations: vi.fn(),
    getReservation: vi.fn(),
    createReservation: vi.fn(),
    updateReservation: vi.fn(),
    markHoldsReleased: vi.fn(),
  };
}

/** Every write-ish method on the fake repo — asserted uncalled after a refusal. */
function expectRepoUntouched(repo: ILayoutRepository): void {
  expect(repo.createLoco).not.toHaveBeenCalled();
  expect(repo.updateLoco).not.toHaveBeenCalled();
  expect(repo.deleteLoco).not.toHaveBeenCalled();
  expect(repo.createReservation).not.toHaveBeenCalled();
  expect(repo.updateReservation).not.toHaveBeenCalled();
  expect(repo.markHoldsReleased).not.toHaveBeenCalled();
}

function edge(overrides: Partial<BlockEdge> & Pick<BlockEdge, 'id'>): BlockEdge {
  return {
    layoutId: LAYOUT,
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [],
    lengthMm: 500,
    ...overrides,
  };
}

/** b1 -[e1]-> b2 -[e2]-> b3, 500mm each unless overridden. */
function threeBlockEdges(overrides: Partial<Record<'e1' | 'e2', Partial<BlockEdge>>> = {}): BlockEdge[] {
  return [
    edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west', ...overrides.e1 }),
    edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west', ...overrides.e2 }),
  ];
}

function pathStep(overrides: Partial<RoutePathStep> & Pick<RoutePathStep, 'blockId'>): RoutePathStep {
  return { edgeId: null, entryEnd: null, exitEnd: null, ...overrides };
}

function threeBlockPath(): RoutePathStep[] {
  return [
    pathStep({ blockId: 'b1', exitEnd: 'east' }),
    pathStep({ blockId: 'b2', edgeId: 'e1', entryEnd: 'west', exitEnd: 'east' }),
    pathStep({ blockId: 'b3', edgeId: 'e2', entryEnd: 'west' }),
  ];
}

function reservation(overrides: Partial<RouteReservation> = {}): RouteReservation {
  return {
    id: 'route-1',
    layoutId: LAYOUT,
    locoAddress: 3,
    authority: 'auto',
    status: 'active',
    path: threeBlockPath(),
    holds: [],
    confirmedIndex: 0,
    reason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

// ─── planStop ──────────────────────────────────────────────────────────────

describe('BrakingService.planStop', () => {
  it('plans an unconstrained stop from the loco current commanded speed (B8)', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStop(LAYOUT, 3);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.locoAddress).toBe(3);
    expect(result.schedule.steps[result.schedule.steps.length - 1]).toEqual({
      atOffsetMs: expect.any(Number),
      speedStep: 0,
      direction: 'stop',
    });
    expectRepoUntouched(repo);
  });

  it('refuses a loco absent from the roster', async () => {
    const repo = makeRepo([]);
    const stateManager = new LayoutStateManager(LAYOUT);

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStop(LAYOUT, 3);

    expect(result).toEqual({ ok: false, reason: { kind: 'unknown-loco', locoAddress: 3 } });
    expectRepoUntouched(repo);
  });
});

// ─── planStopAtRouteBoundary ─────────────────────────────────────────────────

describe('BrakingService.planStopAtRouteBoundary', () => {
  it('plans a stop whose requiredDistanceMm fits within the summed edge lengths', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const graph = buildTrackGraph(LAYOUT, threeBlockEdges());

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), graph);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // e1 + e2 = 1000mm of measured track between the confirmed block and the destination.
    expect(result.schedule.requiredDistanceMm).toBeLessThanOrEqual(1000);
    expectRepoUntouched(repo);
  });

  // ── Failure paths ────────────────────────────────────────────────────────

  it('refuses a loco absent from the roster', async () => {
    const repo = makeRepo([]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const graph = buildTrackGraph(LAYOUT, threeBlockEdges());

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), graph);

    expect(result).toEqual({ ok: false, reason: { kind: 'unknown-loco', locoAddress: 3 } });
    expectRepoUntouched(repo);
  });

  it('refuses when two roster rows share the requested address', async () => {
    const repo = makeRepo([loco({ id: 'a' }), loco({ id: 'b' })]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const graph = buildTrackGraph(LAYOUT, threeBlockEdges());

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), graph);

    expect(result).toEqual({ ok: false, reason: { kind: 'ambiguous-loco', locoAddress: 3, count: 2 } });
    expectRepoUntouched(repo);
  });

  it('refuses a loco with no known LocoState', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    // Deliberately never calling stateManager.updateLoco(3, ...).
    const graph = buildTrackGraph(LAYOUT, threeBlockEdges());

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), graph);

    expect(result).toEqual({ ok: false, reason: { kind: 'unknown-loco-state', locoAddress: 3 } });
    expectRepoUntouched(repo);
  });

  it('refuses a suspended route', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const graph = buildTrackGraph(LAYOUT, threeBlockEdges());

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation({ status: 'suspended' }), graph);

    expect(result).toEqual({
      ok: false,
      reason: { kind: 'route-not-active', routeId: 'route-1', status: 'suspended' },
    });
    expectRepoUntouched(repo);
  });

  it('refuses a manual-authority route', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'manual' });
    const graph = buildTrackGraph(LAYOUT, threeBlockEdges());

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation({ authority: 'manual' }), graph);

    expect(result).toEqual({ ok: false, reason: { kind: 'manual-authority', routeId: 'route-1' } });
    expectRepoUntouched(repo);
  });

  it('refuses an unmeasured edge on the remaining stretch, without mutating state', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const graph = buildTrackGraph(LAYOUT, threeBlockEdges({ e2: { lengthMm: null } }));

    const service = new BrakingService(repo, stateManager, silentLogger);
    const before = stateManager.getLoco(3);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), graph);

    expect(result).toEqual({ ok: false, reason: { kind: 'unmeasured-track', edgeId: 'e2' } });
    expectRepoUntouched(repo);
    expect(stateManager.getLoco(3)).toEqual(before);
  });
});
