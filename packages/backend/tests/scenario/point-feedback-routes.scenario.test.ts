/**
 * Scenario: point feedback ↔ route interaction (#25 PR B, see
 * docs/point-feedback.md D8 and docs/route-locking.md D11).
 *
 * A new file rather than a `describe` block inside
 * `point-feedback.scenario.test.ts`: that file's own fixture comment says
 * "no sensors or locos are seeded — none of these scenarios grant a route;
 * they are about the confirmation channel itself." This file is the other
 * half — the confirmation channel's consequence on a granted route — and
 * needs sensors and a loco roster that file deliberately omits.
 *
 * Fixture layout used throughout, closely mirroring
 * `route-locking.scenario.test.ts`'s style:
 *
 *   b1 --e1 (p1=normal, positionFeedback: 'required')--> b2
 *
 * p2 exists only for the last scenario — a 'required' point with no edge,
 * and therefore no route, referencing it.
 */

import { describe, it, expect } from 'vitest';
import { createScenarioHarness, LAYOUT_ID, POINT_CONFIRM_DELAY_MS, POINT_CONFIRM_SWEEP_MS, POINT_CONFIRM_TIMEOUT_MS } from './harness';
import { PointRecord } from '../../src/ports/ILayoutRepository';
import { GrantRequest } from '../../src/services/ReservationService';

const LOCO_3 = { id: 'loco-3', layoutId: LAYOUT_ID, name: 'Loco 3', address: 3, type: 'diesel', maxSpeed: 126, brakingFactor: 0.5 };

const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
];

function point(id: string, blockId: string): PointRecord {
  return { id, layoutId: LAYOUT_ID, name: `Point ${id}`, dccAddress: 10, blockId, positionFeedback: 'required' };
}

const SENSORS = [
  { id: 's1', layoutId: LAYOUT_ID, name: 'Sensor 1', type: 'block_detection' as const, blockId: 'b1', mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`, inService: true },
  { id: 's2', layoutId: LAYOUT_ID, name: 'Sensor 2', type: 'block_detection' as const, blockId: 'b2', mqttTopic: `layout/${LAYOUT_ID}/sensor/s2/reading`, inService: true },
];

/** Seeds the fixture layout (blocks/points/sensors/loco/edge) and starts the harness's service. p2 is a spare 'required' point no edge references. */
async function seedAndStart(h: ReturnType<typeof createScenarioHarness>) {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints([point('p1', 'b1'), point('p2', 'b1')]);
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

/** Grants b1->b2 over e1 (which requires p1=normal) for loco 3, with the given authority. */
async function grantRoute(h: ReturnType<typeof createScenarioHarness>, authority: 'manual' | 'auto') {
  const edges = await h.repo.listBlockEdges(LAYOUT_ID);
  const e1 = edges.find((e) => e.fromBlockId === 'b1' && e.toBlockId === 'b2');
  if (!e1) throw new Error('no edge b1 -> b2');

  const request: GrantRequest = {
    locoAddress: 3,
    authority,
    startBlockId: 'b1',
    path: { kind: 'edges', edgeIds: [e1.id] },
  };
  const grant = await h.service.requestRoute(request);
  if (!grant.granted) throw new Error(`expected grant: ${JSON.stringify(grant.rejections)}`);
  return grant.reservation.id;
}

describe('scenario: point feedback route interaction (#25 PR B)', () => {
  it('1. a held point that never confirms (timeout) suspends the route it is held by, locks retained, loco stopped, system safe-stop, and a RouteFault naming both the point and the route', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    h.pointController.setDefaultMode('silent');

    const routeId = await grantRoute(h, 'manual');
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('pending');

    await h.advance(POINT_CONFIRM_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);

    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('timed-out');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    // Suspended, not cancelled — locks retained.
    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBe(routeId);
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBe(routeId);
    expect(h.service.getAllState().points.get('p1')?.lockedByRoute).toBe(routeId);

    // The loco was stopped.
    expect(h.service.getAllState().locos.get(3)?.speed).toBe(0);

    // Both faults latched.
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'timeout' }]);
    const routeFaults = h.service.getRouteFaults();
    expect(routeFaults).toHaveLength(1);
    expect(routeFaults[0]).toMatchObject({ routeId, kind: 'point-not-confirmed', pointId: 'p1' });
    expect(routeFaults[0].reason).toContain('p1');
    expect(routeFaults[0].reason).toContain(routeId);

    await h.service.stop();
  });

  it("2. the same timeout with authority: 'manual' STILL stops the throttle unconditionally — the deliberate one-nudge cost to a manual driver", async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    h.pointController.setDefaultMode('silent');

    const routeId = await grantRoute(h, 'manual');
    h.dcc.clearLog();

    await h.advance(POINT_CONFIRM_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);

    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);
    expect(
      h.dcc.commandLog.some((c) => c.type === 'SET_SPEED' && c.data.speed === 0 && c.data.address === 3),
    ).toBe(true);
    expect(h.service.getAllState().locos.get(3)?.speed).toBe(0);

    await h.service.stop();
  });

  it('3. a wrong-position report (mismatch) on a held point suspends the holding route too, not just a timeout', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    h.pointController.setDefaultMode('wrong-position');

    const routeId = await grantRoute(h, 'manual');
    await h.advance(POINT_CONFIRM_DELAY_MS);

    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('mismatch');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);

    const routeFaults = h.service.getRouteFaults();
    expect(routeFaults).toMatchObject([{ routeId, kind: 'point-not-confirmed', pointId: 'p1' }]);

    await h.service.stop();
  });

  it("4. a 'reported unknown' report (indeterminate) on a held point suspends the holding route too", async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    h.pointController.setDefaultMode('indeterminate');

    const routeId = await grantRoute(h, 'manual');
    await h.advance(POINT_CONFIRM_DELAY_MS);

    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('indeterminate');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);

    const routeFaults = h.service.getRouteFaults();
    expect(routeFaults).toMatchObject([{ routeId, kind: 'point-not-confirmed', pointId: 'p1' }]);

    await h.service.stop();
  });

  it('5. a malformed payload on a held point Safe-Stops the system (which suspends every route as a consequence) but does NOT latch a point-not-confirmed RouteFault — it leaves the confirmation untouched, so the road may still be genuinely set', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const routeId = await grantRoute(h, 'manual');
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('pending');

    h.mqtt.simulateIncoming(`layout/${LAYOUT_ID}/point/p1/reading`, { garbage: true });
    await new Promise((r) => setImmediate(r));

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'malformed-payload' }]);
    // The point's own confirmation is untouched — still 'pending', not
    // faulted by the malformed reading itself (D1/D3).
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('pending');

    // The distinguishing assertion: no `point-not-confirmed` RouteFault. The
    // route is suspended anyway (Safe-Stop suspends every active route, per
    // docs/route-locking.md D8), but not through this PR's new path.
    expect(h.service.getRouteFaults()).toEqual([]);
    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);

    await h.service.stop();
  });

  it('6. resume is refused while the point fault is latched and unacknowledged; acknowledging it lets resume succeed and re-command the point', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    h.pointController.setDefaultMode('silent');

    const routeId = await grantRoute(h, 'manual');
    await h.advance(POINT_CONFIRM_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'timeout', armed: false }]);

    // Refused: the PointFault is latched and unacknowledged. Checked against
    // the fault, not against `confirmation === 'pending'` (which resuming
    // would itself re-arm).
    const refused = await h.service.resumeRoute(routeId);
    expect(refused.resumed).toBe(false);
    if (refused.resumed) throw new Error('expected refusal');
    expect(refused.reason).toContain('p1');
    // Nothing was re-commanded by the refused attempt.
    expect(h.service.listRoutes(['active']).map((r) => r.id)).not.toContain(routeId);

    // Arm the fault: a reading confirming the point at its commanded
    // position counts toward clearing it (D4), independent of the route.
    h.mqtt.simulateIncoming(`layout/${LAYOUT_ID}/point/p1/reading`, {
      pointId: 'p1',
      position: 'normal',
      source: 'sensor',
    });
    await new Promise((r) => setImmediate(r));
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'timeout', armed: true }]);

    await h.service.acknowledgePointFault(LAYOUT_ID, 'p1');
    expect(h.service.getPointFaults()).toEqual([]);

    h.dcc.clearLog();
    const resumed = await h.service.resumeRoute(routeId);
    expect(resumed.resumed).toBe(true);
    expect(h.service.listRoutes(['active']).map((r) => r.id)).toContain(routeId);

    // The point was re-commanded as part of the resume.
    expect(
      h.dcc.commandLog.some((c) => c.type === 'SET_POINT' && c.data.dccAddress === 10 && c.data.position === 'normal'),
    ).toBe(true);

    await h.service.stop();
  });

  it('7. a point fault on a point no route holds still Safe-Stops (PR A behaviour) and latches no RouteFault', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    h.pointController.setDefaultMode('silent');

    // p2 is commanded directly — no edge, and so no route, references it.
    await h.commandPoint('p2', 'normal');
    await h.advance(POINT_CONFIRM_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p2', kind: 'timeout' }]);
    expect(h.service.getRouteFaults()).toEqual([]);
    expect(h.service.listRoutes(['active', 'suspended'])).toHaveLength(0);

    await h.service.stop();
  });
});
