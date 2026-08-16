/**
 * Scenario: braking runs (#6 PR B, see docs/braking.md).
 *
 * PR A shipped the model — a pure schedule and a planning service. This file
 * covers what PR B added: executing that schedule against the injected
 * `IClock`, B5's armed overrun check, and every failure path in B6's table.
 *
 * Deliberately **not** a physics simulation. B4's "limits recorded rather
 * than closed" is explicit that a fake train whose constants were chosen to
 * match this model would prove nothing about the real layout — so what these
 * scenarios assert is the *command trace* (which `setSpeed` calls went out,
 * in what order, at what virtual time), the latched faults, and the Safe-Stop
 * transitions. Real distance validation is B8's on-layout ruler procedure.
 *
 * Fixture layout — a straight run of four measured blocks:
 *
 *   b1 --e1--> b2 --e2--> b3 --e3--> b4
 *   500mm      500mm      500mm      500mm
 *
 * A route b1 → b4 with the train confirmed in b1 gives B4's intermediate sum
 * as b2 + b3 = 1000 mm. At speed step 126 with `brakingFactor` 0.5 the model
 * predicts 500 mm and requires 625 mm with B5's margin — so the run is
 * granted, and the numbers are far enough apart that a change to either
 * constant fails loudly rather than flipping a borderline case.
 */

import { describe, it, expect, vi } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { BRAKING_TICK_MS } from '../../src/domain/braking';

const LOCO_3 = {
  id: 'loco-3',
  layoutId: LAYOUT_ID,
  name: 'Loco 3',
  address: 3,
  type: 'diesel',
  maxSpeed: 126,
  brakingFactor: 0.5,
};

const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1', lengthMm: 500 },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2', lengthMm: 500 },
  { id: 'b3', layoutId: LAYOUT_ID, name: 'Block 3', lengthMm: 500 },
  { id: 'b4', layoutId: LAYOUT_ID, name: 'Block 4', lengthMm: 500 },
];

const SENSORS = ['b1', 'b2', 'b3', 'b4'].map((blockId, i) => ({
  id: `s${i + 1}`,
  layoutId: LAYOUT_ID,
  name: `Sensor ${i + 1}`,
  type: 'block_detection' as const,
  blockId,
  mqttTopic: `layout/${LAYOUT_ID}/sensor/s${i + 1}/reading`,
  inService: true,
}));

type Harness = ReturnType<typeof createScenarioHarness>;

/** Seeds the four-block fixture, starts the service, and asserts b2–b4 clear. */
async function seedAndStart(h: Harness): Promise<void> {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints([]);
  h.repo._setSensors(SENSORS);
  h.repo._setLocos([LOCO_3]);
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
  }

  await h.start();

  await h.sensorReports('s2', 'clear');
  await h.sensorReports('s3', 'clear');
  await h.sensorReports('s4', 'clear');
}

async function edgeIds(h: Harness): Promise<string[]> {
  const edges = await h.repo.listBlockEdges(LAYOUT_ID);
  return ['b1', 'b2', 'b3'].map((from) => {
    const edge = edges.find((e) => e.fromBlockId === from);
    if (!edge) throw new Error(`no edge from ${from}`);
    return edge.id;
  });
}

/**
 * Seeds, starts, puts loco 3 in b1 at full speed under an auto-authority
 * route to b4, and switches the system to `auto` — the state every
 * route-braking scenario below starts from.
 */
async function routedAtFullSpeed(h: Harness): Promise<string> {
  await seedAndStart(h);
  await h.sensorReports('s1', 'occupied');

  // The throttle command comes FIRST, deliberately: a manual throttle for a
  // loco under an auto-authority route cancels that route (D6,
  // docs/route-locking.md), so setting the speed afterwards would quietly
  // dismantle the fixture. There is no other way to give a loco a commanded
  // speed — B7's open-loop model has no "observed speed" seam to set.
  await h.service.handleThrottleCommand({ locoAddress: 3, speed: 126, direction: 'fwd' });

  const [e1, e2, e3] = await edgeIds(h);
  const grant = await h.service.requestRoute({
    locoAddress: 3,
    authority: 'auto',
    startBlockId: 'b1',
    path: { kind: 'edges', edgeIds: [e1, e2, e3] },
  });
  if (!grant.granted) throw new Error('expected the route to be granted');

  await h.service.handleSetMode({ mode: 'auto' });
  h.dcc.clearLog();
  return grant.reservation.id;
}

/** Every `setSpeed` in the command log, as `[speed, direction]` pairs. */
function speedCommands(h: Harness): Array<[number, string]> {
  return h.dcc.commandLog
    .filter((c) => c.type === 'SET_SPEED')
    .map((c) => [c.data.speed as number, c.data.direction as string]);
}

describe('scenario: braking runs', () => {
  it('1. runs the whole ramp on the injected clock — sixteen commands from 126 to a stop, one every 250ms', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h);

    const outcome = await h.service.startRouteStop(routeId);

    expect(outcome.started).toBe(true);
    if (!outcome.started) return;
    // 126 shed 8 steps at a time: 16 commands, the last of them a stop.
    expect(outcome.schedule.steps).toHaveLength(16);
    expect(outcome.schedule.totalDurationMs).toBe(15 * BRAKING_TICK_MS);
    expect(outcome.schedule.estimatedStoppingDistanceMm).toBe(500);
    expect(outcome.schedule.requiredDistanceMm).toBe(625);

    // The first step goes out inline, before any time passes — B6's "rejected
    // on step 0" case can only be reported to a caller if it is awaited here.
    expect(speedCommands(h)).toEqual([[118, 'fwd']]);

    // Half the ramp.
    await h.advance(4 * BRAKING_TICK_MS);
    expect(speedCommands(h)).toEqual([
      [118, 'fwd'],
      [110, 'fwd'],
      [102, 'fwd'],
      [94, 'fwd'],
      [86, 'fwd'],
    ]);

    await h.advance(20 * BRAKING_TICK_MS);
    const commands = speedCommands(h);
    expect(commands).toHaveLength(16);
    expect(commands[commands.length - 1]).toEqual([0, 'stop']);
    // No step is ever issued twice, and none is skipped.
    expect(commands.map(([speed]) => speed)).toEqual(
      outcome.schedule.steps.map((s) => s.speedStep),
    );

    // The loco's published state follows the ramp down, so a browser sees the
    // train slow rather than jump to zero at the end.
    expect(h.service.getAllState().locos.get(3)?.speed).toBe(0);
    expect(h.service.getAllState().locos.get(3)?.direction).toBe('stop');

    // Nothing faulted, and the layout is still running.
    expect(h.service.getBrakingFaults()).toEqual([]);
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('2. latches an overrun and Safe-Stops when the target block reports occupied — the arrival a reservation cannot tell from an overrun (B5)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h);

    await h.service.startRouteStop(routeId);
    await h.advance(20 * BRAKING_TICK_MS);
    expect(h.service.getBrakingFaults()).toEqual([]);

    // The train did not stop short of b4 — it rolled into it. Under the
    // reservation engine alone this reads as a textbook arrival.
    await h.sensorReports('s4', 'occupied');

    const faults = h.service.getBrakingFaults();
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe('overrun');
    expect(faults[0].locoAddress).toBe(3);
    expect(faults[0].blockId).toBe('b4');
    // Named, not id-only — the NameBook is wired through the harness (#54).
    expect(faults[0].reason).toContain('Block 4');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    // The braking fault is what the operator is *told*, even though the route
    // violation below latched from the same reading — B10's priority puts the
    // cause above its symptom.
    expect(h.service.getSystemStatus().reason).toContain('overran');

    // Two latches for one event, deliberately, exactly as #25 D8 pairs a
    // point fault with a route fault. Checking the overrun BEFORE handing the
    // occupancy to the reservation engine is what makes this pair possible:
    // the route ends `cancelled` with a violation rather than `completed`,
    // which is the false success B5 exists to prevent.
    const routeFaults = h.service.getRouteFaults();
    expect(routeFaults).toHaveLength(1);
    expect(routeFaults[0].kind).toBe('unexpected-occupancy');
    expect(h.service.listRoutes().map((r) => r.status)).toEqual(['cancelled']);

    // The expectation is disarmed as it fires: a second reading from the same
    // block must not re-latch, or the fault could never be acknowledged away.
    await h.sensorReports('s4', 'clear');
    await h.sensorReports('s4', 'occupied');
    expect(h.service.getBrakingFaults()).toHaveLength(1);

    const ack = await h.service.acknowledgeBrakingFault(LAYOUT_ID, 3);
    expect(ack.cleared).toBe(true);
    expect(h.service.getBrakingFaults()).toEqual([]);
    // Still stopped, and now naming the route violation — acknowledging one
    // fact does not resolve the other. There is no arming threshold on either
    // (B10): the operator's acknowledgement IS the recovery.
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toContain('unexpected occupancy');

    await h.service.acknowledgeRouteFault(LAYOUT_ID, routeId);
    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.listRoutes(['active'])).toEqual([]);
  });

  it('3. aborts the ramp, latches a fault and Safe-Stops when a speed command is rejected mid-ramp (B6)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h);

    await h.service.startRouteStop(routeId);
    await h.advance(BRAKING_TICK_MS);
    expect(speedCommands(h)).toHaveLength(2);

    const setSpeed = vi.spyOn(h.dcc, 'setSpeed');
    setSpeed.mockRejectedValueOnce(new Error('DCC write failed'));

    await h.advance(BRAKING_TICK_MS);

    const faults = h.service.getBrakingFaults();
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe('speed-command-rejected');
    expect(faults[0].reason).toContain('DCC write failed');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    // The ramp is dead: the remaining thirteen steps never go out, however
    // long the clock runs. (Safe-Stop's own broadcast emergency stop is a
    // different command type and is not counted here.)
    const before = speedCommands(h).length;
    await h.advance(20 * BRAKING_TICK_MS);
    expect(speedCommands(h)).toHaveLength(before);
  });

  it('4. reports started:false AND latches a fault when the very first command is rejected (B6)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h);

    vi.spyOn(h.dcc, 'setSpeed').mockRejectedValueOnce(new Error('DCC offline'));

    const outcome = await h.service.startRouteStop(routeId);

    // Both halves matter: the caller is told nothing started, *and* the train
    // is still moving at its pre-braking speed and is now uncommandable —
    // which is the hazard, not the failed API call.
    expect(outcome).toEqual({
      started: false,
      reason: { kind: 'command-rejected', message: 'DCC offline' },
    });
    expect(h.service.getBrakingFaults()).toHaveLength(1);
    expect(h.service.getBrakingFaults()[0].kind).toBe('speed-command-rejected');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    // No expectation was armed by a run that never issued a command: b4 going
    // occupied adds nothing to the one fault already latched.
    await h.sensorReports('s4', 'occupied');
    expect(h.service.getBrakingFaults()).toHaveLength(1);
  });

  it('5. lets a manual throttle command win — the ramp stops commanding and its overrun expectation is dropped (B6, D6)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h);

    await h.service.startRouteStop(routeId);
    await h.advance(BRAKING_TICK_MS);
    expect(speedCommands(h)).toEqual([[118, 'fwd'], [110, 'fwd']]);

    await h.service.handleThrottleCommand({ locoAddress: 3, speed: 40, direction: 'fwd' });
    await h.advance(20 * BRAKING_TICK_MS);

    // The operator's command is the last thing said to the decoder.
    expect(speedCommands(h)).toEqual([[118, 'fwd'], [110, 'fwd'], [40, 'fwd']]);
    expect(h.service.getAllState().locos.get(3)?.speed).toBe(40);

    // And the blocks the run had promised the train would not reach are the
    // operator's to enter now.
    await h.sensorReports('s4', 'occupied');
    expect(h.service.getBrakingFaults()).toEqual([]);
  });

  it('6. aborts every ramp BEFORE the emergency stop broadcast, so no step lands after it (B6)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h);

    await h.service.startRouteStop(routeId);
    await h.advance(BRAKING_TICK_MS);

    await h.service.handleEmergencyStop();
    await h.advance(20 * BRAKING_TICK_MS);

    const kinds = h.dcc.commandLog.map((c) => c.type);
    expect(kinds).toContain('EMERGENCY_STOP');
    // Nothing at all after the broadcast stop — a ramp step landing there
    // would restart a train the operator has just halted.
    expect(kinds.slice(kinds.indexOf('EMERGENCY_STOP') + 1)).toEqual([]);
  });

  it('7. drops the overrun expectation when the route it was planned against is cancelled (B6)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h);

    await h.service.startRouteStop(routeId);
    await h.advance(20 * BRAKING_TICK_MS);

    await h.service.cancelRoute(routeId, 'operator cancel');

    // b4 is nobody's target any more; a different train standing there must
    // not fault loco 3.
    await h.sensorReports('s4', 'occupied');
    expect(h.service.getBrakingFaults()).toEqual([]);
  });

  it('8. runs B8\'s unconstrained standard stop with no route and arms no expectation', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    await h.service.handleThrottleCommand({ locoAddress: 3, speed: 60, direction: 'fwd' });
    h.dcc.clearLog();

    const outcome = await h.service.startStandardStop(3);
    expect(outcome.started).toBe(true);
    if (!outcome.started) return;
    // No `availableDistanceMm` to fit inside — the distance is reported, not
    // enforced (B8).
    expect(outcome.schedule.steps).toHaveLength(8);

    await h.advance(20 * BRAKING_TICK_MS);
    expect(speedCommands(h)[speedCommands(h).length - 1]).toEqual([0, 'stop']);

    // Nothing was promised about any block, so nothing can overrun.
    await h.sensorReports('s4', 'occupied');
    expect(h.service.getBrakingFaults()).toEqual([]);
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('9. refuses a route stop in manual mode, and any stop while Safe-Stopped (B6)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h);

    await h.service.handleSetMode({ mode: 'manual' });
    const refusedByMode = await h.service.startRouteStop(routeId);
    expect(refusedByMode).toEqual({
      started: false,
      reason: { kind: 'auto-not-permitted', status: 'online', mode: 'manual' },
    });
    expect(speedCommands(h)).toEqual([]);

    // A ramp's first command is a non-zero speed step, so starting one while
    // Safe-Stopped would be a ghost movement — refused even though
    // `canIssueManualCommand` would allow an operator's own command through.
    await h.mqtt.disconnect();
    await new Promise((r) => setImmediate(r));
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    const refusedByStatus = await h.service.startStandardStop(3);
    expect(refusedByStatus.started).toBe(false);
    if (refusedByStatus.started) return;
    expect(refusedByStatus.reason.kind).toBe('system-not-online');
  });
});
