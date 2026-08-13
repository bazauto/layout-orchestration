import { describe, it, expect } from 'vitest';
import {
  BRAKING_SAFETY_FLOOR_MM,
  BRAKING_SAFETY_MARGIN,
  BRAKING_TICK_MS,
  MIN_STOPPING_DISTANCE_MM,
  buildStopExpectation,
  describeBrakingRefusal,
  isBrakingOverrun,
  planBrakingSchedule,
  remainingRouteDistanceMm,
  requiredDistanceMm,
  scalarStoppingDistance,
} from '../../../src/domain/braking';
import { buildTrackGraph } from '../../../src/domain/graph';
import { EMPTY_NAME_BOOK } from '../../../src/domain/naming';
import { BlockEdge, BrakingProfile, NameBook, RoutePathStep, RouteReservation } from '../../../src/domain/types';

const LAYOUT = 'layout-1';
const NOW = new Date('2026-08-08T00:00:00Z');

function profile(overrides: Partial<BrakingProfile> = {}): BrakingProfile {
  return { locoAddress: 3, maxSpeed: 126, brakingFactor: 0.5, ...overrides };
}

// ─── scalarStoppingDistance ─────────────────────────────────────────────────────

describe('scalarStoppingDistance', () => {
  it('predicts 500mm at full speed for brakingFactor 0.5', () => {
    const result = scalarStoppingDistance(profile({ brakingFactor: 0.5, maxSpeed: 126 }), {
      commandedSpeedStep: 126,
      direction: 'fwd',
    });
    expect(result).toEqual({ known: true, distanceMm: 500 });
  });

  it('predicts 300mm at full speed for brakingFactor 0.7', () => {
    const result = scalarStoppingDistance(profile({ brakingFactor: 0.7, maxSpeed: 126 }), {
      commandedSpeedStep: 126,
      direction: 'fwd',
    });
    expect(result.known).toBe(true);
    if (!result.known) return;
    // Floating-point: 1 - 0.7 is not exactly representable, so this is close-to rather than exact.
    expect(result.distanceMm).toBeCloseTo(300, 9);
  });

  it('predicts 600mm at full speed for brakingFactor 0.4', () => {
    const result = scalarStoppingDistance(profile({ brakingFactor: 0.4, maxSpeed: 126 }), {
      commandedSpeedStep: 126,
      direction: 'fwd',
    });
    expect(result).toEqual({ known: true, distanceMm: 600 });
  });

  it('is quadratic, not linear: 125mm at half speed for brakingFactor 0.5', () => {
    const result = scalarStoppingDistance(profile({ brakingFactor: 0.5, maxSpeed: 126 }), {
      commandedSpeedStep: 63,
      direction: 'fwd',
    });
    expect(result).toEqual({ known: true, distanceMm: 125 });
  });

  it('predicts 0mm for commandedSpeedStep 0, with no floor applied', () => {
    const result = scalarStoppingDistance(profile(), { commandedSpeedStep: 0, direction: 'stop' });
    expect(result).toEqual({ known: true, distanceMm: 0 });
  });

  it('floors the estimate at very low non-zero speed', () => {
    const result = scalarStoppingDistance(profile({ brakingFactor: 0.5, maxSpeed: 126 }), {
      commandedSpeedStep: 1,
      direction: 'fwd',
    });
    expect(result.known).toBe(true);
    if (!result.known) return;
    expect(result.distanceMm).toBe(MIN_STOPPING_DISTANCE_MM);
  });

  // ── Failure paths ──────────────────────────────────────────────────────────

  it('refuses an out-of-range brakingFactor', () => {
    const result = scalarStoppingDistance(profile({ brakingFactor: 1.5 }), {
      commandedSpeedStep: 60,
      direction: 'fwd',
    });
    expect(result).toEqual({
      known: false,
      fault: { kind: 'invalid-braking-factor', brakingFactor: 1.5 },
    });
  });

  it('refuses a commandedSpeedStep above maxSpeed rather than clamping it', () => {
    const result = scalarStoppingDistance(profile({ maxSpeed: 60 }), {
      commandedSpeedStep: 100,
      direction: 'fwd',
    });
    expect(result).toEqual({
      known: false,
      fault: { kind: 'speed-exceeds-max', commandedSpeedStep: 100, maxSpeed: 60 },
    });
    // Not clamped: a clamped answer would report the 60-based distance instead of refusing.
    expect(result.known).toBe(false);
  });

  it('refuses a non-zero speed commanded with direction "stop"', () => {
    const result = scalarStoppingDistance(profile(), { commandedSpeedStep: 40, direction: 'stop' });
    expect(result).toEqual({
      known: false,
      fault: { kind: 'speed-direction-mismatch', commandedSpeedStep: 40, direction: 'stop' },
    });
  });
});

// ─── requiredDistanceMm ──────────────────────────────────────────────────────

describe('requiredDistanceMm', () => {
  it('applies the proportional margin when it exceeds the floor', () => {
    // 1000 * 1.25 = 1250 vs 1000 + 100 = 1100 -> proportional wins.
    expect(requiredDistanceMm(1000)).toBe(1000 * (1 + BRAKING_SAFETY_MARGIN));
  });

  it('applies the absolute floor when the proportional margin would vanish', () => {
    // 10 * 1.25 = 12.5 vs 10 + 100 = 110 -> floor wins.
    expect(requiredDistanceMm(10)).toBe(10 + BRAKING_SAFETY_FLOOR_MM);
  });
});

// ─── planBrakingSchedule ─────────────────────────────────────────────────────

describe('planBrakingSchedule', () => {
  it('plans a 16-step ramp from 126, strictly decreasing, ending at stop', () => {
    const result = planBrakingSchedule({
      profile: profile({ brakingFactor: 0.5, maxSpeed: 126 }),
      fromCommandedSpeedStep: 126,
      direction: 'fwd',
      availableDistanceMm: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.schedule.steps).toHaveLength(16);
    expect(result.schedule.totalDurationMs).toBe(3750);

    const { steps } = result.schedule;
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].speedStep).toBeLessThan(steps[i - 1].speedStep);
      expect(steps[i].atOffsetMs).toBe(steps[i - 1].atOffsetMs + BRAKING_TICK_MS);
      expect(steps[i].atOffsetMs % BRAKING_TICK_MS).toBe(0);
    }
    expect(steps[0].atOffsetMs).toBe(0);
    expect(steps[steps.length - 1]).toEqual({ atOffsetMs: 3750, speedStep: 0, direction: 'stop' });
  });

  it('plans a single step straight to 0 from a low speed', () => {
    const result = planBrakingSchedule({
      profile: profile(),
      fromCommandedSpeedStep: 5,
      direction: 'fwd',
      availableDistanceMm: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.steps).toEqual([{ atOffsetMs: 0, speedStep: 0, direction: 'stop' }]);
  });

  it('refuses a loco already at speed 0', () => {
    const result = planBrakingSchedule({
      profile: profile(),
      fromCommandedSpeedStep: 0,
      direction: 'stop',
      availableDistanceMm: null,
    });
    expect(result).toEqual({ ok: false, reason: { kind: 'already-stopped', locoAddress: 3 } });
  });

  it('grants when availableDistanceMm exactly equals requiredDistanceMm', () => {
    const brakingProfile = profile({ brakingFactor: 0.5, maxSpeed: 126 });
    const estimate = scalarStoppingDistance(brakingProfile, { commandedSpeedStep: 126, direction: 'fwd' });
    expect(estimate.known).toBe(true);
    if (!estimate.known) return;
    const required = requiredDistanceMm(estimate.distanceMm);

    const result = planBrakingSchedule({
      profile: brakingProfile,
      fromCommandedSpeedStep: 126,
      direction: 'fwd',
      availableDistanceMm: required,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses when availableDistanceMm is one mm short of requiredDistanceMm', () => {
    const brakingProfile = profile({ brakingFactor: 0.5, maxSpeed: 126 });
    const estimate = scalarStoppingDistance(brakingProfile, { commandedSpeedStep: 126, direction: 'fwd' });
    expect(estimate.known).toBe(true);
    if (!estimate.known) return;
    const required = requiredDistanceMm(estimate.distanceMm);

    const result = planBrakingSchedule({
      profile: brakingProfile,
      fromCommandedSpeedStep: 126,
      direction: 'fwd',
      availableDistanceMm: required - 1,
    });
    expect(result).toEqual({
      ok: false,
      reason: { kind: 'insufficient-distance', requiredMm: required, availableMm: required - 1 },
    });
  });
});

// ─── remainingRouteDistanceMm ────────────────────────────────────────────────

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

/** b1 -[e1]-> b2 -[e2]-> b3 -[e3]-> b4. Edges carry no length; blocks do (D4). */
function fourBlockEdges(): BlockEdge[] {
  return [
    edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' }),
    edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west' }),
    edge({ id: 'e3', fromBlockId: 'b3', fromEnd: 'east', toBlockId: 'b4', toEnd: 'west' }),
  ];
}

/**
 * Every block 500mm unless overridden. `null` leaves the block out of the map
 * entirely, which is how the graph spells "unmeasured".
 */
function fourBlockGraph(lengths: Partial<Record<'b1' | 'b2' | 'b3' | 'b4', number | null>> = {}) {
  const base: Record<string, number | null> = { b1: 500, b2: 500, b3: 500, b4: 500, ...lengths };
  const measured = new Map<string, number>();
  for (const [id, mm] of Object.entries(base)) if (mm !== null) measured.set(id, mm);
  return buildTrackGraph(LAYOUT, fourBlockEdges(), measured);
}

function pathStep(overrides: Partial<RoutePathStep> & Pick<RoutePathStep, 'blockId'>): RoutePathStep {
  return { edgeId: null, entryEnd: null, exitEnd: null, ...overrides };
}

function fourBlockPath(): RoutePathStep[] {
  return [
    pathStep({ blockId: 'b1', exitEnd: 'east' }),
    pathStep({ blockId: 'b2', edgeId: 'e1', entryEnd: 'west', exitEnd: 'east' }),
    pathStep({ blockId: 'b3', edgeId: 'e2', entryEnd: 'west', exitEnd: 'east' }),
    pathStep({ blockId: 'b4', edgeId: 'e3', entryEnd: 'west' }),
  ];
}

function reservation(overrides: Partial<RouteReservation> = {}): RouteReservation {
  return {
    id: 'route-1',
    layoutId: LAYOUT,
    locoAddress: 3,
    authority: 'auto',
    status: 'active',
    path: fourBlockPath(),
    holds: [],
    confirmedIndex: 0,
    reason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('remainingRouteDistanceMm', () => {
  it('sums the intermediate blocks, and never the target block itself', () => {
    // Confirmed in b1, targeting b4 (index 3): b2 + b3 = 1000mm. b4's own
    // length is excluded because B4's target is its *entry* boundary; b1's
    // because the train may be anywhere inside it.
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), fourBlockGraph(), 3);
    expect(result).toEqual({ ok: true, distanceMm: 1000 });
  });

  it('excludes blocks behind the confirmed index', () => {
    // Train confirmed in b2 (index 1), targeting b4: only b3 counts.
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 1 }), fourBlockGraph(), 3);
    expect(result).toEqual({ ok: true, distanceMm: 500 });
  });

  it('gives zero distance for the immediately next block, so the run is refused (D-K)', () => {
    // The behaviour change #105's fix brings, and the reason it gets a named
    // test of its own: there is no track between the exit boundary of the
    // confirmed block and the entry boundary of the next one, so there is
    // nothing to brake over. Correct under block-level occupancy — the train
    // may already be hard against the exit — and the fail-safe direction.
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), fourBlockGraph(), 1);
    expect(result).toEqual({ ok: true, distanceMm: 0 });
  });

  // ── Failure paths ──────────────────────────────────────────────────────────

  it('refuses on an unmeasured block, naming it, without substituting a default length', () => {
    // The pathfinder guesses `DEFAULT_BLOCK_LENGTH_MM` for this same missing
    // datum. Guessing a cost only picks a worse route; guessing a stopping
    // distance is a collision, so this side refuses.
    const result = remainingRouteDistanceMm(
      reservation({ confirmedIndex: 0 }),
      fourBlockGraph({ b2: null }),
      3,
    );
    expect(result).toEqual({ ok: false, reason: { kind: 'unmeasured-track', blockId: 'b2' } });
  });

  it('refuses a targetIndex at or behind the confirmed index', () => {
    const graph = fourBlockGraph();
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 2 }), graph, 2);
    expect(result).toEqual({
      ok: false,
      reason: { kind: 'target-behind-train', targetIndex: 2, confirmedIndex: 2 },
    });
  });
});

// ─── buildStopExpectation / isBrakingOverrun ─────────────────────────────────

describe('buildStopExpectation / isBrakingOverrun', () => {
  it('flags the target block and every block beyond it as an overrun', () => {
    const r = reservation({ confirmedIndex: 0 });
    const expectation = buildStopExpectation(r, 2); // stop at entry of b3

    expect(expectation.forbiddenBlockIds).toEqual(['b3', 'b4']);
    expect(isBrakingOverrun(expectation, 'b3', 'occupied')).toBe(true);
    expect(isBrakingOverrun(expectation, 'b4', 'occupied')).toBe(true);
  });

  it('does not flag a block behind the target', () => {
    const r = reservation({ confirmedIndex: 0 });
    const expectation = buildStopExpectation(r, 2);
    expect(isBrakingOverrun(expectation, 'b2', 'occupied')).toBe(false);
    expect(isBrakingOverrun(expectation, 'b1', 'occupied')).toBe(false);
  });

  it('does not flag the target block on clear or unknown occupancy', () => {
    const r = reservation({ confirmedIndex: 0 });
    const expectation = buildStopExpectation(r, 2);
    expect(isBrakingOverrun(expectation, 'b3', 'clear')).toBe(false);
    expect(isBrakingOverrun(expectation, 'b3', 'unknown')).toBe(false);
  });
});

describe('describeBrakingRefusal', () => {
  it('degrades to raw ids, byte-for-byte, with no book (D8)', () => {
    expect(describeBrakingRefusal({ kind: 'unmeasured-track', blockId: 'b1' })).toBe(
      'block b1 has no measured length — unsafe for automated braking',
    );
    expect(describeBrakingRefusal({ kind: 'unknown-edge', edgeId: 'e1' })).toBe(
      'edge e1 does not exist in the current track graph',
    );
    expect(describeBrakingRefusal({ kind: 'already-stopped', locoAddress: 3 })).toBe(
      'loco 3 is already stopped',
    );
    expect(describeBrakingRefusal({ kind: 'unknown-loco', locoAddress: 3 })).toBe(
      'loco 3 is not in the roster',
    );
    expect(describeBrakingRefusal({ kind: 'ambiguous-loco', locoAddress: 3, count: 2 })).toBe(
      'loco 3 has 2 roster entries',
    );
    expect(describeBrakingRefusal({ kind: 'unknown-loco-state', locoAddress: 3 })).toBe(
      'loco 3 has no known commanded state',
    );
  });

  it('renders quoted names when a book is supplied', () => {
    const book: NameBook = {
      ...EMPTY_NAME_BOOK,
      edges: new Map([['e1', 'Down Platform:north → Up Loop:south']]),
      blocks: new Map([['b1', 'Down Platform']]),
      locos: new Map([[3, 'Jinty']]),
    };
    expect(describeBrakingRefusal({ kind: 'unmeasured-track', blockId: 'b1' }, book)).toBe(
      'block "Down Platform" (b1) has no measured length — unsafe for automated braking',
    );
    expect(describeBrakingRefusal({ kind: 'already-stopped', locoAddress: 3 }, book)).toBe(
      'loco "Jinty" (3) is already stopped',
    );
  });

  it('keeps route ids bare even with a book (D3 — routes are not in the NameBook)', () => {
    const book: NameBook = { ...EMPTY_NAME_BOOK, locos: new Map([[3, 'Jinty']]) };
    expect(describeBrakingRefusal({ kind: 'manual-authority', routeId: 'route-1' }, book)).toBe(
      'route route-1 is manual authority',
    );
    expect(describeBrakingRefusal({ kind: 'route-not-active', routeId: 'route-1', status: 'cancelled' }, book)).toBe(
      'route route-1 is cancelled, not active',
    );
  });
});
