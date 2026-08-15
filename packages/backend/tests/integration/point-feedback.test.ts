/**
 * Point Position Feedback integration tests (#25, Stage 2a).
 *
 * Exercises `LayoutService`, `PointConfirmationService` and
 * `SimulatedPointController` together on a `ManualClock` — the full
 * simulator, driven by hand rather than by a real timer, is what D9 and
 * CLAUDE.md safety rule 5 mean by "testable without hardware". Each test
 * settles the point's own startup `point/*\/query` first (§settle), so the
 * failure mode under test is the only thing that produces a reading.
 */

import { describe, it, expect, vi } from 'vitest';
import { LayoutService } from '../../src/services/LayoutService';
import { ReservationService } from '../../src/services/ReservationService';
import { PointConfirmationService } from '../../src/services/PointConfirmationService';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ManualClock } from '../../src/adapters/clock/ManualClock';
import { SimulatedPointController } from '../../src/adapters/simulator/SimulatedPointController';
import { ILayoutRepository, PointRecord } from '../../src/ports/ILayoutRepository';
import { PointFeedbackMode } from '../../src/domain/types';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const LAYOUT_ID = 'layout-1';
const CONFIRM_DELAY_MS = 150;
const TIMEOUT_MS = 8000;

function makeRepo(points: PointRecord[]): ILayoutRepository {
  return {
    listLayouts: vi.fn().mockResolvedValue([]),
    getLayout: vi.fn().mockResolvedValue(null),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn().mockResolvedValue([]),
    getLoco: vi.fn().mockResolvedValue(null),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([]),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn().mockResolvedValue(points),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn().mockResolvedValue([]),
    createSensor: vi.fn(),
    updateSensor: vi.fn(),
    deleteSensor: vi.fn(),
    listGridTiles: vi.fn().mockResolvedValue([]),
    upsertGridTile: vi.fn(),
    deleteTile: vi.fn(),
    clearGrid: vi.fn(),
    listBlockEdges: vi.fn().mockResolvedValue([]),
    getBlockEdge: vi.fn().mockResolvedValue(null),
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),
    getCompiledGraph: vi.fn().mockResolvedValue(null),
    replaceBlockEdges: vi.fn(),
    listReservations: vi.fn().mockResolvedValue([]),
    getReservation: vi.fn().mockResolvedValue(null),
    createReservation: vi.fn(),
    updateReservation: vi.fn(),
    markHoldsReleased: vi.fn(),
  };
}

/** Lets every pending timer due at or before `ms` fire, then flushes the two macrotask hops a simulator publish + LayoutService's own await chain need (mirrors the sensor-simulation harness's documented double-flush). */
async function advanceAndFlush(clock: ManualClock, ms: number): Promise<void> {
  await clock.advance(ms);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

/**
 * Builds a started `LayoutService` with one point, `p1`, wired to a
 * `SimulatedPointController` and a `ManualClock` shared by both. Settles
 * `p1`'s own startup `point/*\/query` (under the controller's default
 * `'confirm'` mode, harmless regardless of `feedback`) before returning, so
 * a test's own `setDefaultMode`/`setMode` call is the only thing that
 * produces the reading under test.
 */
async function build(feedback: PointFeedbackMode = 'required') {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const repo = makeRepo([
    { id: 'p1', layoutId: LAYOUT_ID, name: 'Point 1', dccAddress: 10, blockId: null, positionFeedback: feedback },
  ]);
  const stateManager = new LayoutStateManager(LAYOUT_ID);
  const reservations = new ReservationService(repo, stateManager, silentLogger);
  const clock = new ManualClock(new Date('2026-01-01T00:00:00.000Z'));
  const pointConfirmations = new PointConfirmationService(stateManager, { timeoutMs: TIMEOUT_MS });
  const controller = new SimulatedPointController(mqtt, clock, LAYOUT_ID, silentLogger, {
    confirmDelayMs: CONFIRM_DELAY_MS,
  });
  // Safe before connect() — SimulatedMqttAdapter.subscribe is local/synchronous.
  await controller.start();

  const service = new LayoutService(
    dcc,
    mqtt,
    repo,
    stateManager,
    reservations,
    silentLogger,
    undefined,
    undefined,
    undefined,
    clock,
    pointConfirmations,
    (pointId, position) => controller.noteCommanded(pointId, position),
  );

  await service.start(LAYOUT_ID);
  // §settle: let the startup query (issued for a 'required' point at the end
  // of start()) resolve before the test's own command — otherwise two
  // scheduled responses (the startup query's and the test's own command's)
  // land on the same clock tick.
  await advanceAndFlush(clock, CONFIRM_DELAY_MS);

  return { service, dcc, mqtt, stateManager, clock, controller };
}

describe('Point position feedback (#25) — LayoutService + PointConfirmationService + SimulatedPointController on a ManualClock', () => {
  it("'silent' mode: advancing past the confirmation timeout gives 'timed-out' with confirmedPosition 'unknown'", async () => {
    const { service, stateManager, clock, controller } = await build('required');
    controller.setDefaultMode('silent');

    await service.handlePointCommand({ pointId: 'p1', position: 'reverse' });
    expect(stateManager.getPoint('p1')?.confirmation).toBe('pending');

    // Comfortably past the delay a real response would have come at — still
    // nothing, because 'silent' never publishes.
    await advanceAndFlush(clock, CONFIRM_DELAY_MS);
    expect(stateManager.getPoint('p1')?.confirmation).toBe('pending');

    // The remainder of D5's 8000ms deadline plus one extra sweep interval —
    // the 250ms sweep evaluates the deadline on its own schedule, so this
    // must cross the first sweep tick ON OR AFTER the deadline, not merely
    // reach the deadline's own instant.
    await advanceAndFlush(clock, TIMEOUT_MS - CONFIRM_DELAY_MS + 250);

    const point = stateManager.getPoint('p1');
    expect(point?.confirmation).toBe('timed-out');
    expect(point?.confirmedPosition).toBe('unknown');
    expect(service.getSystemStatus().status).toBe('safe-stop');
    expect(service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'timeout' }]);

    await service.stop();
  });

  it("'wrong-position' mode gives 'mismatch', holding the REPORTED value, not the commanded one", async () => {
    const { service, stateManager, clock, controller } = await build('required');
    controller.setDefaultMode('wrong-position');

    await service.handlePointCommand({ pointId: 'p1', position: 'reverse' });
    await advanceAndFlush(clock, CONFIRM_DELAY_MS);

    const point = stateManager.getPoint('p1');
    expect(point?.commandedPosition).toBe('reverse');
    expect(point?.confirmation).toBe('mismatch');
    expect(point?.confirmedPosition).toBe('normal');
    expect(service.getSystemStatus().status).toBe('safe-stop');
    expect(service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'mismatch' }]);

    await service.stop();
  });

  it("'indeterminate' mode on a 'required' point gives 'indeterminate'", async () => {
    const { service, stateManager, clock, controller } = await build('required');
    controller.setDefaultMode('indeterminate');

    await service.handlePointCommand({ pointId: 'p1', position: 'normal' });
    await advanceAndFlush(clock, CONFIRM_DELAY_MS);

    const point = stateManager.getPoint('p1');
    expect(point?.confirmation).toBe('indeterminate');
    expect(point?.confirmedPosition).toBe('unknown');
    expect(service.getSystemStatus().status).toBe('safe-stop');
    expect(service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'indeterminate' }]);

    await service.stop();
  });

  it("'driver-only' mode on a 'required' point ALSO gives 'indeterminate' — a delivery ack is not a position confirmation (D3)", async () => {
    const { service, stateManager, clock, controller } = await build('required');
    controller.setDefaultMode('driver-only');

    await service.handlePointCommand({ pointId: 'p1', position: 'normal' });
    await advanceAndFlush(clock, CONFIRM_DELAY_MS);

    const point = stateManager.getPoint('p1');
    expect(point?.confirmation).toBe('indeterminate');
    expect(point?.confirmedPosition).toBe('unknown');
    expect(service.getSystemStatus().status).toBe('safe-stop');
    expect(service.getPointFaults()).toMatchObject([{ pointId: 'p1', kind: 'indeterminate' }]);

    await service.stop();
  });

  it(
    "regression guard for the live layout: a 'none' point commanded and never reporting stays trusted at its " +
      'commanded position — no timeout, no fault, no Safe-Stop, ever',
    async () => {
      const { service, stateManager, clock, controller } = await build('none');
      // 'silent' would be the honest simulated twin of "never reports", but a
      // 'none' point is never queried in the first place (D2) — the point of
      // this test is that the SILENCE ITSELF is safe, not any particular mode.
      controller.setDefaultMode('silent');

      await service.handlePointCommand({ pointId: 'p1', position: 'reverse' });
      // Comfortably past D5's 8000ms deadline — a 'required' point would have
      // faulted by now (see the 'silent' test above); a 'none' point must not.
      await advanceAndFlush(clock, TIMEOUT_MS * 10);

      const point = stateManager.getPoint('p1');
      expect(point?.commandedPosition).toBe('reverse');
      // D7: 'none' never arms a deadline, so confirmation is left untouched —
      // still 'unreported' from registration, not 'pending' and never 'timed-out'.
      expect(point?.confirmation).toBe('unreported');
      expect(service.getPointFaults()).toEqual([]);
      expect(service.getSystemStatus().status).toBe('online');

      await service.stop();
    },
  );
});
