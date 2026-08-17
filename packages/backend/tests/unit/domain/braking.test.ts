import { describe, it, expect } from 'vitest';
import {
  BRAKING_SAFETY_FLOOR_MM,
  BRAKING_SAFETY_MARGIN,
  BRAKING_TICK_MS,
  MIN_STOPPING_DISTANCE_MM,
  buildBerthExpectation,
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
import {
  BlockEdge,
  BrakingProfile,
  NameBook,
  RoutePathStep,
  RouteReservation,
  SensorObservation,
} from '../../../src/domain/types';

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

/**
 * An IR beam in b1, 400mm from the b1/b2 boundary, which tripped at `NOW`
 * (#77, `docs/sensor-position.md`).
 */
function beam(overrides: Partial<SensorObservation> = {}): SensorObservation {
  return {
    sensorId: 'beam-1',
    blockId: 'b1',
    type: 'ir_position',
    inService: true,
    faulted: false,
    trusted: true,
    lastReading: 'occupied',
    lastReadingAt: NOW,
    lastLiveReadingAt: NOW,
    position: { towardBlockId: 'b2', offsetMm: 400 },
    lastRisingEdgeAt: NOW,
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

  it('gives zero distance for the immediately next block WITHOUT a position fix, so the run is refused (D-K)', () => {
    // The behaviour change #105's fix brings, and the reason it gets a named
    // test of its own: there is no track between the exit boundary of the
    // confirmed block and the entry boundary of the next one, so there is
    // nothing to brake over. Correct under block-level occupancy — the train
    // may already be hard against the exit — and the fail-safe direction.
    // #77's lead term is what lifts it, and only where a beam has been measured.
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), fourBlockGraph(), 1);
    expect(result).toEqual({ ok: true, distanceMm: 0 });
  });

  // ── #77's lead term (docs/sensor-position.md D9) ──────────────────────────

  it('credits an applicable position fix in the CONFIRMED block, which is what unblocks the adjacent target', () => {
    // The case #77 was promoted ahead of #7 for: a braked run to the
    // immediately next block, refused a moment ago, granted 400mm now.
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), fourBlockGraph(), 1, {
      observations: [beam()],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, distanceMm: 400 });
  });

  it('adds the lead term to the intermediate sum rather than replacing it', () => {
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), fourBlockGraph(), 3, {
      observations: [beam()],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, distanceMm: 1400 });
  });

  it('credits nothing for a fix measured toward a DIFFERENT exit of the confirmed block', () => {
    // A beam 400mm from the b3 boundary says nothing about the distance to the
    // b2 boundary, which is the one this train is about to cross.
    const elsewhere = beam({ position: { towardBlockId: 'b3', offsetMm: 400 } });
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), fourBlockGraph(), 1, {
      observations: [elsewhere],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, distanceMm: 0 });
  });

  it('credits nothing for a fix in a block the train is not confirmed in', () => {
    const ahead = beam({ blockId: 'b2', position: { towardBlockId: 'b3', offsetMm: 400 } });
    const result = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), fourBlockGraph(), 3, {
      observations: [ahead],
      now: NOW,
    });
    expect(result).toEqual({ ok: true, distanceMm: 1000 });
  });

  it('lets a stale fix decay to nothing rather than refusing — the term can only ever ADD distance', () => {
    const stale = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), fourBlockGraph(), 3, {
      observations: [beam()],
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(stale).toEqual({ ok: true, distanceMm: 1000 });
  });

  it('still refuses unmeasured intermediate track, however good the fix is', () => {
    // A measured beam in the confirmed block says nothing about a block further
    // along that nobody has put a tape measure to.
    const result = remainingRouteDistanceMm(
      reservation({ confirmedIndex: 0 }),
      fourBlockGraph({ b2: null }),
      3,
      { observations: [beam()], now: NOW },
    );
    expect(result).toEqual({ ok: false, reason: { kind: 'unmeasured-track', blockId: 'b2' } });
  });

  it('omitting `lead` reproduces the pre-#77 answer exactly', () => {
    const withoutLead = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), fourBlockGraph(), 3);
    const withEmptyLead = remainingRouteDistanceMm(
      reservation({ confirmedIndex: 0 }),
      fourBlockGraph(),
      3,
      { observations: [], now: NOW },
    );
    expect(withoutLead).toEqual({ ok: true, distanceMm: 1000 });
    expect(withEmptyLead).toEqual(withoutLead);
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

// ─── #7's ramp-to-a-crawl (docs/automation.md A4) ──────────────────────────────

describe('planBrakingSchedule with a toSpeedStep', () => {
  it('defaults to a full stop, byte-for-byte with every pre-#7 caller', () => {
    const withDefault = planBrakingSchedule({
      profile: profile(),
      fromCommandedSpeedStep: 40,
      direction: 'fwd',
      availableDistanceMm: null,
    });
    const withExplicitZero = planBrakingSchedule({
      profile: profile(),
      fromCommandedSpeedStep: 40,
      direction: 'fwd',
      availableDistanceMm: null,
      toSpeedStep: 0,
    });
    expect(withDefault).toEqual(withExplicitZero);
    expect(withDefault.ok).toBe(true);
    if (!withDefault.ok) return;
    expect(withDefault.schedule.endsAtSpeedStep).toBe(0);
    expect(withDefault.schedule.steps.at(-1)).toEqual({
      atOffsetMs: expect.any(Number),
      speedStep: 0,
      direction: 'stop',
    });
  });

  it('ramps down to the crawl step and stops there, keeping the direction', () => {
    // A crawling train is still moving, so the last step must NOT be 'stop' —
    // that pairing is the `speed-direction-mismatch` the model refuses on.
    const plan = planBrakingSchedule({
      profile: profile(),
      fromCommandedSpeedStep: 40,
      direction: 'fwd',
      availableDistanceMm: null,
      toSpeedStep: 8,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(plan.schedule.endsAtSpeedStep).toBe(8);
    expect(plan.schedule.steps.map((s) => s.speedStep)).toEqual([32, 24, 16, 8]);
    expect(plan.schedule.steps.every((s) => s.direction === 'fwd')).toBe(true);
  });

  it('clamps at the crawl step rather than stepping past it', () => {
    // 30 - 8 - 8 - 8 would land on 6, below the crawl step. The last decrement
    // is short instead.
    const plan = planBrakingSchedule({
      profile: profile(),
      fromCommandedSpeedStep: 30,
      direction: 'fwd',
      availableDistanceMm: null,
      toSpeedStep: 10,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.schedule.steps.map((s) => s.speedStep)).toEqual([22, 14, 10]);
  });

  it('still requires the FULL stopping distance, not the partial ramp (A4)', () => {
    // The whole of A4: `toSpeedStep` changes what the ramp commands and
    // deliberately not what it requires. Both calls refuse on the same figure.
    const available = 100;
    const stop = planBrakingSchedule({
      profile: profile(),
      fromCommandedSpeedStep: 126,
      direction: 'fwd',
      availableDistanceMm: available,
    });
    const toCrawl = planBrakingSchedule({
      profile: profile(),
      fromCommandedSpeedStep: 126,
      direction: 'fwd',
      availableDistanceMm: available,
      toSpeedStep: 8,
    });
    expect(stop).toEqual(toCrawl);
    expect(toCrawl).toEqual({
      ok: false,
      reason: { kind: 'insufficient-distance', requiredMm: 625, availableMm: available },
    });
  });

  it('reports the full-stop estimate on a ramp that ends at a crawl', () => {
    const plan = planBrakingSchedule({
      profile: profile({ brakingFactor: 0.5, maxSpeed: 126 }),
      fromCommandedSpeedStep: 126,
      direction: 'fwd',
      availableDistanceMm: null,
      toSpeedStep: 8,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.schedule.estimatedStoppingDistanceMm).toBe(500);
    expect(plan.schedule.requiredDistanceMm).toBe(625);
  });

  it('refuses a target speed that is not below the starting speed', () => {
    // Refused rather than clamped: it means the roster's crawl step and the
    // speed the train is running at disagree about which is slower, and a
    // "brake" that accelerates is not something to interpret charitably.
    for (const toSpeedStep of [20, 25]) {
      expect(
        planBrakingSchedule({
          profile: profile(),
          fromCommandedSpeedStep: 20,
          direction: 'fwd',
          availableDistanceMm: null,
          toSpeedStep,
        }),
      ).toEqual({
        ok: false,
        reason: { kind: 'target-speed-not-slower', fromSpeedStep: 20, toSpeedStep },
      });
    }
  });

  it('still refuses an already-stopped loco before it looks at the target speed', () => {
    expect(
      planBrakingSchedule({
        profile: profile(),
        fromCommandedSpeedStep: 0,
        direction: 'stop',
        availableDistanceMm: null,
        toSpeedStep: 0,
      }),
    ).toEqual({ ok: false, reason: { kind: 'already-stopped', locoAddress: 3 } });
  });
});

// ─── #7's berth term (docs/automation.md A2/A3) ────────────────────────────────

describe('remainingRouteDistanceMm with a berth offset', () => {
  it('adds the berth offset to the intermediate sum', () => {
    // Confirmed in b1, target b4 (index 3): b2 + b3 = 1000mm to b4's entry
    // boundary, plus 700mm into b4 to reach the beam.
    const result = remainingRouteDistanceMm(
      reservation({ confirmedIndex: 0 }),
      fourBlockGraph(),
      3,
      undefined,
      700,
    );
    expect(result).toEqual({ ok: true, distanceMm: 1700 });
  });

  it('stacks with #77 lead term at the other end of the route', () => {
    const result = remainingRouteDistanceMm(
      reservation({ confirmedIndex: 0 }),
      fourBlockGraph(),
      3,
      { observations: [beam()], now: NOW },
      700,
    );
    expect(result).toEqual({ ok: true, distanceMm: 400 + 1000 + 700 });
  });

  it('is what makes an ADJACENT berthed target a real distance', () => {
    // The B4/D-K case again, from the other side: no intermediate blocks at
    // all, no position fix, and the berth offset is the only distance there is.
    const result = remainingRouteDistanceMm(
      reservation({ confirmedIndex: 0 }),
      fourBlockGraph(),
      1,
      undefined,
      600,
    );
    expect(result).toEqual({ ok: true, distanceMm: 600 });
  });

  it('omitting it reproduces the pre-#7 answer exactly', () => {
    const without = remainingRouteDistanceMm(reservation({ confirmedIndex: 0 }), fourBlockGraph(), 3);
    const withZero = remainingRouteDistanceMm(
      reservation({ confirmedIndex: 0 }),
      fourBlockGraph(),
      3,
      undefined,
      0,
    );
    expect(without).toEqual(withZero);
  });

  it('cannot subtract — a negative offset is clamped to zero', () => {
    const result = remainingRouteDistanceMm(
      reservation({ confirmedIndex: 0 }),
      fourBlockGraph(),
      3,
      undefined,
      -900,
    );
    expect(result).toEqual({ ok: true, distanceMm: 1000 });
  });

  it('does not rescue unmeasured intermediate track', () => {
    // A beam in the destination is evidence about the destination and nothing
    // else — exactly what #77 D9 says about the lead term.
    const result = remainingRouteDistanceMm(
      reservation({ confirmedIndex: 0 }),
      fourBlockGraph({ b2: null }),
      3,
      undefined,
      700,
    );
    expect(result).toEqual({ ok: false, reason: { kind: 'unmeasured-track', blockId: 'b2' } });
  });
});

// ─── #7's berthing overrun expectation (docs/automation.md A9) ─────────────────

describe('buildBerthExpectation', () => {
  it('forbids the track BEYOND the destination, and not the destination itself', () => {
    // The whole point: a berthing train is supposed to enter b4, so the
    // ordinary `path.slice(targetIndex)` expectation would Safe-Stop the layout
    // at the instant a textbook arrival succeeded.
    const graph = buildTrackGraph(LAYOUT, [
      ...fourBlockEdges(),
      edge({ id: 'e4', fromBlockId: 'b4', fromEnd: 'east', toBlockId: 'b5', toEnd: 'west' }),
    ]);
    const expectation = buildBerthExpectation(reservation({ confirmedIndex: 2 }), graph);

    expect(expectation.forbiddenBlockIds).toEqual(['b5']);
    expect(isBrakingOverrun(expectation, 'b4', 'occupied')).toBe(false);
    expect(isBrakingOverrun(expectation, 'b5', 'occupied')).toBe(true);
  });

  it('never forbids the block the train arrived from', () => {
    // b4 joins back to b3 in the reverse direction on a real compiled graph,
    // and the train's own tail is in b3 — forbidding it would fault every
    // arrival.
    const graph = buildTrackGraph(LAYOUT, [
      ...fourBlockEdges(),
      edge({ id: 'e3r', fromBlockId: 'b4', fromEnd: 'west', toBlockId: 'b3', toEnd: 'east' }),
      edge({ id: 'e4', fromBlockId: 'b4', fromEnd: 'east', toBlockId: 'b5', toEnd: 'west' }),
    ]);
    const expectation = buildBerthExpectation(reservation({ confirmedIndex: 2 }), graph);
    expect(expectation.forbiddenBlockIds).toEqual(['b5']);
  });

  it('is EMPTY for a terminal destination, which is honest rather than broken', () => {
    // A9's recorded limit: there is no block past the buffers to detect a train
    // that reaches them. The answer to that is a buffer stop, not code.
    const expectation = buildBerthExpectation(reservation({ confirmedIndex: 2 }), fourBlockGraph());
    expect(expectation.forbiddenBlockIds).toEqual([]);
    expect(isBrakingOverrun(expectation, 'b4', 'occupied')).toBe(false);
  });

  it('records the destination step as its target index', () => {
    const expectation = buildBerthExpectation(reservation(), fourBlockGraph());
    expect(expectation.targetIndex).toBe(3);
    expect(expectation.routeId).toBe('route-1');
    expect(expectation.locoAddress).toBe(3);
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
