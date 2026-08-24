/**
 * Scenario: the automation engine (#7 PR B, see `docs/automation.md`).
 *
 * PR A shipped the decision layer and wired it to nothing. This file covers
 * what PR B added: the sweep, the departure, the brake trigger, the berthing
 * crawl, and every way a run is taken away from automation.
 *
 * #7's acceptance list asked for four scenarios. Three of them turn out to be
 * about mechanisms that already existed, and A1 explains why — so they are
 * written here as what they actually are, rather than as new machinery:
 *
 *  - *two trains converging on one block* — refused at **grant** by D2's
 *    exclusivity, not avoided at runtime;
 *  - *a train losing position mid-approach* — the block reads `unknown`, which
 *    Safe-Stops through the existing route-occupancy path;
 *  - *an operator taking manual control* — D6 cancels the route, and A12 adds
 *    only the teardown of the run.
 *
 * The fourth, an emergency stop mid-movement, is genuinely new here because
 * there is now something moving to stop.
 *
 * Fixture — a straight run of four measured blocks with a berthing beam in the
 * last, which is Westgate Hollow's platform road in miniature:
 *
 *   b1 --e1--> b2 --e2--> b3 --e3--> b4
 *   500mm      500mm      500mm      500mm
 *                                    berth beam 400mm in, measured toward b3
 *
 * Loco 3 runs at `autoSpeedStep` 60 and crawls at 8. At speed 60 the model
 * predicts 113mm and requires 213mm with B5's margin, so the distance trigger
 * sits at 338mm. The berth is 400mm, which is deliberately *more* than that —
 * so what actually fires as the train reaches b3 is A6's **planning horizon**,
 * not the distance trigger. That is the ordinary case on this railway and the
 * one worth pinning.
 */

import { describe, it, expect } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { AUTOMATION_TICK_MS, CRAWL_TIMEOUT_MS } from '../../src/domain/automation';
import { BRAKING_TICK_MS } from '../../src/domain/braking';

const LOCO_3 = {
  id: 'loco-3',
  layoutId: LAYOUT_ID,
  name: 'Loco 3',
  address: 3,
  type: 'diesel',
  maxSpeed: 126,
  brakingFactor: 0.5,
  autoSpeedStep: 60,
  crawlSpeedStep: 8,
};

const BLOCKS = ['b1', 'b2', 'b3', 'b4'].map((id, i) => ({
  id,
  layoutId: LAYOUT_ID,
  name: `Block ${i + 1}`,
  lengthMm: 500,
}));

const DETECTORS = ['b1', 'b2', 'b3', 'b4'].map((blockId, i) => ({
  id: `s${i + 1}`,
  layoutId: LAYOUT_ID,
  name: `Sensor ${i + 1}`,
  type: 'block_detection' as const,
  blockId,
  mqttTopic: `layout/${LAYOUT_ID}/sensor/s${i + 1}/reading`,
  inService: true,
  positionTowardBlockId: null,
  positionOffsetMm: null,
}));

/** The berthing beam: 400mm into b4, measured back toward the block the train arrives from (A3's terminal-platform form). */
const BERTH_BEAM = {
  id: 'berth',
  layoutId: LAYOUT_ID,
  name: 'Platform Beam',
  type: 'ir_position' as const,
  blockId: 'b4',
  mqttTopic: `layout/${LAYOUT_ID}/sensor/berth/reading`,
  inService: true,
  positionTowardBlockId: 'b3',
  positionOffsetMm: 400,
};

type Harness = ReturnType<typeof createScenarioHarness>;

/**
 * Advances virtual time far enough for the automation sweep to fire and for
 * everything it triggers to settle.
 *
 * The harness's own `advance` flushes twice, which is enough for the point
 * controller. A sweep is deeper: it awaits the roster, then a decision, then a
 * DCC command, then — on a brake — a whole `startRouteStop`. Four extra hops
 * covers it without depending on how many awaits any one path happens to have.
 */
async function tick(h: Harness, ms: number = AUTOMATION_TICK_MS): Promise<void> {
  await h.advance(ms);
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
}

async function seedAndStart(h: Harness, options: { berth?: boolean } = {}): Promise<void> {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints([]);
  h.repo._setSensors(options.berth === false ? DETECTORS : [...DETECTORS, BERTH_BEAM]);
  h.repo._setLocos([LOCO_3]);
  // One row per direction, as the compiler emits them (#103). The reverse rows
  // are not decoration: `berthingBeamIn` resolves its anchor through
  // `isAnchorUnambiguous`, which counts edges *from* the beam's own block — so
  // without an edge b4 → b3 the platform beam's anchor reads as describing no
  // boundary at all, and the berth is silently declined.
  for (const [from, to] of [['b1', 'b2'], ['b2', 'b3'], ['b3', 'b4']] as const) {
    await h.repo.createBlockEdge({
      layoutId: LAYOUT_ID,
      fromBlockId: from,
      fromEnd: 'east',
      toBlockId: to,
      toEnd: 'west',
      pointConditions: [],
      lengthMm: null,
    });
    await h.repo.createBlockEdge({
      layoutId: LAYOUT_ID,
      fromBlockId: to,
      fromEnd: 'west',
      toBlockId: from,
      toEnd: 'east',
      pointConditions: [],
      lengthMm: null,
    });
  }

  await h.start();

  await h.sensorReports('s2', 'clear');
  await h.sensorReports('s3', 'clear');
  await h.sensorReports('s4', 'clear');
  // A beam must have reported something to be a contributing sensor, and so to
  // be selectable as a berth (A3). An `ir_position` reading `clear` changes no
  // block's occupancy — `deriveBlockOccupancy` clause 2 only lets a
  // `block_detection` sensor assert a block is empty (#77 D8).
  if (options.berth !== false) await h.sensorReports('berth', 'clear');
}

async function edgeIds(h: Harness): Promise<string[]> {
  const edges = await h.repo.listBlockEdges(LAYOUT_ID);
  return ([['b1', 'b2'], ['b2', 'b3'], ['b3', 'b4']] as const).map(([from, to]) => {
    const edge = edges.find((e) => e.fromBlockId === from && e.toBlockId === to);
    if (!edge) throw new Error(`no edge ${from} -> ${to}`);
    return edge.id;
  });
}

/** Seeds, puts loco 3 in b1, grants an auto route b1 → b4, and switches to `auto` mode. Nothing has moved yet. */
async function routed(
  h: Harness,
  options: { direction?: 'fwd' | 'rev' | null; berth?: boolean } = {},
): Promise<string> {
  await seedAndStart(h, options);
  await h.sensorReports('s1', 'occupied');

  const [e1, e2, e3] = await edgeIds(h);
  const grant = await h.service.requestRoute({
    locoAddress: 3,
    authority: 'auto',
    direction: options.direction === undefined ? 'fwd' : options.direction,
    startBlockId: 'b1',
    path: { kind: 'edges', edgeIds: [e1, e2, e3] },
  });
  if (!grant.granted) throw new Error('expected the route to be granted');

  await h.service.handleSetMode({ mode: 'auto' });
  h.dcc.clearLog();
  return grant.reservation.id;
}

/** Every `setSpeed` issued for loco 3, in order. */
function speedCommands(h: Harness): Array<{ speed: number; direction: string }> {
  return h.dcc.commandLog
    .filter((c) => c.type === 'SET_SPEED' && c.data.address === 3)
    .map((c) => ({ speed: c.data.speed as number, direction: c.data.direction as string }));
}

// ─── Departure (A7) ────────────────────────────────────────────────────────────

describe('automated departure', () => {
  it('departs the train at its roster speed in the direction the route states', async () => {
    const h = createScenarioHarness();
    await routed(h);

    await tick(h);

    expect(speedCommands(h)).toEqual([{ speed: 60, direction: 'fwd' }]);
    // A departure takes the loco, unlike a braking ramp step, which
    // deliberately leaves `authority` alone (B12).
    expect(h.service.getAllState().locos.get(3)?.authority).toBe('auto');
  });

  it('departs once, not on every tick', async () => {
    const h = createScenarioHarness();
    await routed(h);

    await tick(h);
    await tick(h);
    await tick(h);

    expect(speedCommands(h)).toEqual([{ speed: 60, direction: 'fwd' }]);
  });

  it('never departs a route that states no direction, and raises no fault for it', async () => {
    // A7: nothing can derive which way round a loco sits, and a config gap is
    // not a reason to halt a railway.
    const h = createScenarioHarness();
    await routed(h, { direction: null });

    await tick(h);
    await tick(h);

    expect(speedCommands(h)).toEqual([]);
    expect(h.service.getBrakingFaults()).toEqual([]);
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('never departs a loco with no automation speed step, and raises no fault for it', async () => {
    const h = createScenarioHarness();
    h.repo._setLocos([{ ...LOCO_3, autoSpeedStep: null }]);
    await routed(h);
    h.repo._setLocos([{ ...LOCO_3, autoSpeedStep: null }]);

    await tick(h);

    expect(speedCommands(h)).toEqual([]);
    expect(h.service.getBrakingFaults()).toEqual([]);
  });

  it('never starts a journey it could not stop at the end of', async () => {
    // A7's departure check. The route is b3 → b4 with no berthing beam, so the
    // stopping point is b4's entry boundary and there is no intermediate track
    // at all — B4's adjacent-target case. Departing and *then* discovering that
    // would halt the layout with `unable-to-stop` a quarter of a second later,
    // to say something that could have been said before anything moved.
    const h = createScenarioHarness({});
    await seedAndStart(h, { berth: false });
    await h.sensorReports('s3', 'occupied');
    const [, , e3] = await edgeIds(h);
    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'auto',
      direction: 'fwd',
      startBlockId: 'b3',
      path: { kind: 'edges', edgeIds: [e3] },
    });
    if (!grant.granted) throw new Error('expected the route to be granted');
    await h.service.handleSetMode({ mode: 'auto' });
    h.dcc.clearLog();

    await tick(h);
    await tick(h);

    expect(speedCommands(h)).toEqual([]);
    // A blocker, not a fault: this names a layout that has not been beamed yet,
    // which is an operator's job to finish and not a reason to halt a railway.
    expect(h.service.getBrakingFaults()).toEqual([]);
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('DOES start that same journey once a berthing beam gives it somewhere to stop', async () => {
    // The other half of the previous test, and the reason it is a coverage
    // limit rather than a model one: fitting a beam changes the answer with no
    // code change at all.
    const h = createScenarioHarness({});
    await seedAndStart(h);
    await h.sensorReports('s3', 'occupied');
    const [, , e3] = await edgeIds(h);
    await h.service.requestRoute({
      locoAddress: 3,
      authority: 'auto',
      direction: 'fwd',
      startBlockId: 'b3',
      path: { kind: 'edges', edgeIds: [e3] },
    });
    await h.service.handleSetMode({ mode: 'auto' });
    h.dcc.clearLog();

    await tick(h);

    expect(speedCommands(h)).toEqual([{ speed: 60, direction: 'fwd' }]);
  });

  it('never starts a journey over unmeasured track', async () => {
    // The same check catching the other refusal it exists for. Without it the
    // train departs and then never brakes at all: `remainingRouteDistanceMm`
    // refuses for as long as the block stays unmeasured, so A6's trigger has
    // nothing to fire on and the train coasts to the end of its authority.
    const h = createScenarioHarness({});
    h.repo._setBlocks(BLOCKS.map((b) => (b.id === 'b3' ? { ...b, lengthMm: null } : b)));
    await seedAndStart(h);
    h.repo._setBlocks(BLOCKS.map((b) => (b.id === 'b3' ? { ...b, lengthMm: null } : b)));
    await h.service.reloadTopology();
    await h.sensorReports('s1', 'occupied');

    const [e1, e2, e3] = await edgeIds(h);
    await h.service.requestRoute({
      locoAddress: 3,
      authority: 'auto',
      direction: 'fwd',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: [e1, e2, e3] },
    });
    await h.service.handleSetMode({ mode: 'auto' });
    h.dcc.clearLog();

    await tick(h);
    await tick(h);

    expect(speedCommands(h)).toEqual([]);
    expect(h.service.getBrakingFaults()).toEqual([]);
  });

  it('does not touch a manual-authority route (A12)', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    const [e1, e2, e3] = await edgeIds(h);
    await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      direction: 'fwd',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: [e1, e2, e3] },
    });
    await h.service.handleSetMode({ mode: 'auto' });
    h.dcc.clearLog();

    await tick(h);
    await tick(h);

    expect(speedCommands(h)).toEqual([]);
  });

  it('does nothing at all in manual mode', async () => {
    const h = createScenarioHarness();
    await routed(h);
    await h.service.handleSetMode({ mode: 'manual' });
    h.dcc.clearLog();

    await tick(h);

    expect(speedCommands(h)).toEqual([]);
  });
});

// ─── The approach, the crawl, and the berth (A2, A5, A6) ───────────────────────

describe('an automated run from departure to berth', () => {
  it('runs through the intermediate block, brakes at the planning horizon, crawls, and stops on the beam', async () => {
    const h = createScenarioHarness();
    await routed(h);

    // Depart.
    await tick(h);
    expect(speedCommands(h)).toEqual([{ speed: 60, direction: 'fwd' }]);

    // Into b2. Two blocks still ahead of the target, and 900mm of measured
    // track — well outside the 338mm distance trigger.
    await h.sensorReports('s2', 'occupied');
    await h.sensorReports('s1', 'clear');
    await tick(h);
    expect(speedCommands(h)).toEqual([{ speed: 60, direction: 'fwd' }]);

    // Into b3 — the last block a plan can be made from (A6). The 400mm berth
    // beyond still looks like room to the distance trigger; the look-ahead is
    // what fires, because there is no further confirmation to wait for.
    await h.sensorReports('s3', 'occupied');
    await h.sensorReports('s2', 'clear');
    await tick(h);

    // Run the ramp out. Each step is one `BRAKING_TICK_MS`, chained (B12).
    for (let i = 0; i < 10; i++) await tick(h, BRAKING_TICK_MS);

    const ramp = speedCommands(h).slice(1);
    expect(ramp.length).toBeGreaterThan(0);
    // A4: the ramp ends at the crawl step, not at a stand, and keeps its
    // direction — a crawling train is still moving.
    expect(ramp.at(-1)).toEqual({ speed: 8, direction: 'fwd' });
    expect(ramp.every((c) => c.direction === 'fwd')).toBe(true);
    expect(ramp.map((c) => c.speed)).toEqual([52, 44, 36, 28, 20, 12, 8]);
  });

  it('stops the train when the berthing beam breaks, and faults nothing', async () => {
    const h = createScenarioHarness();
    await routed(h);
    await tick(h);
    await h.sensorReports('s2', 'occupied');
    await h.sensorReports('s3', 'occupied');
    await tick(h);

    // Run the ramp out to the crawl.
    for (let i = 0; i < 10; i++) await tick(h, BRAKING_TICK_MS);
    expect(speedCommands(h).at(-1)).toEqual({ speed: 8, direction: 'fwd' });

    // The train's front enters b4. The route COMPLETES here — long before the
    // beam at the far end — which is exactly why A8 keeps the run alive.
    await h.sensorReports('s4', 'occupied');
    await tick(h);
    expect(speedCommands(h).at(-1)).toEqual({ speed: 8, direction: 'fwd' });

    // The beam breaks: the one closed loop in the system closing.
    await h.sensorReports('berth', 'occupied');
    await tick(h);

    expect(speedCommands(h).at(-1)).toEqual({ speed: 0, direction: 'stop' });
    expect(h.service.getBrakingFaults()).toEqual([]);
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('does not fault the arrival as an overrun, which the ordinary expectation would (A9)', async () => {
    // `buildStopExpectation(reservation, targetIndex)` forbids b4, so armed
    // unchanged a textbook berthing arrival would Safe-Stop the layout at the
    // instant it succeeded. A berthing run arms the track BEYOND the route
    // instead — and b4 is terminal here, so that set is empty.
    const h = createScenarioHarness();
    await routed(h);
    await tick(h);
    await h.sensorReports('s2', 'occupied');
    await h.sensorReports('s3', 'occupied');
    await tick(h);
    for (let i = 0; i < 10; i++) await tick(h, BRAKING_TICK_MS);

    await h.sensorReports('s4', 'occupied');
    await tick(h);

    expect(h.service.getBrakingFaults()).toEqual([]);
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('falls back to a stop at the destination boundary when there is no beam (A2)', async () => {
    const h = createScenarioHarness();
    await routed(h, { berth: false });
    await tick(h);
    await h.sensorReports('s2', 'occupied');
    await h.sensorReports('s3', 'occupied');
    await tick(h);

    const ramp = speedCommands(h).slice(1);
    // Ends at a stand, not a crawl: no beam, so no berthing, so B4's behaviour
    // unchanged. Coverage, not model — fitting a beam changes it with no code.
    expect(ramp.at(-1)).toEqual({ speed: 0, direction: 'stop' });
  });
});

// ─── A11's backstop ────────────────────────────────────────────────────────────

describe('a berthing crawl that never reaches its beam', () => {
  it('stops the train and latches berth-not-confirmed', async () => {
    const h = createScenarioHarness();
    await routed(h);
    await tick(h);
    await h.sensorReports('s2', 'occupied');
    await h.sensorReports('s3', 'occupied');
    await tick(h);
    for (let i = 0; i < 10; i++) await tick(h, BRAKING_TICK_MS);
    await h.sensorReports('s4', 'occupied');
    await tick(h);

    // The beam never breaks.
    await tick(h, CRAWL_TIMEOUT_MS);

    expect(speedCommands(h).at(-1)).toEqual({ speed: 0, direction: 'stop' });
    const faults = h.service.getBrakingFaults();
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({ locoAddress: 3, kind: 'berth-not-confirmed' });
    expect(faults[0].reason).toContain('Platform Beam');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
  });
});

// ─── The operator surface (#7 PR C) ────────────────────────────────────────────

describe('AUTOMATION_STATE', () => {
  const automationEvents = (h: Harness) => h.events.filter((e) => e.type === 'AUTOMATION_STATE');

  it('is published when a run changes phase, and NOT on the ticks in between', async () => {
    // The sweep runs four times a second and is usually a no-op. Publishing
    // unconditionally would put 240 messages a minute on every open socket to
    // say nothing — the same argument `recomputeBlock` makes for BLOCK_STATE.
    const h = createScenarioHarness();
    await routed(h);

    await tick(h);
    const afterDeparture = automationEvents(h).length;
    expect(afterDeparture).toBeGreaterThan(0);
    expect(automationEvents(h).at(-1)?.payload.runs).toMatchObject([
      { locoAddress: 3, phase: 'running' },
    ]);

    // Three quiet sweeps: the train is running, nothing has changed.
    await tick(h);
    await tick(h);
    await tick(h);
    expect(automationEvents(h)).toHaveLength(afterDeparture);

    // Reaching the braking phase is a change, so it is published.
    await h.sensorReports('s2', 'occupied');
    await h.sensorReports('s3', 'occupied');
    await tick(h);
    expect(automationEvents(h).length).toBeGreaterThan(afterDeparture);
    expect(automationEvents(h).at(-1)?.payload.runs).toMatchObject([{ phase: 'braking' }]);
  });

  it('carries the blocker sentence, which is the one automation state visible nowhere else', async () => {
    // An active route, auto mode, and a train that is simply not moving — from
    // outside that is indistinguishable from a train that has arrived.
    const h = createScenarioHarness();
    await routed(h, { direction: null });

    await tick(h);

    const runs = automationEvents(h).at(-1)?.payload.runs;
    expect(runs).toHaveLength(1);
    expect(runs?.[0].phase).toBe('awaiting-departure');
    expect(runs?.[0].blocker).toContain('which way round');
  });

  it('empties when the run is torn down', async () => {
    const h = createScenarioHarness();
    await routed(h);
    await tick(h);

    await h.service.handleThrottleCommand({ locoAddress: 3, speed: 90, direction: 'fwd' });
    await tick(h);

    expect(automationEvents(h).at(-1)?.payload.runs).toEqual([]);
    expect(h.service.getAutomationRuns()).toEqual([]);
  });
});

// ─── #7's acceptance list, as A1 rewrites it ───────────────────────────────────

describe('two trains converging on one block', () => {
  it('is refused at GRANT by exclusivity, not avoided at runtime', async () => {
    // A1: `planReservation` will not grant two routes over one block, so
    // convergence is settled before either train moves and needs no runtime
    // avoidance. This is asserted rather than assumed because it is the whole
    // reason #7's scope is "never pass the end of your authority".
    const h = createScenarioHarness();
    await routed(h);
    h.repo._setLocos([LOCO_3, { ...LOCO_3, id: 'loco-9', name: 'Loco 9', address: 9 }]);

    const [, , e3] = await edgeIds(h);
    const second = await h.service.requestRoute({
      locoAddress: 9,
      authority: 'auto',
      direction: 'fwd',
      startBlockId: 'b3',
      path: { kind: 'edges', edgeIds: [e3] },
    });

    expect(second.granted).toBe(false);
    if (second.granted) return;
    expect(second.rejections.some((r) => r.kind === 'block-locked')).toBe(true);
  });
});

describe('a train losing position mid-approach', () => {
  it('Safe-Stops when a block the route holds becomes undeterminable, and takes the run with it', async () => {
    const h = createScenarioHarness();
    await routed(h);
    await tick(h);
    await h.sensorReports('s2', 'occupied');
    await tick(h);

    // b2's detector goes out of service: the block can no longer be determined,
    // which is the honest spelling of "we no longer know where the train is".
    await h.service.updateSensorConfig(LAYOUT_ID, 's2', { inService: false });
    await tick(h);

    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    // No further automation commands: the run is gone, and the sweep is gated
    // on `canIssueAutoCommand` anyway.
    const before = speedCommands(h).length;
    await tick(h);
    await tick(h);
    expect(speedCommands(h).length).toBe(before);
  });
});

describe('an operator taking manual control of an automated loco', () => {
  it('cancels the route (D6) and tears the run down (A12)', async () => {
    const h = createScenarioHarness();
    const routeId = await routed(h);
    await tick(h);
    expect(speedCommands(h)).toEqual([{ speed: 60, direction: 'fwd' }]);

    await h.service.handleThrottleCommand({ locoAddress: 3, speed: 90, direction: 'fwd' });

    expect(h.service.listRoutes().find((r) => r.id === routeId)?.status).toBe('cancelled');
    expect(h.service.getAllState().locos.get(3)?.authority).toBe('manual');

    // The operator's command stands: automation issues nothing further, and in
    // particular does not brake a train it no longer owns.
    const after = speedCommands(h).length;
    await tick(h);
    await tick(h);
    expect(speedCommands(h).length).toBe(after);
  });
});

describe('an emergency stop during an automated movement', () => {
  it('stops the train and leaves automation with nothing in flight', async () => {
    const h = createScenarioHarness();
    await routed(h);
    await tick(h);

    await h.service.handleEmergencyStop();
    expect(h.dcc.commandLog.some((c) => c.type === 'EMERGENCY_STOP')).toBe(true);

    // B6's rule, extended to automation: no later sweep may re-command a speed
    // step after the broadcast stop has gone out.
    const after = speedCommands(h).length;
    await tick(h);
    await tick(h);
    expect(speedCommands(h).length).toBe(after);
    expect(h.service.getAllState().locos.get(3)?.speed).toBe(0);
  });
});

describe('leaving automation mid-crawl', () => {
  it('stops a crawling train when the operator switches to manual (A13)', async () => {
    // Not covered by `suspendAuto`: the route completed as the train's front
    // entered b4, so there is no `active` auto route left to suspend and
    // nothing else would touch a train still crawling under automation's own
    // commanded speed.
    const h = createScenarioHarness();
    await routed(h);
    await tick(h);
    await h.sensorReports('s2', 'occupied');
    await h.sensorReports('s3', 'occupied');
    await tick(h);
    for (let i = 0; i < 10; i++) await tick(h, BRAKING_TICK_MS);
    await h.sensorReports('s4', 'occupied');
    await tick(h);
    expect(speedCommands(h).at(-1)).toEqual({ speed: 8, direction: 'fwd' });

    await h.service.handleSetMode({ mode: 'manual' });

    expect(speedCommands(h).at(-1)).toEqual({ speed: 0, direction: 'stop' });
  });
});

describe('track power going off during an automated movement (#149)', () => {
  it('abandons a run already under way, and does not resume it when power returns', async () => {
    const h = createScenarioHarness();
    await routed(h);
    await tick(h);

    // The train is under way at its roster speed.
    expect(speedCommands(h).at(-1)).toEqual({ speed: 60, direction: 'fwd' });

    // The station cuts power, or an operator switches it off. Either way the
    // train coasts to a stand, and the orchestrator learns of it through a
    // `<p0 MAIN>` on the response channel.
    h.dcc.setSimulatedPower('main', false);

    const after = speedCommands(h).length;
    await tick(h);
    await tick(h);
    await tick(h);
    expect(speedCommands(h).length).toBe(after);
    expect(h.service.getAutomationRuns()).toEqual([]);

    // Not a Safe-Stop, and nothing latched: the layout is already stopped.
    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getRouteFaults()).toEqual([]);

    // Power comes back and the run does NOT resume. That is the `adopted` set
    // doing the job it does after an emergency stop — a route is taken at most
    // once while it stays `active`. It is the right answer here too: a train
    // that coasted to a stand is no longer where its plan believes it is, and
    // resuming automation over that is exactly the guess this system refuses to
    // make. The operator requests a new route.
    h.dcc.setSimulatedPower('main', true);
    await tick(h);
    await tick(h);
    expect(speedCommands(h).length).toBe(after);
    expect(h.service.getAutomationRuns()).toEqual([]);
  });

  it('never departs a route that was granted before the power went off', async () => {
    // The case `adopted` cannot cover, and the reason the sweep is gated on
    // power as well as on status and mode: this route has never been taken, so
    // there is nothing to abandon and nothing marking it as already-run. A
    // sweep that only asked `canIssueAutoCommand` would find an unowned active
    // auto route and depart the train into dead rails — and the train would
    // leap into motion the moment `<1>` was sent.
    const h = createScenarioHarness();
    await routed(h); // granted and in auto mode, but never ticked, so never departed
    expect(speedCommands(h)).toEqual([]);

    h.dcc.setSimulatedPower('main', false);

    await tick(h);
    await tick(h);
    await tick(h);

    expect(speedCommands(h)).toEqual([]);
    expect(h.service.getAutomationRuns()).toEqual([]);
    expect(h.service.getSystemStatus().status).toBe('online');
  });
});
