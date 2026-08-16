/**
 * Scenario: sub-block sensor position (#77 PR B, see docs/sensor-position.md).
 *
 * One question, driven end to end through the real MQTT ingestion path: **can
 * a train be braked to a stop at the boundary of the block immediately ahead
 * of it?** Before #77 the answer was always no — `docs/braking.md` B4 sums
 * only the *intermediate* blocks, which for an adjacent target is none of
 * them, so `planBrakingSchedule` refused `insufficient-distance`. On a
 * nine-block layout most routes are two or three steps, which is why that
 * refusal was promoted from a recorded limit to a blocker for #7.
 *
 * Fixture — the same four measured blocks `braking.scenario.test.ts` uses:
 *
 *   b1 --e1--> b2 --e2--> b3 --e3--> b4
 *   500mm      500mm      500mm      500mm
 *
 * plus one `ir_position` beam in b1, measured **700mm from the b1/b2
 * boundary**. At speed 126 with `brakingFactor` 0.5 the model predicts 500mm
 * and requires 625mm after B5's margin — so 700mm grants and 0mm refuses, with
 * enough clearance either side that a change to any constant fails loudly
 * rather than flipping a borderline case.
 *
 * As with #6's scenarios this is deliberately **not** a physics simulation:
 * what it asserts is which plans were granted or refused and why, and that a
 * granted one produces the same command trace as any other braked run.
 */

import { describe, it, expect } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { BRAKING_TICK_MS } from '../../src/domain/braking';
import { MAX_CREDIBLE_SPEED_MM_PER_S } from '../../src/domain/sensorPosition';

const LOCO_3 = {
  id: 'loco-3',
  layoutId: LAYOUT_ID,
  name: 'Loco 3',
  address: 3,
  type: 'diesel',
  maxSpeed: 126,
  brakingFactor: 0.5,
};

/**
 * b1 is 1200mm rather than 500 so the 700mm beam offset is a coherent
 * measurement of it — the write path refuses an offset longer than its own
 * block (D5), and a fixture that could not be authored through the API would
 * be proving something about a state the system does not permit. b1's own
 * length is never summed either way: B4 excludes the confirmed block, and
 * #77's lead term reads the beam, not the block.
 */
const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1', lengthMm: 1200 },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2', lengthMm: 500 },
  { id: 'b3', layoutId: LAYOUT_ID, name: 'Block 3', lengthMm: 500 },
  { id: 'b4', layoutId: LAYOUT_ID, name: 'Block 4', lengthMm: 500 },
];

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

/** The beam in b1. `position` overrides let one scenario measure it elsewhere. */
function beam(
  position: { positionTowardBlockId: string | null; positionOffsetMm: number | null } = {
    positionTowardBlockId: 'b2',
    positionOffsetMm: 700,
  },
) {
  return {
    id: 'beam-1',
    layoutId: LAYOUT_ID,
    name: 'Block 1 beam',
    type: 'ir_position' as const,
    blockId: 'b1',
    mqttTopic: `layout/${LAYOUT_ID}/sensor/beam-1/reading`,
    inService: true,
    ...position,
  };
}

type Harness = ReturnType<typeof createScenarioHarness>;

async function seedAndStart(h: Harness, sensors: ReturnType<typeof beam>[]): Promise<void> {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints([]);
  h.repo._setSensors([...DETECTORS, ...sensors]);
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
 * Loco 3 in b1 at full speed under an auto-authority route to b4, exactly as
 * `braking.scenario.test.ts` sets one up (throttle first — a manual throttle
 * under an auto route would cancel it).
 */
async function routedAtFullSpeed(h: Harness, sensors: ReturnType<typeof beam>[]): Promise<string> {
  await seedAndStart(h, sensors);
  await h.sensorReports('s1', 'occupied');
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

describe('scenario: sub-block sensor position', () => {
  it('1. without a beam, a braked run to the immediately next block is refused for want of distance (B4, the pre-#77 state)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h, []);

    // targetIndex 1 is b2 — adjacent to the confirmed b1, so there is no
    // intermediate block and nothing the model will promise.
    const outcome = await h.service.startRouteStop(routeId, 1);

    expect(outcome.started).toBe(false);
    if (outcome.started) return;
    expect(outcome.reason).toEqual({
      kind: 'insufficient-distance',
      requiredMm: 625,
      availableMm: 0,
    });
    expect(speedCommands(h)).toEqual([]);
  });

  it('2. a beam broken 700mm short of the boundary grants the same run, and it executes as an ordinary ramp', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h, [beam()]);

    // The rising edge is what carries the information — the beam must go
    // clear -> occupied through the real ingestion path, not merely exist.
    await h.sensorReports('beam-1', 'occupied');

    const outcome = await h.service.startRouteStop(routeId, 1);
    expect(outcome.started).toBe(true);
    if (!outcome.started) return;
    expect(outcome.schedule.requiredDistanceMm).toBe(625);

    // Nothing about the ramp itself is special: 126 shed 8 steps at a time.
    expect(outcome.schedule.steps).toHaveLength(16);
    expect(speedCommands(h)).toEqual([[118, 'fwd']]);
    await h.advance(20 * BRAKING_TICK_MS);
    const commands = speedCommands(h);
    expect(commands).toHaveLength(16);
    expect(commands[commands.length - 1]).toEqual([0, 'stop']);

    expect(h.service.getBrakingFaults()).toEqual([]);
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('3. a beam that has never been broken grants nothing — the measurement alone is not an observation (D6)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h, [beam()]);

    const outcome = await h.service.startRouteStop(routeId, 1);
    expect(outcome.started).toBe(false);
    if (outcome.started) return;
    expect(outcome.reason).toMatchObject({ kind: 'insufficient-distance', availableMm: 0 });
  });

  it('4. a beam reporting CLEAR grants nothing, and does not empty the block either (D8)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h, [beam()]);

    await h.sensorReports('beam-1', 'clear');

    // The hard constraint, checked where it would actually bite: an IR clear
    // is still discarded for occupancy, so b1 is still occupied and the route
    // is still live. Knowing where the beam is changed neither.
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');

    const outcome = await h.service.startRouteStop(routeId, 1);
    expect(outcome.started).toBe(false);
    if (outcome.started) return;
    expect(outcome.reason).toMatchObject({ kind: 'insufficient-distance', availableMm: 0 });
  });

  it('5. the fix decays with time — the same beam grants the run now and refuses it a minute later (D7)', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h, [beam()]);
    await h.sensorReports('beam-1', 'occupied');

    // 700mm of credit against a 500mm/s allowance is exhausted in 1.4s. Two
    // seconds is comfortably past that and still nowhere near a timeout the
    // system would notice — the point being that nothing announces the fix
    // going stale, it simply stops being worth anything.
    await h.advance(2000);
    expect(2000 / 1000).toBeGreaterThan(700 / MAX_CREDIBLE_SPEED_MM_PER_S);

    const outcome = await h.service.startRouteStop(routeId, 1);
    expect(outcome.started).toBe(false);
    if (outcome.started) return;
    expect(outcome.reason).toMatchObject({ kind: 'insufficient-distance', availableMm: 0 });
  });

  it('6. a beam measured toward a different neighbour grants nothing on this road (D9)', async () => {
    const h = createScenarioHarness();
    // Measured toward b3 — a boundary b1 does not even have. The offset is a
    // real measurement of something; it is simply not a measurement of the
    // distance this train is about to cover.
    const routeId = await routedAtFullSpeed(h, [
      beam({ positionTowardBlockId: 'b3', positionOffsetMm: 700 }),
    ]);
    await h.sensorReports('beam-1', 'occupied');

    const outcome = await h.service.startRouteStop(routeId, 1);
    expect(outcome.started).toBe(false);
    if (outcome.started) return;
    expect(outcome.reason).toMatchObject({ kind: 'insufficient-distance', availableMm: 0 });
  });

  it('7. an out-of-service beam grants nothing — the same escape hatch that governs occupancy governs position', async () => {
    const h = createScenarioHarness();
    const routeId = await routedAtFullSpeed(h, [beam()]);
    await h.sensorReports('beam-1', 'occupied');

    // Taking a sensor out of service clears its reading, and the fix with it.
    await h.service.updateSensorConfig(LAYOUT_ID, 'beam-1', { inService: false });

    const outcome = await h.service.startRouteStop(routeId, 1);
    expect(outcome.started).toBe(false);
    if (outcome.started) return;
    expect(outcome.reason).toMatchObject({ kind: 'insufficient-distance', availableMm: 0 });
  });

  it('8. a fix never rescues unmeasured track further along the route', async () => {
    const h = createScenarioHarness();
    h.repo._setBlocks([
      BLOCKS[0],
      { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2', lengthMm: null },
      BLOCKS[2],
      BLOCKS[3],
    ]);
    const routeId = await (async () => {
      // Re-seed with b2 unmeasured, keeping the rest of the fixture.
      h.repo._setPoints([]);
      h.repo._setSensors([...DETECTORS, beam()]);
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
      await h.sensorReports('s1', 'occupied');
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
    })();

    await h.sensorReports('beam-1', 'occupied');

    // Targeting b3, which is past the unmeasured b2. A measured beam in b1
    // says nothing about a block nobody put a tape measure to, and the
    // refusal names the block rather than being absorbed by the credit.
    const outcome = await h.service.startRouteStop(routeId, 2);
    expect(outcome.started).toBe(false);
    if (outcome.started) return;
    expect(outcome.reason).toEqual({ kind: 'unmeasured-track', blockId: 'b2' });
  });
});
