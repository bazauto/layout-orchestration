/**
 * Scenario: point controller liveness (#167, see docs/point-feedback.md D11
 * and D12, and docs/mqtt-contract.md's Degradation Triggers).
 *
 * The failure this file exists for is the one nothing caught before #167: a
 * point controller that dies **quietly**. Not a stalled motor (that is a
 * timeout, covered in `point-feedback-routes.scenario.test.ts`), not a
 * mechanical bind (that is a mismatch) — a controller that confirmed
 * correctly and then simply stopped speaking, leaving its last
 * `confirmedPosition` standing while the layout went on setting roads over
 * it.
 *
 * The distinction every scenario here turns on: **silence is a device dying,
 * not a device lying.** A timeout latches a `PointFault` and Safe-Stops; a
 * stale point latches nothing and degrades only itself. What it has in common
 * with a timeout is the route consequence, because in both cases route R's
 * road is no longer known to be set.
 *
 * Fixture, mirroring `point-feedback-routes.scenario.test.ts`:
 *
 *   b1 --e1 (p1=normal, positionFeedback: 'required')--> b2
 *
 * p2 is a `positionFeedback: 'none'` point no edge references — the live
 * Westgate Hollow case, and the guard that this feature changes nothing there.
 */

import { describe, it, expect } from 'vitest';
import {
  createScenarioHarness,
  LAYOUT_ID,
  POINT_CONFIRM_DELAY_MS,
  POINT_CONFIRM_SWEEP_MS,
  POINT_CONFIRM_TIMEOUT_MS,
  POINT_FRESHNESS_TIMEOUT_MS,
  POINT_REASSERT_MS,
} from './harness';
import { PointRecord } from '../../src/ports/ILayoutRepository';
import { GrantRequest } from '../../src/services/ReservationService';

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
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
];

function point(id: string, feedback: 'required' | 'none'): PointRecord {
  return {
    id,
    layoutId: LAYOUT_ID,
    name: `Point ${id}`,
    dccAddress: 10,
    blockId: 'b1',
    positionFeedback: feedback,
  };
}

const SENSORS = [
  {
    id: 's1',
    layoutId: LAYOUT_ID,
    name: 'Sensor 1',
    type: 'block_detection' as const,
    blockId: 'b1',
    mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`,
    inService: true,
  },
  {
    id: 's2',
    layoutId: LAYOUT_ID,
    name: 'Sensor 2',
    type: 'block_detection' as const,
    blockId: 'b2',
    mqttTopic: `layout/${LAYOUT_ID}/sensor/s2/reading`,
    inService: true,
  },
];

async function seedAndStart(h: ReturnType<typeof createScenarioHarness>) {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints([point('p1', 'required'), point('p2', 'none')]);
  h.repo._setSensors(SENSORS);
  h.repo._setLocos([LOCO_3]);
  await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
    lengthMm: null,
  });

  await h.start();
  await h.sensorReports('s2', 'clear');
}

async function grantRoute(h: ReturnType<typeof createScenarioHarness>) {
  const edges = await h.repo.listBlockEdges(LAYOUT_ID);
  const e1 = edges.find((e) => e.fromBlockId === 'b1' && e.toBlockId === 'b2');
  if (!e1) throw new Error('no edge b1 -> b2');

  const request: GrantRequest = {
    locoAddress: 3,
    authority: 'manual',
    startBlockId: 'b1',
    path: { kind: 'edges', edgeIds: [e1.id] },
  };
  const grant = await h.service.requestRoute(request);
  if (!grant.granted) throw new Error(`expected grant: ${JSON.stringify(grant.rejections)}`);
  return grant.reservation.id;
}

/**
 * Runs the clock forward in freshness-window-sized steps while the simulated
 * controller keeps re-asserting on the contract's 30 s interval — i.e. what a
 * healthy layout does between commands.
 */
async function runHealthyFor(h: ReturnType<typeof createScenarioHarness>, ms: number) {
  let elapsed = 0;
  while (elapsed < ms) {
    const step = Math.min(POINT_REASSERT_MS, ms - elapsed);
    await h.advance(step);
    elapsed += step;
  }
}

describe('scenario: point controller liveness (#167)', () => {
  it('1. a confirmed point whose controller goes quiet degrades to stale with confirmedPosition unknown — and latches NO point fault', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.commandPoint('p1', 'normal');
    await h.advance(POINT_CONFIRM_DELAY_MS);
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('confirmed');

    // The controller dies. Nothing announces this — that is the whole problem.
    h.pointController.setDefaultMode('silent');
    await h.advance(POINT_FRESHNESS_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);

    const p1 = h.service.getAllState().points.get('p1');
    expect(p1?.confirmation).toBe('stale');
    expect(p1?.confirmedPosition).toBe('unknown');

    // A degrade, not a fault: silence is a device dying, not a device lying.
    expect(h.service.getPointFaults()).toEqual([]);
    // No route held it, so nothing else was affected either.
    expect(h.service.getRouteFaults()).toEqual([]);
    expect(h.service.getSystemStatus().status).toBe('online');

    await h.service.stop();
  });

  it('2. a healthy controller re-asserting on the contract interval never goes stale, however long it runs', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.commandPoint('p1', 'normal');
    await h.advance(POINT_CONFIRM_DELAY_MS);
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('confirmed');

    // Ten freshness windows of a controller doing what the contract obliges it to.
    await runHealthyFor(h, POINT_FRESHNESS_TIMEOUT_MS * 10);

    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('confirmed');
    expect(h.service.getAllState().points.get('p1')?.confirmedPosition).toBe('normal');
    expect(h.service.getPointFaults()).toEqual([]);

    // The re-assert is NOT a licence to retain (docs/mqtt-contract.md D1, and
    // the amended retention callout): re-assertion is necessary for retention
    // and not sufficient for it, because a point's position can still change
    // while its controller is offline. Checked on the wire, not at the call site.
    expect(h.publishedRetained(`layout/${LAYOUT_ID}/point/p1/reading`)).toBe(false);

    await h.service.stop();
  });

  it("3. a 'none' point never goes stale — nothing reports on it, and every live Westgate Hollow point is one", async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.commandPoint('p2', 'reverse');
    await h.advance(POINT_CONFIRM_DELAY_MS);

    h.pointController.setDefaultMode('silent');
    await h.advance(POINT_FRESHNESS_TIMEOUT_MS * 5);

    const p2 = h.service.getAllState().points.get('p2');
    expect(p2?.confirmation).not.toBe('stale');
    expect(p2?.commandedPosition).toBe('reverse');
    expect(h.service.getPointFaults()).toEqual([]);
    expect(h.service.getSystemStatus().status).toBe('online');

    await h.service.stop();
  });

  it('4. a route holding the point when it goes stale is suspended with locks retained, its loco stopped, and a RouteFault latched — but still no PointFault', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const routeId = await grantRoute(h);
    await h.advance(POINT_CONFIRM_DELAY_MS);
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('confirmed');

    h.dcc.clearLog();
    h.pointController.setDefaultMode('silent');
    await h.advance(POINT_FRESHNESS_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);

    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('stale');

    // Suspended, not cancelled — the locks stay, because a train may be standing on it.
    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBe(routeId);
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBe(routeId);
    expect(h.service.getAllState().points.get('p1')?.lockedByRoute).toBe(routeId);

    // The loco was stopped on the wire, unconditionally — not gated on authority.
    expect(
      h.dcc.commandLog.some(
        (c) => c.type === 'SET_SPEED' && c.data.speed === 0 && c.data.address === 3,
      ),
    ).toBe(true);
    expect(h.service.getAllState().locos.get(3)?.speed).toBe(0);

    // One latch, not two: the route's road is in doubt, the point itself is not faulty.
    expect(h.service.getPointFaults()).toEqual([]);
    const routeFaults = h.service.getRouteFaults();
    expect(routeFaults).toHaveLength(1);
    expect(routeFaults[0]).toMatchObject({ routeId, kind: 'point-not-confirmed', pointId: 'p1' });
    expect(routeFaults[0].reason).toContain('stale');

    await h.service.stop();
  });

  it('5. a stale point recovers on the next reading with nothing to acknowledge — it latched nothing to clear', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.commandPoint('p1', 'normal');
    await h.advance(POINT_CONFIRM_DELAY_MS);

    h.pointController.setDefaultMode('silent');
    await h.advance(POINT_FRESHNESS_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('stale');

    // The controller comes back and re-asserts on its own schedule.
    h.pointController.setDefaultMode('confirm');
    await h.advance(POINT_REASSERT_MS);

    const p1 = h.service.getAllState().points.get('p1');
    expect(p1?.confirmation).toBe('confirmed');
    expect(p1?.confirmedPosition).toBe('normal');
    expect(h.service.getPointFaults()).toEqual([]);

    await h.service.stop();
  });

  it('6. D12: resuming a route over a stale point is allowed, and the resume IS the probe — a recovered controller confirms it', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const routeId = await grantRoute(h);
    await h.advance(POINT_CONFIRM_DELAY_MS);

    h.pointController.setDefaultMode('silent');
    await h.advance(POINT_FRESHNESS_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('stale');
    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);

    // The controller was rebooting, not dead. Clear the route fault the degrade
    // raised, then resume: no PointFault stands in the way, because none was
    // ever latched.
    h.pointController.setDefaultMode('confirm');
    await h.service.acknowledgeRouteFault(LAYOUT_ID, routeId);

    const resumed = await h.service.resumeRoute(routeId);
    expect(resumed.resumed).toBe(true);

    // The resume re-commanded the point, which is what tests the staleness.
    await h.advance(POINT_CONFIRM_DELAY_MS + POINT_CONFIRM_SWEEP_MS);
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('confirmed');
    expect(h.service.listRoutes(['active']).map((r) => r.id)).toContain(routeId);

    await h.service.stop();
  });

  it('7. D12: the same resume against a genuinely dead controller times out into a real PointFault, and the route re-suspends', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const routeId = await grantRoute(h);
    await h.advance(POINT_CONFIRM_DELAY_MS);

    h.pointController.setDefaultMode('silent');
    await h.advance(POINT_FRESHNESS_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);
    await h.service.acknowledgeRouteFault(LAYOUT_ID, routeId);

    // Still silent. The resume proceeds — and settles the question in 8 s
    // rather than in another freshness window.
    const resumed = await h.service.resumeRoute(routeId);
    expect(resumed.resumed).toBe(true);

    await h.advance(POINT_CONFIRM_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);

    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('timed-out');
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'timeout' }]);
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);

    await h.service.stop();
  });
});
