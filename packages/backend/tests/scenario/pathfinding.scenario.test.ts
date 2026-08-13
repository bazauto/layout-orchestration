/**
 * Scenario: route pathfinding and setting the road (#4, see
 * docs/pathfinding.md P1–P8).
 *
 * The four cases #4's acceptance criteria name — successful grant,
 * conflicting request rejected, a point command rejected by the DCC adapter,
 * and a block going unknown mid-route — plus the regression guard for the
 * unlatched route Safe-Stop this PR fixes.
 *
 * Fixture layout — two roads from b1 to b3 through one point. Length is on the
 * **block** (D4); an edge is a joint and carries none:
 *
 *                 e1 (p1=normal)      e2
 *   b1 ─────────────────────────> b2 ─────> b3
 *  (100mm)                     (100mm)     (100mm)
 *    │                                       ^
 *    │  e3 (p1=reverse)            e4        │
 *    └─────────────────────────> b4 ─────────┘
 *                             (500mm)
 *
 * Both roads start in b1 and end in b3, so what discriminates them is b2
 * against b4. The short road is via b2, so an unobstructed search picks it and
 * throws p1 to `normal`. Blocking b2 forces the long road and `reverse` —
 * which is the whole point of a pathfinder that does not care what position p1
 * is in when it starts (P3).
 */

import { describe, it, expect } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';

const LOCO_3 = { id: 'loco-3', layoutId: LAYOUT_ID, name: 'Loco 3', address: 3, type: 'diesel', maxSpeed: 126, brakingFactor: 0.5 };
const LOCO_7 = { id: 'loco-7', layoutId: LAYOUT_ID, name: 'Loco 7', address: 7, type: 'diesel', maxSpeed: 126, brakingFactor: 0.5 };

// b2 is the short road and b4 the long way round, so the search should prefer
// b1 → b2 → b3. Length is on the block now (D4): both routes end in b3 and
// start in b1, so it is b2 against b4 that discriminates them.
const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1', lengthMm: 100 },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2', lengthMm: 100 },
  { id: 'b3', layoutId: LAYOUT_ID, name: 'Block 3', lengthMm: 100 },
  { id: 'b4', layoutId: LAYOUT_ID, name: 'Block 4', lengthMm: 500 },
];
const POINTS = [{ id: 'p1', layoutId: LAYOUT_ID, name: 'Point 1', dccAddress: 10, blockId: 'b1' }];
const SENSORS = ['b1', 'b2', 'b3', 'b4'].map((blockId, i) => ({
  id: `s${i + 1}`,
  layoutId: LAYOUT_ID,
  name: `Sensor ${i + 1}`,
  type: 'block_detection' as const,
  blockId,
  mqttTopic: `layout/${LAYOUT_ID}/sensor/s${i + 1}/reading`,
  inService: true,
}));

async function seedAndStart(h: ReturnType<typeof createScenarioHarness>) {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints(POINTS);
  h.repo._setSensors(SENSORS);
  h.repo._setLocos([LOCO_3, LOCO_7]);

  await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
  });
  await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b2',
    fromEnd: 'east',
    toBlockId: 'b3',
    toEnd: 'west',
    pointConditions: [],
  });
  await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b1',
    fromEnd: 'south',
    toBlockId: 'b4',
    toEnd: 'north',
    pointConditions: [{ pointId: 'p1', requiredPosition: 'reverse' }],
  });
  await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b4',
    fromEnd: 'east',
    toBlockId: 'b3',
    toEnd: 'south',
    pointConditions: [],
  });

  await h.start();

  // Every block but b1 confirmed clear — a fresh LayoutStateManager reads
  // every block as 'unknown', and neither the search nor D13 will route over
  // a block that is not positively clear.
  await h.sensorReports('s2', 'clear');
  await h.sensorReports('s3', 'clear');
  await h.sensorReports('s4', 'clear');
}

async function blockIdsOnPath(h: ReturnType<typeof createScenarioHarness>, routeId: string) {
  const route = h.service.listRoutes().find((r) => r.id === routeId);
  return route?.path.map((step) => step.blockId) ?? [];
}

describe('scenario: pathfinding and setting the road', () => {
  it('1. a grant by destination finds the shortest road, locks it, and throws the points to set it', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied'); // loco 3 asserted into b1

    // p1 starts in the wrong position for the short road. The search must
    // route over it anyway — setting the road is what a route does (P3).
    await h.service.handlePointCommand({ pointId: 'p1', position: 'reverse' });
    expect(h.service.getAllState().points.get('p1')?.position).toBe('reverse');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');

    // Shortest by length (b2 at 100mm, not b4 at 500mm) — not by hops, which
    // are equal.
    expect(await blockIdsOnPath(h, grant.reservation.id)).toEqual(['b1', 'b2', 'b3']);

    // Locks committed across the whole road.
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBe(grant.reservation.id);
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBe(grant.reservation.id);
    expect(h.service.getAllState().blocks.get('b3')?.lockedByRoute).toBe(grant.reservation.id);
    expect(h.service.getAllState().points.get('p1')?.lockedByRoute).toBe(grant.reservation.id);
    // b4 was never on the chosen road.
    expect(h.service.getAllState().blocks.get('b4')?.lockedByRoute).toBeNull();

    // The road was actually SET — this is the half #3 deliberately left out.
    expect(h.service.getAllState().points.get('p1')?.position).toBe('normal');

    expect(h.service.getSystemStatus().status).toBe('online');
    await h.service.stop();
  });

  it('2. routes around an occupied block, taking the long road and setting the point the other way', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s2', 'occupied'); // the short road is blocked

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');

    expect(await blockIdsOnPath(h, grant.reservation.id)).toEqual(['b1', 'b4', 'b3']);
    expect(h.service.getAllState().points.get('p1')?.position).toBe('reverse');
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBeNull();

    await h.service.stop();
  });

  it('3. an unknown block is not routed over — it is refused exactly like an occupied one (fail-safe)', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    await h.sensorReports('s2', 'occupied');
    // b4 never reported: after the reset below it reads 'unknown', which the
    // search must treat as impassable rather than optimistically clear.
    await h.service.deleteSensorConfig(LAYOUT_ID, 's4');

    const refused = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });
    expect(refused.granted).toBe(false);
    if (refused.granted) throw new Error('expected refusal');

    const noPath = refused.rejections.find((r) => r.kind === 'no-path');
    expect(noPath).toBeDefined();
    if (noPath?.kind !== 'no-path') throw new Error('expected a no-path rejection');
    expect(noPath.destinationBlockId).toBe('b3');
    // The operator is told what is in the way, not just "no route".
    expect(noPath.blockers).toContainEqual({
      kind: 'block-not-clear',
      blockId: 'b2',
      occupancy: 'occupied',
    });
    expect(noPath.blockers).toContainEqual({
      kind: 'block-not-clear',
      blockId: 'b4',
      occupancy: 'unknown',
    });

    // Zero side effects: nothing locked, no route created, no point thrown.
    expect(h.service.listRoutes(['active', 'suspended'])).toHaveLength(0);
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBeNull();

    await h.service.stop();
  });

  it('4. a conflicting request is rejected, never queued — the second loco is refused while the first holds the point', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const first = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });
    expect(first.granted).toBe(true);
    if (!first.granted) throw new Error('expected the first grant to succeed');

    // Loco 7 is in b4 and wants b3 — its only road is e4, and b3 is held by
    // the first route. Rejected outright, with the holder named.
    await h.sensorReports('s4', 'occupied');
    const second = await h.service.requestRoute({
      locoAddress: 7,
      authority: 'manual',
      startBlockId: 'b4',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });
    expect(second.granted).toBe(false);
    if (second.granted) throw new Error('expected the second grant to be refused');

    const noPath = second.rejections.find((r) => r.kind === 'no-path');
    if (noPath?.kind !== 'no-path') throw new Error('expected a no-path rejection');
    expect(noPath.blockers).toContainEqual({
      kind: 'block-locked',
      blockId: 'b3',
      heldBy: first.reservation.id,
    });

    // The first route is untouched and the system never left online.
    expect(h.service.listRoutes(['active'])).toHaveLength(1);
    expect(h.service.getAllState().blocks.get('b4')?.lockedByRoute).toBeNull();
    expect(h.service.getSystemStatus().status).toBe('online');

    await h.service.stop();
  });

  it('5. a point command the DCC adapter rejects invalidates the whole route and Safe-Stops — and that Safe-Stop survives an unrelated health re-evaluation', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    // A serial write failing, a servo driver reporting a fault. With no
    // position feedback channel (#25) a rejected command is the only
    // evidence available that the road is not set.
    h.dcc.setPoint = () => Promise.reject(new Error('DCC EX rejected: point 10 unreachable'));

    const refused = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });
    expect(refused.granted).toBe(false);
    if (refused.granted) throw new Error('expected the grant to be abandoned');
    expect(refused.rejections).toContainEqual(
      expect.objectContaining({ kind: 'point-command-rejected', pointId: 'p1' }),
    );

    // The whole route is invalidated: no live reservation, every lock gone.
    expect(h.service.listRoutes(['active', 'suspended'])).toHaveLength(0);
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBeNull();
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBeNull();
    expect(h.service.getAllState().points.get('p1')?.lockedByRoute).toBeNull();

    // Safe-Stop, latched as a route fault.
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    const faults = h.service.getRouteFaults();
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe('point-command-rejected');

    // THE REGRESSION GUARD. Before this PR the route Safe-Stop was applied by
    // calling enterSafeStop directly, leaving nothing in SystemHealth — so
    // any later health evaluation found nothing wrong and cleared it. A
    // sensor reading on an unrelated block is exactly such an evaluation.
    await h.sensorReports('s3', 'clear');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    // The operator's acknowledgement is what clears it.
    const ack = await h.service.acknowledgeRouteFault(LAYOUT_ID, faults[0].routeId);
    expect(ack.cleared).toBe(true);
    expect(h.service.getRouteFaults()).toHaveLength(0);
    expect(h.service.getSystemStatus().status).toBe('online');

    await h.service.stop();
  });

  it('6. a reserved block going unknown mid-route Safe-Stops, stops the loco, and SUSPENDS the route with its locks retained', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');
    const routeId = grant.reservation.id;
    expect(h.service.getSystemStatus().status).toBe('online');

    // An admin marks b2's only detector out of service while the route is
    // live. No sensor fault is raised — the device is not misbehaving, it is
    // being withdrawn — so before #4 nothing at all caught this and the route
    // stayed active over a block whose state was no longer known.
    await h.service.updateSensorConfig(LAYOUT_ID, 's2', { inService: false });
    expect(h.service.getAllState().blocks.get('b2')?.occupancy).toBe('unknown');

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    const faults = h.service.getRouteFaults();
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe('occupancy-unknown');
    expect(faults[0].blockId).toBe('b2');
    expect(faults[0].routeId).toBe(routeId);

    // Suspended, NOT cancelled — Safe-Stop holds locks (D8). Releasing track
    // under a train whose road just became less certain is the opposite of
    // fail-safe.
    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBe(routeId);
    expect(h.service.getAllState().blocks.get('b3')?.lockedByRoute).toBe(routeId);
    expect(h.service.getAllState().points.get('p1')?.lockedByRoute).toBe(routeId);

    // The loco was stopped.
    expect(h.service.getAllState().locos.get(3)?.speed).toBe(0);

    // Acknowledging returns the system to online, but the route is NOT
    // resumable while b2 is still unknown — resume's own preconditions
    // refuse it, which is why the acknowledge needs no arming threshold.
    await h.service.acknowledgeRouteFault(LAYOUT_ID, routeId);
    expect(h.service.getSystemStatus().status).toBe('online');

    const resume = await h.service.resumeRoute(routeId);
    expect(resume.resumed).toBe(false);
    if (resume.resumed) throw new Error('expected the resume to be refused');
    expect(resume.reason).toMatch(/b2/);
    expect(resume.reason).toMatch(/unknown/);

    // Once b2 is determinable again the route resumes normally.
    await h.service.updateSensorConfig(LAYOUT_ID, 's2', { inService: true });
    await h.sensorReports('s2', 'clear');
    const resumed = await h.service.resumeRoute(routeId);
    expect(resumed.resumed).toBe(true);
    expect(h.service.listRoutes(['active']).map((r) => r.id)).toContain(routeId);

    await h.service.stop();
  });

  it('7. a route violation Safe-Stop is latched too — it does not clear on an unrelated sensor reading', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');

    // b3 is two steps ahead — occupancy there is a train the system did not
    // put there (D7), not progress.
    await h.sensorReports('s3', 'occupied');

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    const faults = h.service.getRouteFaults();
    expect(faults).toHaveLength(1);
    expect(faults[0].kind).toBe('unexpected-occupancy');
    expect(faults[0].blockId).toBe('b3');

    // The same regression as scenario 5, on the path that had the bug
    // originally: an unrelated health evaluation must not clear this.
    await h.sensorReports('s4', 'clear');
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toMatch(/unexpected occupancy/i);

    await h.service.stop();
  });
});
