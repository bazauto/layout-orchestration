import { describe, it, expect } from 'vitest';
import {
  BRAKING_SAFETY_FLOOR_MM,
  BRAKING_SAFETY_MARGIN,
  BRAKING_TICK_MS,
  MIN_STOPPING_DISTANCE_MM,
  buildStopExpectation,
  isBrakingOverrun,
  planBrakingSchedule,
  remainingRouteDistanceMm,
  requiredDistanceMm,
  scalarStoppingDistance,
} from '../../../src/domain/braking';
import { buildTrackGraph } from '../../../src/domain/graph';
import { BlockEdge, BrakingProfile, RoutePathStep, RouteReservation } from '../../../src/domain/types';

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
    lengthMm: null,
    ...overrides,
  };
}

/** b1 -[e1]-> b2 -[e2]-> b3 -[e3]-> b4, each edge 500mm unless overridden. */
function fourBlockEdges(overrides: Partial<Record<'e1' | 'e2' | 'e3', Partial<BlockEdge>>> = {}): BlockEdge[] {
  return [
    edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west', lengthMm: 500, ...overrides.e1 }),
    edge({ id: 'e2', fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west', lengthMm: 500, ...overrides.e2 }),
    edge({ id: 'e3', fromBlockId: 'b3', fromEnd: 'east', toBlockId: 'b4', toEnd: 'west', lengthMm: 500, ...overrides.e3 }),
  ];
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
  it('sums only the edges from confirmedIndex + 1 through targetIndex', () => {
    const graph = buildTrackGraph(LAYOUT, fourBlockEdges());
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), graph, 3);
    expect(result).toEqual({ ok: true, distanceMm: 1500 });
  });

  it('excludes edges behind the confirmed index', () => {
    const graph = buildTrackGraph(LAYOUT, fourBlockEdges());
    // Train confirmed in b2 (index 1); only e2 (into b3) and e3 (into b4) count.
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 1 }), graph, 3);
    expect(result).toEqual({ ok: true, distanceMm: 1000 });
  });

  // ── Failure paths ──────────────────────────────────────────────────────────

  it('refuses on an unmeasured edge, naming it, without substituting a default length', () => {
    const graph = buildTrackGraph(LAYOUT, fourBlockEdges({ e2: { lengthMm: null } }));
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), graph, 3);
    expect(result).toEqual({ ok: false, reason: { kind: 'unmeasured-track', edgeId: 'e2' } });
  });

  it('refuses a targetIndex at or behind the confirmed index', () => {
    const graph = buildTrackGraph(LAYOUT, fourBlockEdges());
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
