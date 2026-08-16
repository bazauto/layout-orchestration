import { describe, it, expect, vi } from 'vitest';
import { BrakingService } from '../../../src/services/BrakingService';
import { LayoutStateManager } from '../../../src/domain/layoutState';
import { buildTrackGraph } from '../../../src/domain/graph';
import { ILayoutRepository, LocoRecord } from '../../../src/ports/ILayoutRepository';
import { ManualClock } from '../../../src/adapters/clock/ManualClock';
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
    ...overrides,
  };
}

/** b1 -[e1]-> b2 -[e2]-> b3. Edges carry no length; blocks do (D4). */
function threeBlockEdges(): BlockEdge[] {
  return [
    edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
    edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west' }),
  ];
}

/**
 * b2 is the only block between the confirmed b1 and the b3 destination, so it
 * is the only one the remaining distance sums. 1000mm unless overridden;
 * `null` leaves it unmeasured.
 */
function threeBlockGraph(b2LengthMm: number | null = 1000) {
  const measured = new Map<string, number>([['b1', 500], ['b3', 500]]);
  if (b2LengthMm !== null) measured.set('b2', b2LengthMm);
  return buildTrackGraph(LAYOUT, threeBlockEdges(), measured);
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
  it('plans a stop whose requiredDistanceMm fits within the summed block lengths', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const graph = threeBlockGraph();

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), graph);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // b2 = 1000mm, the only block between the confirmed b1 and the b3 target.
    expect(result.schedule.requiredDistanceMm).toBeLessThanOrEqual(1000);
    expectRepoUntouched(repo);
  });

  // ── Failure paths ────────────────────────────────────────────────────────

  it('refuses a loco absent from the roster', async () => {
    const repo = makeRepo([]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const graph = threeBlockGraph();

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), graph);

    expect(result).toEqual({ ok: false, reason: { kind: 'unknown-loco', locoAddress: 3 } });
    expectRepoUntouched(repo);
  });

  it('refuses when two roster rows share the requested address', async () => {
    const repo = makeRepo([loco({ id: 'a' }), loco({ id: 'b' })]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const graph = threeBlockGraph();

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), graph);

    expect(result).toEqual({ ok: false, reason: { kind: 'ambiguous-loco', locoAddress: 3, count: 2 } });
    expectRepoUntouched(repo);
  });

  it('refuses a loco with no known LocoState', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    // Deliberately never calling stateManager.updateLoco(3, ...).
    const graph = threeBlockGraph();

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), graph);

    expect(result).toEqual({ ok: false, reason: { kind: 'unknown-loco-state', locoAddress: 3 } });
    expectRepoUntouched(repo);
  });

  it('refuses a suspended route', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const graph = threeBlockGraph();

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
    const graph = threeBlockGraph();

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation({ authority: 'manual' }), graph);

    expect(result).toEqual({ ok: false, reason: { kind: 'manual-authority', routeId: 'route-1' } });
    expectRepoUntouched(repo);
  });

  it('refuses an unmeasured block on the remaining stretch, without mutating state', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const graph = threeBlockGraph(null);

    const service = new BrakingService(repo, stateManager, silentLogger);
    const before = stateManager.getLoco(3);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), graph);

    expect(result).toEqual({ ok: false, reason: { kind: 'unmeasured-track', blockId: 'b2' } });
    expectRepoUntouched(repo);
    expect(stateManager.getLoco(3)).toEqual(before);
  });

  // ── B7's point-confirmation precondition (#25 landed, so this is live) ────

  /**
   * A route holding one point, required `reverse`. `feedback` selects the
   * point's configured `positionFeedback`, which is the whole difference
   * between the two cases below.
   */
  function reservationHoldingPoint(): RouteReservation {
    return reservation({
      holds: [
        { kind: 'point', targetId: 'p1', requiredPosition: 'reverse', releaseAfterIndex: 2, released: false },
      ],
    });
  }

  it("refuses a 'required' point that has not confirmed its position (B7)", async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    // Commanded reverse, but nothing has confirmed it — `effectivePosition`
    // for a 'required' point trusts `confirmedPosition` and nothing else.
    const registered = stateManager.registerPoint('p1', 'required', NOW);
    stateManager.setPointState('p1', { ...registered, commandedPosition: 'reverse', confirmation: 'pending' });

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservationHoldingPoint(), threeBlockGraph());

    expect(result).toEqual({
      ok: false,
      reason: {
        kind: 'point-not-confirmed',
        pointId: 'p1',
        requiredPosition: 'reverse',
        effectivePosition: 'unknown',
      },
    });
    expectRepoUntouched(repo);
  });

  it("plans normally for a 'none' point holding the same road — the pre-#25 trust model is preserved exactly", async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const registered = stateManager.registerPoint('p1', 'none', NOW);
    stateManager.setPointState('p1', { ...registered, commandedPosition: 'reverse' });

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservationHoldingPoint(), threeBlockGraph());

    expect(result.ok).toBe(true);
  });

  it("confirms a 'required' point at its required position and plans", async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    const registered = stateManager.registerPoint('p1', 'required', NOW);
    stateManager.setPointState('p1', {
      ...registered,
      commandedPosition: 'reverse',
      confirmedPosition: 'reverse',
      confirmation: 'confirmed',
    });

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservationHoldingPoint(), threeBlockGraph());

    expect(result.ok).toBe(true);
  });

  it('refuses a point hold naming a point the running layout does not have — drift is uncertainty, not a skip', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    // p1 never registered.

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservationHoldingPoint(), threeBlockGraph());

    expect(result).toEqual({
      ok: false,
      reason: {
        kind: 'point-not-confirmed',
        pointId: 'p1',
        requiredPosition: 'reverse',
        effectivePosition: 'unknown',
      },
    });
  });

  it('ignores a released point hold — that road is behind the train', async () => {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    stateManager.registerPoint('p1', 'required', NOW);

    const service = new BrakingService(repo, stateManager, silentLogger);
    const result = await service.planStopAtRouteBoundary(
      LAYOUT,
      reservation({
        holds: [
          { kind: 'point', targetId: 'p1', requiredPosition: 'reverse', releaseAfterIndex: 0, released: true },
        ],
      }),
      threeBlockGraph(),
    );

    expect(result.ok).toBe(true);
  });
});

// ─── #77's lead term, as this service supplies it (docs/sensor-position.md D9) ──

describe('BrakingService — sub-block position (#77)', () => {
  /** Loco at speed 126, brakingFactor 0.5 → a 500mm estimate, 625mm required after B5's margin. */
  function positionedSetup(beamOffsetMm: number | null) {
    const repo = makeRepo([loco()]);
    const stateManager = new LayoutStateManager(LAYOUT);
    stateManager.updateLoco(3, { speed: 126, direction: 'fwd', authority: 'auto' });
    stateManager.registerSensor({
      sensorId: 'beam-1',
      blockId: 'b1',
      type: 'ir_position',
      inService: true,
      position: beamOffsetMm === null ? null : { towardBlockId: 'b2', offsetMm: beamOffsetMm },
    });
    stateManager.recordSensorReading('beam-1', 'occupied', NOW);
    return { repo, stateManager, clock: new ManualClock(NOW) };
  }

  it('grants a braked run to the IMMEDIATELY NEXT block on the strength of a fix — the case #77 was promoted for', async () => {
    const { repo, stateManager, clock } = positionedSetup(700);
    const service = new BrakingService(repo, stateManager, silentLogger, undefined, clock);

    // targetIndex 1 is b2, adjacent to the confirmed b1: no intermediate
    // blocks, so B4 alone promises 0mm and refuses. The 700mm beam is the only
    // distance there is, and it clears the 625mm requirement.
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), threeBlockGraph(), 1);
    expect(result.ok).toBe(true);
  });

  it('still refuses the same run when the beam is too close to the boundary to stop in', async () => {
    const { repo, stateManager, clock } = positionedSetup(300);
    const service = new BrakingService(repo, stateManager, silentLogger, undefined, clock);

    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), threeBlockGraph(), 1);
    expect(result).toEqual({
      ok: false,
      reason: { kind: 'insufficient-distance', requiredMm: 625, availableMm: 300 },
    });
  });

  it('refuses once the fix has aged out — a decayed fix is worth nothing, not an error', async () => {
    const { repo, stateManager, clock } = positionedSetup(700);
    const service = new BrakingService(repo, stateManager, silentLogger, undefined, clock);
    clock.advance(60_000);

    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), threeBlockGraph(), 1);
    expect(result).toEqual({
      ok: false,
      reason: { kind: 'insufficient-distance', requiredMm: 625, availableMm: 0 },
    });
  });

  it('an unwired clock means no lead term at all — inert, never a wrong answer', async () => {
    // The failure direction of a missed wiring: a run refused that could have
    // been granted, never one granted that should not have been.
    const { repo, stateManager } = positionedSetup(700);
    const service = new BrakingService(repo, stateManager, silentLogger);

    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), threeBlockGraph(), 1);
    expect(result).toEqual({
      ok: false,
      reason: { kind: 'insufficient-distance', requiredMm: 625, availableMm: 0 },
    });
  });

  it('an unmeasured beam changes nothing, and neither does a faulted one', async () => {
    const unmeasured = positionedSetup(null);
    const unmeasuredService = new BrakingService(
      unmeasured.repo,
      unmeasured.stateManager,
      silentLogger,
      undefined,
      unmeasured.clock,
    );
    expect(
      await unmeasuredService.planStopAtRouteBoundary(LAYOUT, reservation(), threeBlockGraph(), 1),
    ).toEqual({ ok: false, reason: { kind: 'insufficient-distance', requiredMm: 625, availableMm: 0 } });

    const faulted = positionedSetup(700);
    faulted.stateManager.setSensorFaulted('beam-1', true);
    const faultedService = new BrakingService(
      faulted.repo,
      faulted.stateManager,
      silentLogger,
      undefined,
      faulted.clock,
    );
    expect(
      await faultedService.planStopAtRouteBoundary(LAYOUT, reservation(), threeBlockGraph(), 1),
    ).toEqual({ ok: false, reason: { kind: 'insufficient-distance', requiredMm: 625, availableMm: 0 } });
  });

  it('adds the fix to the intermediate sum on a longer run rather than replacing it', async () => {
    const { repo, stateManager, clock } = positionedSetup(700);
    const service = new BrakingService(repo, stateManager, silentLogger, undefined, clock);

    // Default target is b3: b2's 1000mm plus the beam's 700mm.
    const result = await service.planStopAtRouteBoundary(LAYOUT, reservation(), threeBlockGraph());
    expect(result.ok).toBe(true);
  });
});
