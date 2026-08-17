/**
 * #7 — the automation engine's decision layer. See `docs/automation.md`
 * (A1–A13).
 *
 * What is worth pinning here is the state machine and the moment the brake
 * trigger fires, because those are the two things #6 deliberately did not
 * build. Everything about *how far* a train takes to stop is already covered by
 * `braking.test.ts`; this file only cares about *when* the question gets asked
 * and what is done with the answer.
 *
 * Two asymmetries run through it and are asserted rather than assumed:
 *  - a missing configuration **blocks** and never faults (A7), because a
 *    railway that halts over an unset column is its own bug;
 *  - an unanswerable distance question **holds** and never brakes, because the
 *    thing that actually protects the train is the *plan* being refused one
 *    layer down (A10), not a reflexive stop mid-section.
 */

import { describe, it, expect } from 'vitest';
import {
  APPROACH_MARGIN_MM,
  AUTOMATION_TICK_MS,
  AutomationInput,
  AutomationPhase,
  CRAWL_TIMEOUT_MS,
  decideAutomation,
  describeAutomationBlocker,
} from '../../../src/domain/automation';
import { MAX_CREDIBLE_SPEED_MM_PER_S } from '../../../src/domain/sensorPosition';
import { buildTrackGraph } from '../../../src/domain/graph';
import {
  BlockEdge,
  BrakingProfile,
  LocoState,
  RoutePathStep,
  RouteReservation,
} from '../../../src/domain/types';

const LAYOUT = 'layout-1';
const NOW = new Date('2026-08-16T12:00:00.000Z');

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

/** b1 -> b2 -> b3 -> b4, every block 500mm. */
function graph() {
  return buildTrackGraph(
    LAYOUT,
    [
      edge({ id: 'e1', fromBlockId: 'b1', toBlockId: 'b2' }),
      edge({ id: 'e2', fromBlockId: 'b2', toBlockId: 'b3' }),
      edge({ id: 'e3', fromBlockId: 'b3', toBlockId: 'b4' }),
    ],
    new Map([
      ['b1', 500],
      ['b2', 500],
      ['b3', 500],
      ['b4', 500],
    ]),
  );
}

function step(blockId: string, edgeId: string | null = null): RoutePathStep {
  return { edgeId, blockId, entryEnd: null, exitEnd: null };
}

function reservation(overrides: Partial<RouteReservation> = {}): RouteReservation {
  return {
    id: 'route-1',
    layoutId: LAYOUT,
    locoAddress: 3,
    authority: 'auto',
    direction: 'fwd',
    status: 'active',
    path: [step('b1'), step('b2', 'e1'), step('b3', 'e2'), step('b4', 'e3')],
    holds: [],
    confirmedIndex: 0,
    reason: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function loco(overrides: Partial<LocoState> = {}): LocoState {
  return {
    address: 3,
    speed: 0,
    direction: 'stop',
    functions: {},
    authority: 'auto',
    lastUpdated: NOW,
    ...overrides,
  };
}

const profile: BrakingProfile = { locoAddress: 3, maxSpeed: 126, brakingFactor: 0.5 };

function input(overrides: Partial<AutomationInput> = {}): AutomationInput {
  return {
    reservation: reservation(),
    phase: 'awaiting-departure',
    loco: loco(),
    profile,
    autoSpeedStep: 60,
    crawlSpeedStep: 8,
    graph: graph(),
    brakingRunInFlight: false,
    confirmedBlockObservations: [],
    destinationBlockObservations: [],
    berthSensorId: null,
    berthSensorOccupied: false,
    crawlStartedAt: null,
    now: NOW,
    ...overrides,
  };
}

const after = (ms: number) => new Date(NOW.getTime() + ms);

// ─── Constants (A6, A11) ───────────────────────────────────────────────────────

describe('constants', () => {
  it('derives the approach margin from the sweep and the credible-speed bound', () => {
    // A6: the largest amount the available distance can fall between two
    // consecutive sweeps. Asserted as the expression, not as 125, so that
    // moving either input moves this with it.
    expect(APPROACH_MARGIN_MM).toBe((MAX_CREDIBLE_SPEED_MM_PER_S * AUTOMATION_TICK_MS) / 1000);
    expect(APPROACH_MARGIN_MM).toBe(125);
  });
});

// ─── Departure (A7) ────────────────────────────────────────────────────────────

describe('departure', () => {
  it('departs at the roster speed in the direction the operator stated', () => {
    expect(decideAutomation(input(), 0)).toEqual({
      decision: { kind: 'depart', speedStep: 60, direction: 'fwd' },
      nextPhase: 'running',
    });
  });

  it('carries the reverse direction through unchanged', () => {
    const out = decideAutomation(input({ reservation: reservation({ direction: 'rev' }) }), 0);
    expect(out.decision).toEqual({ kind: 'depart', speedStep: 60, direction: 'rev' });
  });

  it('BLOCKS rather than faults when the route states no direction', () => {
    // A7: nothing in this system can derive which way round a loco sits, and a
    // config gap is not a reason to halt a railway.
    const out = decideAutomation(input({ reservation: reservation({ direction: null }) }), 0);
    expect(out).toEqual({
      decision: { kind: 'blocked', reason: { kind: 'no-direction' } },
      nextPhase: 'awaiting-departure',
    });
  });

  it('BLOCKS when the loco has no automation speed step — there is no maxSpeed fallback', () => {
    const out = decideAutomation(input({ autoSpeedStep: null }), 0);
    expect(out.decision).toEqual({ kind: 'blocked', reason: { kind: 'no-auto-speed' } });
  });

  it('DEPARTS a loco that has never been commanded — a deliberate asymmetry with B6', () => {
    // B6 refuses a braking plan without a `LocoState` because it needs the
    // current commanded speed as an input to a calculation. A departure
    // computes nothing from it — it *sets* the speed. Refusing here would make
    // automation unusable from a cold start, since the one thing an operator
    // could do to establish a `LocoState` (open the throttle) cancels the very
    // route they are trying to automate (D6).
    const out = decideAutomation(input({ loco: null }), 0);
    expect(out).toEqual({
      decision: { kind: 'depart', speedStep: 60, direction: 'fwd' },
      nextPhase: 'running',
    });
  });

  it('BLOCKS when the loco is not in the roster', () => {
    const out = decideAutomation(input({ profile: null }), 0);
    expect(out.decision).toEqual({ kind: 'blocked', reason: { kind: 'not-in-roster' } });
  });

  it('advances a train that is already moving without re-commanding a speed', () => {
    // Re-issuing `depart` at line speed to a train already at line speed is
    // harmless today and becomes a way to override a ramp the moment anything
    // else commands this loco.
    const out = decideAutomation(input({ loco: loco({ speed: 60, direction: 'fwd' }) }), 0);
    expect(out).toEqual({ decision: { kind: 'hold' }, nextPhase: 'running' });
  });

  it('checks the roster before the configuration, so an unknown loco is not reported as a missing speed', () => {
    const out = decideAutomation(input({ profile: null, autoSpeedStep: null }), 0);
    expect(out.decision).toEqual({ kind: 'blocked', reason: { kind: 'not-in-roster' } });
  });
});

// ─── The brake trigger (A6) ────────────────────────────────────────────────────

describe('the brake trigger', () => {
  // Speed 60 throughout: the model predicts 113mm and requires 213mm with B5's
  // margin, so the distance trigger sits at 338mm against 500mm blocks. Those
  // figures are far enough apart that a change to either constant fails loudly
  // rather than flipping a borderline case.
  const running = (overrides: Partial<AutomationInput> = {}) =>
    input({ phase: 'running', loco: loco({ speed: 60, direction: 'fwd' }), ...overrides });

  it('holds while there is plenty of track ahead', () => {
    // Confirmed in b1, target b4: b2 + b3 = 1000mm available, and advancing one
    // block would still leave 500mm against a 213mm requirement. Nothing to do.
    const out = decideAutomation(running(), 0);
    expect(out).toEqual({ decision: { kind: 'hold' }, nextPhase: 'running' });
  });

  it('brakes when advancing one more block would leave too little to plan with', () => {
    // Confirmed in b2: 500mm remains, which the distance trigger (338mm) is
    // still happy with. What fires is the look-ahead — once the train is
    // confirmed in b3 there are no intermediate blocks left at all, so the
    // available distance becomes 0 and nothing could ever be planned.
    const out = decideAutomation(running({ reservation: reservation({ confirmedIndex: 1 }) }), 0);
    expect(out.nextPhase).toBe('braking');
    expect(out.decision).toMatchObject({
      kind: 'brake',
      targetIndex: 3,
      toSpeedStep: 0,
      berthOffsetMm: 0,
      berthSensorId: null,
      availableMm: 500,
    });
    if (out.decision.kind !== 'brake') return;
    expect(out.decision.requiredMm).toBeCloseTo(213.4, 1);
  });

  it('fires while the plan is still grantable, which is the whole point', () => {
    // Whichever trigger fires, the available distance at that moment still
    // exceeds what a full stop requires — so `planBrakingSchedule` grants it
    // rather than refusing `insufficient-distance`, which would be A10's
    // `unable-to-stop` fault instead of an ordinary braked approach.
    const out = decideAutomation(running({ reservation: reservation({ confirmedIndex: 1 }) }), 0);
    expect(out.decision.kind).toBe('brake');
    if (out.decision.kind !== 'brake') return;
    expect(out.decision.availableMm).toBeGreaterThan(out.decision.requiredMm);
  });

  it('lets the DISTANCE trigger fire on its own where blocks are shorter than a stop', () => {
    // The two triggers dominate in different geometries, and this is the one
    // where the distance rule is the operative one: a 50mm next block means
    // advancing costs almost nothing, so the look-ahead is content — but the
    // total left is inside 338mm, so it is time to brake regardless.
    const shortBlocks = buildTrackGraph(
      LAYOUT,
      [
        edge({ id: 'e1', fromBlockId: 'b1', toBlockId: 'b2' }),
        edge({ id: 'e2', fromBlockId: 'b2', toBlockId: 'b3' }),
        edge({ id: 'e3', fromBlockId: 'b3', toBlockId: 'b4' }),
      ],
      new Map([
        ['b1', 500],
        ['b2', 50],
        ['b3', 280],
        ['b4', 500],
      ]),
    );
    const out = decideAutomation(running({ graph: shortBlocks }), 0);
    expect(out.decision.kind).toBe('brake');
    if (out.decision.kind !== 'brake') return;
    expect(out.decision.availableMm).toBe(330);
  });

  it('brakes on entering the LAST block before the target, however much berth lies beyond', () => {
    // The planning horizon (A6). A route completes the instant its destination
    // reads `occupied`, and `remainingRouteDistanceMm` refuses once
    // `confirmedIndex` reaches `targetIndex` — so this is the last place a plan
    // can be made from. A 400mm berth beyond looks like plenty of room to the
    // distance trigger (400 > 213 + 125), and waiting on it would mean the
    // train leaves this block with no plan and nothing ever brakes it.
    const out = decideAutomation(
      running({
        reservation: reservation({ confirmedIndex: 2 }),
        loco: loco({ speed: 60, direction: 'fwd' }),
        berthSensorId: 'berth',
      }),
      400,
    );
    expect(out.nextPhase).toBe('braking');
    expect(out.decision).toMatchObject({ kind: 'brake', toSpeedStep: 8, berthOffsetMm: 400 });
  });

  it('lets a fresh position fix in that last block hold the horizon open', () => {
    // With a beam saying the train is still 300mm from the boundary, it cannot
    // cross before the next sweep, so there is no need to brake yet. Same
    // margin, same question — how far can this train get before I look again.
    const out = decideAutomation(
      running({
        reservation: reservation({ confirmedIndex: 2 }),
        loco: loco({ speed: 60, direction: 'fwd' }),
        berthSensorId: 'berth',
        confirmedBlockObservations: [
          {
            sensorId: 'lead',
            blockId: 'b3',
            type: 'ir_position',
            inService: true,
            faulted: false,
            trusted: true,
            lastReading: 'occupied',
            lastReadingAt: NOW,
            lastLiveReadingAt: NOW,
            position: { towardBlockId: 'b4', offsetMm: 300 },
            lastRisingEdgeAt: NOW,
          },
        ],
      }),
      400,
    );
    expect(out).toEqual({ decision: { kind: 'hold' }, nextPhase: 'running' });
  });

  it('a berth offset pushes the trigger later, because the stopping point is further away', () => {
    // Same confirmed index as the braking case above, but the beam is 400mm
    // into b4: 900mm available, which is outside the 750mm trigger.
    const out = decideAutomation(
      running({ reservation: reservation({ confirmedIndex: 1 }), berthSensorId: 'berth' }),
      400,
    );
    expect(out).toEqual({ decision: { kind: 'hold' }, nextPhase: 'running' });
  });

  it('plans a ramp to the crawl step when a beam is berthing', () => {
    const out = decideAutomation(
      running({ reservation: reservation({ confirmedIndex: 2 }), berthSensorId: 'berth' }),
      400,
    );
    expect(out.nextPhase).toBe('braking');
    expect(out.decision).toMatchObject({
      kind: 'brake',
      toSpeedStep: 8,
      berthOffsetMm: 400,
      berthSensorId: 'berth',
      availableMm: 400,
    });
  });

  it('falls back to a boundary stop when the loco has no crawl step (A2/A7)', () => {
    // The degradation that makes berthing arrive incrementally as beams are
    // fitted: no crawl configured, so no berthing, so B4's behaviour unchanged.
    const out = decideAutomation(
      running({
        reservation: reservation({ confirmedIndex: 2 }),
        berthSensorId: 'berth',
        crawlSpeedStep: null,
      }),
      400,
    );
    expect(out.decision).toMatchObject({ kind: 'brake', toSpeedStep: 0, berthSensorId: null, berthOffsetMm: 0 });
  });

  it('falls back to a boundary stop when there is no beam, however good the crawl step', () => {
    const out = decideAutomation(running({ reservation: reservation({ confirmedIndex: 2 }) }), 0);
    expect(out.decision).toMatchObject({ kind: 'brake', toSpeedStep: 0, berthSensorId: null });
  });

  it('falls back to a boundary stop when the train is already slower than its crawl step', () => {
    // A ramp cannot end above where it starts (A4), so berthing here would
    // produce a plan `planBrakingSchedule` refuses outright.
    //
    // At speed 6 the estimate floors at MIN_STOPPING_DISTANCE_MM, so a full
    // stop needs 150mm and the trigger point is 275mm — hence the 100mm beam
    // rather than the 400mm one the other cases use.
    const out = decideAutomation(
      running({
        reservation: reservation({ confirmedIndex: 2 }),
        loco: loco({ speed: 6, direction: 'fwd' }),
        berthSensorId: 'berth',
      }),
      100,
    );
    expect(out.decision).toMatchObject({ kind: 'brake', toSpeedStep: 0, berthSensorId: null });
  });

  it('STANDS DOWN a moving train whose remaining distance stops being computable', () => {
    // Holding here was the first instinct and it is wrong, because the cause is
    // not transient: `unmeasured-track` stays refused for as long as the block
    // stays unmeasured, so the train would coast to the end of its authority
    // while the sweep politely asked again four times a second. A7's departure
    // check is what makes this rare — reaching it means the layout changed
    // under a running train, which is exactly when to stop it.
    const unmeasured = buildTrackGraph(
      LAYOUT,
      [
        edge({ id: 'e1', fromBlockId: 'b1', toBlockId: 'b2' }),
        edge({ id: 'e2', fromBlockId: 'b2', toBlockId: 'b3' }),
        edge({ id: 'e3', fromBlockId: 'b3', toBlockId: 'b4' }),
      ],
      new Map([['b1', 500]]),
    );
    const out = decideAutomation(running({ graph: unmeasured }), 0);
    expect(out.decision.kind).toBe('stand-down');
    expect(out.nextPhase).toBe('berthed');
  });

  it('STANDS DOWN when the model cannot estimate a distance for this loco', () => {
    const out = decideAutomation(
      running({ profile: { locoAddress: 3, maxSpeed: 126, brakingFactor: 5 } }),
      0,
    );
    expect(out.decision.kind).toBe('stand-down');
  });

  it('HOLDS for a train that has already stopped — there is nothing to brake', () => {
    const out = decideAutomation(
      running({ reservation: reservation({ confirmedIndex: 2 }), loco: loco({ speed: 0 }) }),
      0,
    );
    expect(out).toEqual({ decision: { kind: 'hold' }, nextPhase: 'running' });
  });

  it('credits a #77 lead fix in the available distance it reports', () => {
    // The lead term does not defer the trigger here — the look-ahead fires on
    // what happens *after* this block regardless — but it must still reach the
    // figure the plan is made against, or a run would be planned over less
    // track than the railway can actually promise.
    const out = decideAutomation(
      running({
        reservation: reservation({ confirmedIndex: 1 }),
        confirmedBlockObservations: [
          {
            sensorId: 'lead',
            blockId: 'b2',
            type: 'ir_position',
            inService: true,
            faulted: false,
            trusted: true,
            lastReading: 'occupied',
            lastReadingAt: NOW,
            lastLiveReadingAt: NOW,
            position: { towardBlockId: 'b3', offsetMm: 300 },
            lastRisingEdgeAt: NOW,
          },
        ],
      }),
      0,
    );
    expect(out.decision.kind).toBe('brake');
    if (out.decision.kind !== 'brake') return;
    expect(out.decision.availableMm).toBe(800);
  });
});

// ─── After the ramp (A4, B5) ───────────────────────────────────────────────────

describe('after the ramp', () => {
  const braking = (overrides: Partial<AutomationInput> = {}) =>
    input({ phase: 'braking', loco: loco({ speed: 40, direction: 'fwd' }), ...overrides });

  it('holds while the ramp is still issuing steps', () => {
    const out = decideAutomation(braking({ brakingRunInFlight: true, berthSensorId: 'berth' }), 400);
    expect(out).toEqual({ decision: { kind: 'hold' }, nextPhase: 'braking' });
  });

  it('retires a boundary stop, asserting nothing about where the train ended up', () => {
    // Reaching speed step 0 is a command, not a confirmation (B5). B5's own
    // overrun expectation outlives the ramp and is what still watches for it.
    const out = decideAutomation(braking(), 0);
    expect(out).toEqual({ decision: { kind: 'retire' }, nextPhase: 'berthed' });
  });

  it('moves a berthing run into the crawl', () => {
    const out = decideAutomation(braking({ berthSensorId: 'berth' }), 400);
    expect(out).toEqual({ decision: { kind: 'hold' }, nextPhase: 'crawling' });
  });
});

// ─── The crawl (A2, A11) ───────────────────────────────────────────────────────

describe('the crawl', () => {
  const crawling = (overrides: Partial<AutomationInput> = {}) =>
    input({
      phase: 'crawling',
      loco: loco({ speed: 8, direction: 'fwd' }),
      berthSensorId: 'berth',
      crawlStartedAt: NOW,
      ...overrides,
    });

  it('holds while the beam is unbroken and the timeout has not run out', () => {
    const out = decideAutomation(crawling({ now: after(30_000) }), 400);
    expect(out).toEqual({ decision: { kind: 'hold' }, nextPhase: 'crawling' });
  });

  it('BERTHS when the beam breaks — the one closed loop in the system', () => {
    const out = decideAutomation(crawling({ berthSensorOccupied: true, now: after(30_000) }), 400);
    expect(out).toEqual({ decision: { kind: 'berth' }, nextPhase: 'berthed' });
  });

  it('gives up on the beam after CRAWL_TIMEOUT_MS', () => {
    const out = decideAutomation(crawling({ now: after(CRAWL_TIMEOUT_MS) }), 400);
    expect(out).toEqual({
      decision: { kind: 'crawl-timeout', sensorId: 'berth' },
      nextPhase: 'berthed',
    });
  });

  it('prefers the arrival when the beam breaks on the very tick the timeout fires', () => {
    // Both are decided from the same `now`, and this is the only ordering under
    // which a working railway cannot be told it failed.
    const out = decideAutomation(
      crawling({ berthSensorOccupied: true, now: after(CRAWL_TIMEOUT_MS + 5_000) }),
      400,
    );
    expect(out.decision).toEqual({ kind: 'berth' });
  });

  it('crawls on well past a distance the dead-reckoning model would have stopped at (A5)', () => {
    // A5's load-bearing claim: the ramp is allowed to be as conservative as B4
    // makes it, because the crawl — not the model — is what stops the train.
    // Two minutes minus a tick of crawling is still a hold.
    const out = decideAutomation(crawling({ now: after(CRAWL_TIMEOUT_MS - 1) }), 400);
    expect(out.decision.kind).toBe('hold');
  });
});

// ─── A route that goes away underneath a run (A8) ──────────────────────────────

describe('a run whose route has gone', () => {
  const phases: AutomationPhase[] = ['awaiting-departure', 'running', 'braking'];

  it.each(phases)('retires a %s run when the reservation is gone', (phase) => {
    expect(decideAutomation(input({ phase, reservation: null }), 0).decision).toEqual({
      kind: 'retire',
    });
  });

  it.each(phases)('retires a %s run when the reservation is no longer active', (phase) => {
    const cancelled = reservation({ status: 'cancelled' });
    expect(decideAutomation(input({ phase, reservation: cancelled }), 0).decision).toEqual({
      kind: 'retire',
    });
  });

  it('CARRIES ON crawling when the reservation has gone — A8, and the whole reason it is not a bug', () => {
    // A route completes the instant its destination reads `occupied`, which is
    // as the train's front enters — long before a beam at the far end. The
    // crawl outliving its own reservation is the design, not an oversight.
    const out = decideAutomation(
      input({
        phase: 'crawling',
        reservation: null,
        loco: loco({ speed: 8, direction: 'fwd' }),
        berthSensorId: 'berth',
        crawlStartedAt: NOW,
        now: after(1_000),
      }),
      400,
    );
    expect(out).toEqual({ decision: { kind: 'hold' }, nextPhase: 'crawling' });
  });

  it.each(['cancelled', 'suspended'] as const)(
    'STANDS DOWN a crawl whose route was %s — stopping the train, not just dropping the run',
    (status) => {
      // The distinction A8 turns on: a route that *completed* is not a route
      // that was *taken away*. A crawl is the one phase whose speed automation
      // itself commanded and that nothing else reliably removes — a completed
      // route releases no throttle, and a mode change to manual suspends routes
      // without touching a train whose route already completed.
      const out = decideAutomation(
        input({
          phase: 'crawling',
          reservation: reservation({ status }),
          loco: loco({ speed: 8, direction: 'fwd' }),
          berthSensorId: 'berth',
          crawlStartedAt: NOW,
        }),
        400,
      );
      expect(out.decision).toEqual({ kind: 'stand-down', reason: `route is ${status}` });
      expect(out.nextPhase).toBe('berthed');
    },
  );

  it('does NOT stand down a crawl whose route merely completed', () => {
    // `released` is the normal ending: the destination block reads occupied as
    // the train's front enters, long before a beam at the far end.
    const out = decideAutomation(
      input({
        phase: 'crawling',
        reservation: reservation({ status: 'released' }),
        loco: loco({ speed: 8, direction: 'fwd' }),
        berthSensorId: 'berth',
        crawlStartedAt: NOW,
        now: after(1_000),
      }),
      400,
    );
    expect(out).toEqual({ decision: { kind: 'hold' }, nextPhase: 'crawling' });
  });

  it('still berths a routeless crawl when the beam breaks', () => {
    const out = decideAutomation(
      input({
        phase: 'crawling',
        reservation: null,
        loco: loco({ speed: 8, direction: 'fwd' }),
        berthSensorId: 'berth',
        berthSensorOccupied: true,
        crawlStartedAt: NOW,
      }),
      400,
    );
    expect(out.decision).toEqual({ kind: 'berth' });
  });

  it('retires a berthed run whatever else is true of it', () => {
    expect(decideAutomation(input({ phase: 'berthed' }), 0)).toEqual({
      decision: { kind: 'retire' },
      nextPhase: 'berthed',
    });
  });
});

// ─── Description ───────────────────────────────────────────────────────────────

describe('describeAutomationBlocker', () => {
  it('says what an operator has to go and set', () => {
    expect(describeAutomationBlocker({ kind: 'no-direction' })).toContain('which way round');
    expect(describeAutomationBlocker({ kind: 'no-auto-speed' })).toContain('automation speed step');
    expect(describeAutomationBlocker({ kind: 'not-in-roster' })).toContain('roster');
  });
});
