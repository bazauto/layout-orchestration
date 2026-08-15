/**
 * Scenario: point position feedback (#25, see docs/point-feedback.md D1-D10).
 *
 * Uses the real `PointConfirmationService`/`SimulatedPointController` trio
 * the harness now wires alongside `LayoutService`/`ReservationService`/
 * `TopologyService`, driven end to end through `SimulatedMqttAdapter` on the
 * harness's own `ManualClock` (`h.advance`) — no real timers, no mocks of
 * the service under test.
 *
 * Fixture layout used throughout — one point gating two edges out of b1, so
 * "the gated edge" and "the opposite edge" are always concrete, checkable
 * facts via `domain/graph.ts#isEdgeTraversable` against `getPointPositions()`:
 *
 *   b1 --e1 (p1=normal)--> b2
 *   b1 --e2 (p1=reverse)--> b3
 *
 * No sensors or locos are seeded — none of these scenarios grant a route;
 * they are about the confirmation channel itself.
 */

import { describe, it, expect } from 'vitest';
import {
  createScenarioHarness,
  LAYOUT_ID,
  POINT_CONFIRM_DELAY_MS,
  POINT_CONFIRM_SWEEP_MS,
  POINT_CONFIRM_TIMEOUT_MS,
} from './harness';
import { isEdgeTraversable } from '../../src/domain/graph';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { ReservationService } from '../../src/services/ReservationService';
import { LayoutService } from '../../src/services/LayoutService';
import { PointConfirmationService } from '../../src/services/PointConfirmationService';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ManualClock } from '../../src/adapters/clock/ManualClock';
import { SimulatedPointController } from '../../src/adapters/simulator/SimulatedPointController';
import { PointRecord } from '../../src/ports/ILayoutRepository';
import { BlockEdge, PointFeedbackMode } from '../../src/domain/types';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
  { id: 'b3', layoutId: LAYOUT_ID, name: 'Block 3' },
];

function point(id: string, feedback: PointFeedbackMode): PointRecord {
  return { id, layoutId: LAYOUT_ID, name: `Point ${id}`, dccAddress: 10, blockId: 'b1', positionFeedback: feedback };
}

/** e1 (b1->b2) requires p1=normal; e2 (b1->b3) requires p1=reverse — a point standing one way always leaves exactly one of these traversable. */
async function seedEdges(h: ReturnType<typeof createScenarioHarness>): Promise<{ e1: BlockEdge; e2: BlockEdge }> {
  const e1 = await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
  });
  const e2 = await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b1',
    fromEnd: 'south',
    toBlockId: 'b3',
    toEnd: 'north',
    pointConditions: [{ pointId: 'p1', requiredPosition: 'reverse' }],
  });
  return { e1, e2 };
}

/**
 * Seeds the fixture layout with `p1` configured `feedback` (plus any
 * `extraPoints`) and starts the harness's service. For a `'required'` point
 * this also settles the startup `point/*\/query` (D2) before returning —
 * otherwise a test's own stimulus would race that query's own scheduled
 * response on the shared `ManualClock`, exactly the hazard
 * `tests/integration/point-feedback.test.ts`'s `build()` documents.
 */
async function seedAndStart(
  h: ReturnType<typeof createScenarioHarness>,
  feedback: PointFeedbackMode,
  extraPoints: PointRecord[] = [],
): Promise<{ e1: BlockEdge; e2: BlockEdge }> {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints([point('p1', feedback), ...extraPoints]);
  h.repo._setSensors([]);
  h.repo._setLocos([]);
  const edges = await seedEdges(h);
  await h.start();
  if (feedback === 'required') {
    await h.advance(POINT_CONFIRM_DELAY_MS);
  }
  return edges;
}

describe('scenario: point position feedback', () => {
  it('1. commanded, controller confirms → confirmed; the gated edge becomes traversable; POINT_STATE is emitted twice (pending, then confirmed)', async () => {
    const h = createScenarioHarness();
    const { e1 } = await seedAndStart(h, 'required');
    const before = h.events.length;

    await h.commandPoint('p1', 'normal');
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('pending');

    await h.advance(POINT_CONFIRM_DELAY_MS);

    const point = h.service.getAllState().points.get('p1');
    expect(point?.confirmation).toBe('confirmed');
    expect(point?.confirmedPosition).toBe('normal');
    expect(isEdgeTraversable(e1, h.service.getPointPositions())).toBe(true);

    const pointStateEvents = h.events
      .slice(before)
      .filter((e) => e.type === 'POINT_STATE')
      .map((e) => (e as { type: 'POINT_STATE'; payload: { confirmation: string } }).payload.confirmation);
    expect(pointStateEvents).toEqual(['pending', 'confirmed']);

    expect(h.service.getSystemStatus().status).toBe('online');
    await h.service.stop();
  });

  it("2. commanded, controller SILENT, clock advanced past the confirmation timeout → timed-out; confirmedPosition 'unknown'; the gated edge is NOT traversable; a PointFault Safe-Stops; point/*/state was retained, point/*/query was not", async () => {
    const h = createScenarioHarness();
    const { e1 } = await seedAndStart(h, 'required');
    h.pointController.setDefaultMode('silent');

    await h.commandPoint('p1', 'normal');
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('pending');

    // D5's 8000ms deadline plus one extra sweep tick — the 250ms sweep
    // evaluates the deadline on its own schedule, so this must cross the
    // first sweep tick ON OR AFTER the deadline, not merely reach it.
    await h.advance(POINT_CONFIRM_TIMEOUT_MS + POINT_CONFIRM_SWEEP_MS);

    const point = h.service.getAllState().points.get('p1');
    expect(point?.confirmation).toBe('timed-out');
    expect(point?.confirmedPosition).toBe('unknown');
    expect(isEdgeTraversable(e1, h.service.getPointPositions())).toBe(false);

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'timeout' }]);

    expect(h.publishedRetained(`layout/${LAYOUT_ID}/point/p1/state`)).toBe(true);
    expect(h.publishedRetained(`layout/${LAYOUT_ID}/point/p1/query`)).toBe(false);

    await h.service.stop();
  });

  it('3. controller reports the OPPOSITE position → mismatch, holding the REPORTED value; only the edge matching the report is traversable — the point genuinely is where it says it is', async () => {
    const h = createScenarioHarness();
    const { e1, e2 } = await seedAndStart(h, 'required');
    h.pointController.setDefaultMode('wrong-position');

    await h.commandPoint('p1', 'normal');
    await h.advance(POINT_CONFIRM_DELAY_MS);

    const point = h.service.getAllState().points.get('p1');
    expect(point?.commandedPosition).toBe('normal');
    expect(point?.confirmation).toBe('mismatch');
    expect(point?.confirmedPosition).toBe('reverse');

    const positions = h.service.getPointPositions();
    expect(isEdgeTraversable(e1, positions)).toBe(false); // requires 'normal' — not where it is
    expect(isEdgeTraversable(e2, positions)).toBe(true); // requires 'reverse' — where it actually is

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'mismatch' }]);

    await h.service.stop();
  });

  it("4. controller reports 'unknown' → indeterminate; nothing gated on the point is traversable", async () => {
    const h = createScenarioHarness();
    const { e1, e2 } = await seedAndStart(h, 'required');
    h.pointController.setDefaultMode('indeterminate');

    await h.commandPoint('p1', 'normal');
    await h.advance(POINT_CONFIRM_DELAY_MS);

    const point = h.service.getAllState().points.get('p1');
    expect(point?.confirmation).toBe('indeterminate');
    expect(point?.confirmedPosition).toBe('unknown');

    const positions = h.service.getPointPositions();
    expect(isEdgeTraversable(e1, positions)).toBe(false);
    expect(isEdgeTraversable(e2, positions)).toBe(false);

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'indeterminate' }]);

    await h.service.stop();
  });

  it('5. a malformed reading Safe-Stops with a populated safeStopReason; no point state is mutated', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h, 'required');
    const before = h.service.getAllState().points.get('p1');

    h.mqtt.simulateIncoming(`layout/${LAYOUT_ID}/point/p1/reading`, { garbage: true });
    await new Promise((r) => setImmediate(r));

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toBeTruthy();
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'malformed-payload' }]);
    expect(h.service.getAllState().points.get('p1')).toEqual(before);

    await h.service.stop();
  });

  it("6. a payload pointId that does not match the topic's own point Safe-Stops; NEITHER point's state is mutated", async () => {
    const h = createScenarioHarness();
    await seedAndStart(h, 'required', [point('p2', 'required')]);

    const beforeP1 = h.service.getAllState().points.get('p1');
    const beforeP2 = h.service.getAllState().points.get('p2');

    // The topic names p1; the payload claims p2.
    h.mqtt.simulateIncoming(`layout/${LAYOUT_ID}/point/p1/reading`, {
      pointId: 'p2',
      position: 'normal',
      source: 'sensor',
    });
    await new Promise((r) => setImmediate(r));

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    // Latched against the TOPIC point (p1), never the payload's claimed one.
    expect(h.service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'id-mismatch' }]);
    expect(h.service.getAllState().points.get('p1')).toEqual(beforeP1);
    expect(h.service.getAllState().points.get('p2')).toEqual(beforeP2);

    await h.service.stop();
  });

  it("7. restart: confirm a point, stop, start fresh against the SAME repository → unreported/unknown (D2/D10); a query is published; the simulator's answer restores confirmed", async () => {
    const h = createScenarioHarness();
    await seedAndStart(h, 'required');

    await h.commandPoint('p1', 'normal');
    await h.advance(POINT_CONFIRM_DELAY_MS);
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('confirmed');

    await h.service.stop();

    // A fresh process against the SAME repository — new adapters, new
    // clock, new controller, same persisted config. Nothing about
    // confirmation persists (D2/D10); only `positionFeedback` (the repo's
    // own config column) survives.
    const restartedState = new LayoutStateManager(LAYOUT_ID);
    const restartedReservations = new ReservationService(h.repo, restartedState, silentLogger);
    const restartedMqtt = new SimulatedMqttAdapter();
    const restartedDcc = new SimulatedDccAdapter(silentLogger);
    const restartedClock = new ManualClock(new Date('2026-01-01T00:00:00.000Z'));
    const restartedConfirmations = new PointConfirmationService(restartedState, {
      timeoutMs: POINT_CONFIRM_TIMEOUT_MS,
    });
    // A genuinely fresh controller instance — it has no memory of the
    // PREVIOUS process's commands, standing in for a real ESP controller
    // that (D9) reports whatever a hand-thrown point happens to be sitting
    // at when nothing has commanded it THIS session.
    const restartedController = new SimulatedPointController(restartedMqtt, restartedClock, LAYOUT_ID, silentLogger, {
      confirmDelayMs: POINT_CONFIRM_DELAY_MS,
    });
    await restartedController.start();
    const restartedService = new LayoutService(
      restartedDcc,
      restartedMqtt,
      h.repo,
      restartedState,
      restartedReservations,
      silentLogger,
      undefined,
      undefined,
      undefined,
      restartedClock,
      restartedConfirmations,
      (pointId, position) => restartedController.noteCommanded(pointId, position),
    );

    await restartedService.start(LAYOUT_ID);
    // See the matching comment in harness.ts's own `start` — lets the
    // startup query's REAL setImmediate delivery to restartedController
    // register its ManualClock-scheduled response before the clock moves.
    await new Promise((r) => setImmediate(r));

    const freshPoint = restartedService.getAllState().points.get('p1');
    expect(freshPoint?.confirmation).toBe('unreported');
    expect(freshPoint?.confirmedPosition).toBe('unknown');
    expect(freshPoint?.commandedPosition).toBeNull();

    const query = restartedMqtt.publishLog.find((entry) => entry.topic === `layout/${LAYOUT_ID}/point/p1/query`);
    expect(query).toBeDefined();
    expect(query?.retain).toBe(false);

    await restartedClock.advance(POINT_CONFIRM_DELAY_MS);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const settled = restartedService.getAllState().points.get('p1');
    expect(settled?.confirmation).toBe('confirmed');

    await restartedService.stop();
  });

  it('8. a broker drop mid-pending Safe-Stops via the existing MQTT path; the broker returning re-issues the query and the point re-confirms', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h, 'required');
    h.pointController.setDefaultMode('silent'); // the original command's report never comes

    await h.commandPoint('p1', 'normal');
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('pending');

    h.mqtt.disconnect();
    await new Promise((r) => setImmediate(r));

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toBeTruthy();
    // The MQTT transport path, not a latched PointFault — the 8000ms
    // deadline has not run yet, and never will while 'silent'.
    expect(h.service.getPointFaults()).toEqual([]);

    // Let the original (silent) command's scheduled response fire — still
    // nothing, proving the stall is real rather than a timing accident.
    await h.advance(POINT_CONFIRM_DELAY_MS);
    expect(h.service.getAllState().points.get('p1')?.confirmation).toBe('pending');

    // The channel — or the controller — is fixed, then the broker returns.
    h.pointController.setDefaultMode('confirm');
    await h.mqtt.connect();
    await new Promise((r) => setImmediate(r));

    expect(h.service.getSystemStatus().status).toBe('online');

    // D2: a reconnect re-issues point/*/query for every 'required' point —
    // this is the second one (the first was the startup query settled
    // inside seedAndStart).
    const queries = h.mqtt.publishLog.filter((entry) => entry.topic === `layout/${LAYOUT_ID}/point/p1/query`);
    expect(queries).toHaveLength(2);
    expect(queries.every((entry) => entry.retain === false)).toBe(true);

    await h.advance(POINT_CONFIRM_DELAY_MS);

    const point = h.service.getAllState().points.get('p1');
    expect(point?.confirmation).toBe('confirmed');
    expect(point?.confirmedPosition).toBe('normal');

    await h.service.stop();
  });

  it(
    "9. regression guard for the live layout: a 'positionFeedback: none' point commanded and never reporting stays " +
      'trusted at its commanded position — no timeout, no fault, no Safe-Stop, ever',
    async () => {
      const h = createScenarioHarness();
      const { e1 } = await seedAndStart(h, 'none');
      // 'silent' would be the honest simulated twin of "never reports", but a
      // 'none' point is never queried in the first place (D2/D6) — the point
      // of this test is that the SILENCE ITSELF is safe, not any one mode.
      h.pointController.setDefaultMode('silent');

      await h.commandPoint('p1', 'normal');
      // Comfortably past D5's 8000ms deadline — a 'required' point would have
      // faulted by now (scenario 2 above); a 'none' point must not, ever.
      await h.advance(POINT_CONFIRM_TIMEOUT_MS * 10);

      const point = h.service.getAllState().points.get('p1');
      expect(point?.commandedPosition).toBe('normal');
      // D7: 'none' never arms a deadline, so confirmation is left untouched —
      // still 'unreported' from registration, never 'pending' or 'timed-out'.
      expect(point?.confirmation).toBe('unreported');
      expect(h.service.getPointFaults()).toEqual([]);
      expect(h.service.getSystemStatus().status).toBe('online');

      // D7's fallback for an uninstrumented point: trusted at the COMMANDED
      // position, the same trust model the system used for every point
      // before #25 existed.
      expect(isEdgeTraversable(e1, h.service.getPointPositions())).toBe(true);

      await h.service.stop();
    },
  );
});
