/**
 * Scenario: route locking (see docs/route-locking.md, D1-D14).
 *
 * Covers the failure-path coverage the plan requires alongside the happy
 * path (CLAUDE.md: "any change to safety, routing, or occupancy logic
 * needs a scenario test covering the failure path"). Uses the real
 * `ReservationService`/`LayoutService`/`TopologyService` trio via
 * `createScenarioHarness`, exercised end to end through
 * `SimulatedMqttAdapter`/`SimulatedDccAdapter` — no mocks of the services
 * under test.
 *
 * Fixture layout used throughout:
 *
 *   b1 --e1(point p1=normal)--> b2 --e2--> b3
 *   b4 --e3-------------------> b2
 *
 * b4/e3 exists only for scenario 1 (a second route's path genuinely
 * overlapping the first at b2, not merely colliding on occupancy).
 */

import { describe, it, expect } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { ReservationService } from '../../src/services/ReservationService';
import { LayoutService } from '../../src/services/LayoutService';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { LockedByRouteError } from '../../src/services/TopologyService';

const LOCO_3 = { id: 'loco-3', layoutId: LAYOUT_ID, name: 'Loco 3', address: 3, type: 'diesel', maxSpeed: 126, brakingFactor: 0.5 };
const LOCO_7 = { id: 'loco-7', layoutId: LAYOUT_ID, name: 'Loco 7', address: 7, type: 'diesel', maxSpeed: 126, brakingFactor: 0.5 };

const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
  { id: 'b3', layoutId: LAYOUT_ID, name: 'Block 3' },
  { id: 'b4', layoutId: LAYOUT_ID, name: 'Block 4' },
];
const POINTS = [{ id: 'p1', layoutId: LAYOUT_ID, name: 'Point 1', dccAddress: 10, blockId: 'b1' }];
const SENSORS = [
  { id: 's1', layoutId: LAYOUT_ID, name: 'Sensor 1', type: 'block_detection' as const, blockId: 'b1', mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`, inService: true },
  { id: 's2', layoutId: LAYOUT_ID, name: 'Sensor 2', type: 'block_detection' as const, blockId: 'b2', mqttTopic: `layout/${LAYOUT_ID}/sensor/s2/reading`, inService: true },
  { id: 's3', layoutId: LAYOUT_ID, name: 'Sensor 3', type: 'block_detection' as const, blockId: 'b3', mqttTopic: `layout/${LAYOUT_ID}/sensor/s3/reading`, inService: true },
  { id: 's4', layoutId: LAYOUT_ID, name: 'Sensor 4', type: 'block_detection' as const, blockId: 'b4', mqttTopic: `layout/${LAYOUT_ID}/sensor/s4/reading`, inService: true },
];

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Seeds the fixture layout (blocks/points/sensors/locos/edges) and starts the harness's service. */
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
    lengthMm: null,
  });
  await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b2',
    fromEnd: 'east',
    toBlockId: 'b3',
    toEnd: 'west',
    pointConditions: [],
    lengthMm: null,
  });
  await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b4',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'north',
    pointConditions: [],
    lengthMm: null,
  });

  await h.start();

  // Every block but b1 starts confirmed clear — a fresh `LayoutStateManager`
  // registers every block as 'unknown', and D13 requires every subsequent
  // block in a requested path to already read 'clear' before a grant.
  await h.sensorReports('s2', 'clear');
  await h.sensorReports('s3', 'clear');
  await h.sensorReports('s4', 'clear');
}

/** Looks up the (repo-assigned) edge id connecting `from` to `to`. */
async function edgeId(h: ReturnType<typeof createScenarioHarness>, from: string, to: string): Promise<string> {
  const edges = await h.repo.listBlockEdges(LAYOUT_ID);
  const edge = edges.find((e) => e.fromBlockId === from && e.toBlockId === to);
  if (!edge) throw new Error(`no edge ${from} -> ${to}`);
  return edge.id;
}

describe('scenario: route locking', () => {
  it('1. grants a route over three blocks — locks and projections appear; a second route genuinely overlapping at a shared block is rejected with zero side effects', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied'); // loco 3 asserted into b1

    const e1 = await edgeId(h, 'b1', 'b2');
    const e2 = await edgeId(h, 'b2', 'b3');
    const e3 = await edgeId(h, 'b4', 'b2');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: [e1, e2] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');

    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBe(grant.reservation.id);
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBe(grant.reservation.id);
    expect(h.service.getAllState().blocks.get('b3')?.lockedByRoute).toBe(grant.reservation.id);
    expect(h.service.getAllState().points.get('p1')?.lockedByRoute).toBe(grant.reservation.id);

    // loco 7 asserted into b4, then a route genuinely overlapping at b2.
    await h.sensorReports('s4', 'occupied');
    const conflicting = await h.service.requestRoute({
      locoAddress: 7,
      authority: 'manual',
      startBlockId: 'b4',
      path: { kind: 'edges', edgeIds: [e3] },
    });
    expect(conflicting.granted).toBe(false);
    if (conflicting.granted) throw new Error('expected rejection');
    expect(conflicting.rejections).toContainEqual(
      expect.objectContaining({ kind: 'block-locked', blockId: 'b2' }),
    );

    // Zero side effects from the rejected grant.
    expect(h.service.getAllState().blocks.get('b4')?.lockedByRoute).toBeNull();
    expect(h.service.listRoutes(['active'])).toHaveLength(1);

    await h.service.stop();
  });

  it("2. progressive release: nothing releases while the tail hasn't caught up; block 1 (and its wholly-behind point) release once it reads clear and the train is confirmed past it; blocks ahead stay locked", async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const e1 = await edgeId(h, 'b1', 'b2');
    const e2 = await edgeId(h, 'b2', 'b3');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: [e1, e2] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');
    const routeId = grant.reservation.id;

    // Train confirmed in block 2 while block 1 still reads occupied ->
    // nothing released yet.
    await h.sensorReports('s2', 'occupied');
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBe(routeId);
    expect(h.service.getAllState().points.get('p1')?.lockedByRoute).toBe(routeId);

    // Block 1 goes clear -> block 1 and its wholly-behind point release.
    await h.sensorReports('s1', 'clear');
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBeNull();
    expect(h.service.getAllState().points.get('p1')?.lockedByRoute).toBeNull();

    // Blocks ahead (not yet traversed) stay locked.
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBe(routeId);
    expect(h.service.getAllState().blocks.get('b3')?.lockedByRoute).toBe(routeId);

    await h.service.stop();
  });

  it('3. force-override: an operator force-throwing a locked point cancels the route, releases every lock, stops its (auto-authority) loco, and the system stays online', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const e1 = await edgeId(h, 'b1', 'b2');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'auto',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: [e1] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');
    h.dcc.clearLog();

    await h.service.handlePointCommand({ pointId: 'p1', position: 'reverse', force: true });

    expect(h.service.listRoutes(['active']).map((r) => r.id)).not.toContain(grant.reservation.id);
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBeNull();
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBeNull();
    expect(h.service.getAllState().points.get('p1')?.position).toBe('reverse');
    expect(
      h.dcc.commandLog.some((c) => c.type === 'SET_SPEED' && c.data.speed === 0 && c.data.address === 3),
    ).toBe(true);
    // Deliberate, authorised, scoped to one route — no system-wide Safe-Stop.
    expect(h.service.getSystemStatus().status).toBe('online');

    await h.service.stop();
  });

  it('4. Safe-Stop (MQTT drop) mid-route suspends the route with locks retained; reconnecting clears system Safe-Stop but leaves the route suspended; resume is refused while a remaining block reads unknown; cancel releases', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const e1 = await edgeId(h, 'b1', 'b2');
    const e2 = await edgeId(h, 'b2', 'b3');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: [e1, e2] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');
    const routeId = grant.reservation.id;

    h.mqtt.disconnect();
    await new Promise((r) => setImmediate(r));
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);
    // Locks retained.
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBe(routeId);

    await h.mqtt.connect();
    await new Promise((r) => setImmediate(r));
    expect(h.service.getSystemStatus().status).toBe('online');
    // The route does NOT auto-resume (D8) — it is still suspended.
    expect(h.service.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);

    // A detection dropout on the remaining block b2 while suspended — the
    // LayoutStateManager Map returned by getAllState() is shared (its own
    // doc comment says "treat as read-only"), but there is no sensor
    // payload that reports 'unknown' (sensorReadingSchema only allows
    // 'occupied'/'clear' — a real dropout is silence, not a message), so
    // this is the only way to simulate one from a scenario test.
    const blocks = h.service.getAllState().blocks;
    blocks.set('b2', { ...blocks.get('b2')!, occupancy: 'unknown' });

    const refused = await h.service.resumeRoute(routeId);
    expect(refused.resumed).toBe(false);
    if (refused.resumed) throw new Error('expected refusal');
    expect(refused.reason).toMatch(/unknown/i);

    const cancelled = await h.service.cancelRoute(routeId, 'operator cancel');
    expect(cancelled.reservation?.status).toBe('cancelled');
    expect(cancelled.reservation?.holds.every((hold) => hold.released)).toBe(true);
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBeNull();

    await h.service.stop();
  });

  it('5. a restart with an active route revives it as suspended with locks re-applied, and Safe-Stops the system until the operator resolves it', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const e1 = await edgeId(h, 'b1', 'b2');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: [e1] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');
    const routeId = grant.reservation.id;

    await h.service.stop();

    // A fresh process: a brand new LayoutStateManager/ReservationService/
    // LayoutService trio against the SAME repository — the persisted
    // reservation is the only surviving record, exactly what a real
    // process restart looks like.
    const restartedState = new LayoutStateManager(LAYOUT_ID);
    const restartedReservations = new ReservationService(h.repo, restartedState, silent);
    const restartedService = new LayoutService(
      new SimulatedDccAdapter(silent),
      new SimulatedMqttAdapter(),
      h.repo,
      restartedState,
      restartedReservations,
      silent,
    );

    await restartedService.start(LAYOUT_ID);

    expect(restartedService.getSystemStatus().status).toBe('safe-stop');
    expect(restartedService.getSystemStatus().reason).toMatch(/survived a restart/i);
    const revived = restartedService.listRoutes(['suspended']).find((r) => r.id === routeId);
    expect(revived?.reason).toBe('backend restarted');
    expect(restartedState.getBlock('b1')?.lockedByRoute).toBe(routeId);

    // Cancelling the recovered route clears the restart Safe-Stop.
    await restartedService.cancelRoute(routeId, 'operator cleared recovered route');
    expect(restartedService.getSystemStatus().status).toBe('online');

    await restartedService.stop();
  });

  it('5b. a resume whose held point rejects its re-command is rolled back — the route returns to suspended with locks retained, and the restart Safe-Stop is NOT cleared', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const e1 = await edgeId(h, 'b1', 'b2');
    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: [e1] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');
    const routeId = grant.reservation.id;
    // e1 carries `p1=normal`, so the route holds a point to re-command.
    expect(grant.reservation.holds.some((hd) => hd.kind === 'point' && hd.targetId === 'p1')).toBe(true);

    await h.service.stop();

    const restartedState = new LayoutStateManager(LAYOUT_ID);
    const restartedReservations = new ReservationService(h.repo, restartedState, silent);
    const restartedDcc = new SimulatedDccAdapter(silent);
    const restartedService = new LayoutService(
      restartedDcc,
      new SimulatedMqttAdapter(),
      h.repo,
      restartedState,
      restartedReservations,
      silent,
    );
    await restartedService.start(LAYOUT_ID);
    expect(restartedService.getSystemStatus().status).toBe('safe-stop');

    // Satisfy D8's *block* preconditions directly, so the only thing left
    // standing between this route and a successful resume is the point.
    // Without this the resume would be refused for the wrong reason and the
    // re-command path would never be reached.
    restartedState.updateBlockOccupancy('b1', 'occupied');
    restartedState.updateBlockOccupancy('b2', 'clear');

    // The DCC adapter rejects the re-command: a serial write failing, a
    // servo driver reporting a fault. Per #25 there is no position feedback
    // channel, so a rejected command is the only evidence available that the
    // road is not set — which is exactly why it must not be swallowed.
    restartedDcc.setPoint = () => Promise.reject(new Error('DCC EX rejected: point 10 unreachable'));

    const refused = await restartedService.resumeRoute(routeId);
    expect(refused.resumed).toBe(false);
    if (refused.resumed) throw new Error('expected the resume to be refused');
    expect(refused.reason).toMatch(/p1/);
    expect(refused.reason).toMatch(/unreachable/);

    // The route is back to suspended, never left sitting `active` while a
    // point it holds is known not to have taken its command.
    expect(restartedService.listRoutes(['suspended']).map((r) => r.id)).toContain(routeId);
    expect(restartedService.listRoutes(['active']).map((r) => r.id)).not.toContain(routeId);

    // Locks retained through the rollback (D8).
    expect(restartedState.getBlock('b1')?.lockedByRoute).toBe(routeId);
    expect(restartedState.getPoint('p1')?.lockedByRoute).toBe(routeId);

    // The D9 latch still holds: this route is not resolved, so the restart
    // Safe-Stop must not have been cleared by the failed resume.
    expect(restartedService.getSystemStatus().status).toBe('safe-stop');
    expect(restartedService.getSystemStatus().reason).toMatch(/survived a restart/i);

    // And the operator's other route out still works.
    await restartedService.cancelRoute(routeId, 'operator cleared recovered route');
    expect(restartedService.getSystemStatus().status).toBe('online');

    await restartedService.stop();
  });

  it("6. unexpected occupancy in a reserved block that is not the route's next expected step cancels the route, stops its loco, and enters Safe-Stop", async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const e1 = await edgeId(h, 'b1', 'b2');
    const e2 = await edgeId(h, 'b2', 'b3');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: [e1, e2] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');
    const routeId = grant.reservation.id;
    h.dcc.clearLog();

    // b3 reports occupied while confirmedIndex is still 0 (b1) — not the
    // next expected step (b2).
    await h.sensorReports('s3', 'occupied');

    expect(h.service.listRoutes(['active']).map((r) => r.id)).not.toContain(routeId);
    expect(h.service.listRoutes(['cancelled']).map((r) => r.id)).toContain(routeId);
    expect(
      h.dcc.commandLog.some((c) => c.type === 'SET_SPEED' && c.data.speed === 0 && c.data.address === 3),
    ).toBe(true);
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toMatch(/violated/i);
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBeNull();
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBeNull();

    await h.service.stop();
  });

  it('7. topology guard: deleting an edge held by an active route is refused; cancelling the route lets the same delete succeed', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');

    const e1 = await edgeId(h, 'b1', 'b2');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'edges', edgeIds: [e1] },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');

    await expect(h.topologyService.deleteEdge(LAYOUT_ID, e1)).rejects.toThrow(LockedByRouteError);

    await h.service.cancelRoute(grant.reservation.id, 'operator cancel to edit topology');

    await expect(h.topologyService.deleteEdge(LAYOUT_ID, e1)).resolves.toBeUndefined();

    await h.service.stop();
  });
});
