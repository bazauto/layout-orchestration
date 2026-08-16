/**
 * LayoutService
 *
 * The central orchestration service. Connects hardware adapters to domain logic.
 * Responsibilities:
 *  - Starting and stopping all adapters
 *  - Subscribing to sensor MQTT topics and updating block state
 *  - Processing throttle, point, and function commands with safety enforcement
 *  - Triggering Safe-Stop on connection loss
 *  - Emitting LayoutEvents to subscribers (e.g., the WebSocket transport layer)
 *
 * Business logic lives here. Hardware concerns stay in adapters.
 *
 * Route reservations (see docs/route-locking.md) are owned by
 * `ReservationService`; this service calls in and reacts to the outcomes —
 * publishing events, issuing the DCC/loco-stop commands `ReservationService`
 * itself has no access to, and folding restart-recovered routes into
 * `SystemHealth` (D9).
 */

import { EventEmitter } from 'events';
import {
  BlockId,
  BlockState,
  BrakingFault,
  BrakingFaultView,
  BrakingRefusal,
  BrakingSchedule,
  BrakingStep,
  BrakingStopExpectation,
  Direction,
  FunctionCommand,
  LayoutEvent,
  LayoutId,
  LocoAddress,
  LocoState,
  NameBook,
  Occupancy,
  PointCommand,
  PointFault,
  PointFaultView,
  PointId,
  PointPosition,
  PointReading,
  PointState,
  RouteFault,
  RouteFaultView,
  RouteHold,
  RouteId,
  RouteRejection,
  RouteReservation,
  RouteStatus,
  SensorFault,
  SensorFaultView,
  SensorId,
  SetModeCommand,
  SystemMode,
  SystemStatus,
  ThrottleCommand,
} from '../domain/types';
import { LayoutStateManager } from '../domain/layoutState';
import {
  canForcePointOverride,
  canIssueAutoCommand,
  canIssueManualCommand,
  evaluateSystemSafeStop,
  isBlockEffectivelyOccupied,
  isValidLocoAddress,
  isValidSpeed,
  SystemHealth,
} from '../domain/safety';
import {
  BrakingPlan,
  buildStopExpectation,
  describeBrakingRefusal,
  isBrakingOverrun,
  toBrakingFaultView,
} from '../domain/braking';
import { deriveBlockOccupancy, isSensorFaultArmed, toSensorFaultView } from '../domain/occupancy';
import { isEmptySensorPayload } from '../domain/sensorPayload';
import {
  buildPointPositionMap,
  isPointFaultArmed,
  toPointFaultView,
} from '../domain/pointConfirmation';
import { pointReadingSchema } from '../domain/pointPayload';
import { TrackGraph } from '../domain/graph';
import { toRouteFaultView } from '../domain/routeLocking';
import { blockLabel, layoutLabel, locoLabel, pluralise, pointLabel, sensorLabel } from '../domain/naming';
import { IDccController } from '../ports/IDccController';
import { IMqttAdapter } from '../ports/IMqttAdapter';
import { ILayoutRepository, PointRecord, SensorRecord } from '../ports/ILayoutRepository';
import { INameBook } from '../ports/INameBook';
import { ClockTimer, IClock } from '../ports/IClock';
import {
  IGraphCompletenessView,
  INERT_GRAPH_COMPLETENESS,
} from '../ports/IGraphCompletenessView';
import { SensorCreateInput, sensorReadingSchema, SensorUpdateInput } from './validation';
import { INERT_NAME_BOOK } from './nameBook';
import { loadTopology, TopologyLoadResult } from './topologyLoader';
import { PointConfirmationService } from './PointConfirmationService';
import { BrakingService } from './BrakingService';
import { SystemClock } from '../adapters/clock/SystemClock';
import {
  GrantOutcome,
  GrantRequest,
  ReservationOutcome,
  ReservationService,
  ResumeResult,
  RouteNotFoundError,
} from './ReservationService';

/**
 * D1 (docs/sensor-fault-recovery.md): consecutive valid, non-retained
 * readings a faulted sensor must publish before its fault becomes
 * acknowledgeable. Layout-wide, not per-sensor (deferred — see the doc's
 * Deferred section).
 */
export interface LayoutServiceOptions {
  clearAfterValidReadings: number;
  /** D5 (docs/point-feedback.md): how often, in ms, the confirmation sweep applies `evaluateTimeout` to every registered point. */
  pointSweepIntervalMs: number;
  /** D4: consecutive confirming readings a latched `PointFault` needs before an operator may acknowledge it — the point-side twin of `clearAfterValidReadings`. */
  pointFaultClearAfterConfirmations: number;
}

export const DEFAULT_LAYOUT_SERVICE_OPTIONS: LayoutServiceOptions = {
  clearAfterValidReadings: 3,
  pointSweepIntervalMs: 250,
  pointFaultClearAfterConfirmations: 1,
};

export interface LayoutServiceLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Thrown when a manual point command targets a point locked by an active route and `force` was not set. */
export class PointLockedError extends Error {
  constructor(
    readonly pointId: PointId,
    readonly routeId: RouteId,
    pointLabelText?: string,
  ) {
    super(`Point ${pointLabelText ?? pointId} is locked by route ${routeId}. Use force=true to override.`);
    this.name = 'PointLockedError';
  }
}

/** Thrown by sensor-config/fault-recovery methods when a sensor id does not resolve in the given layout (see docs/sensor-fault-recovery.md). */
export class SensorNotFoundError extends Error {
  constructor(
    readonly sensorId: string,
    sensorLabelText?: string,
  ) {
    super(`Sensor ${sensorLabelText ?? sensorId} not found`);
    this.name = 'SensorNotFoundError';
  }
}

/** Thrown by `acknowledgeSensorFault` when the named sensor has no fault latched. */
export class SensorNotFaultedError extends Error {
  constructor(
    readonly sensorId: string,
    sensorLabelText?: string,
  ) {
    super(`Sensor ${sensorLabelText ?? sensorId} has no active fault`);
    this.name = 'SensorNotFaultedError';
  }
}

/** Thrown by `acknowledgeSensorFault` when the fault has not yet accumulated `clearAfterValidReadings` consecutive valid readings (D1). */
export class SensorFaultNotArmedError extends Error {
  constructor(
    readonly sensorId: string,
    readonly consecutiveValidReadings: number,
    readonly requiredValidReadings: number,
    sensorLabelText?: string,
  ) {
    super(
      // No manual quoting here (unlike the pre-#54 message) — sensorLabel
      // already quotes the name when one is known, and the raw-id fallback
      // with no book matches the D8 degradation contract for `describe*`.
      `Sensor ${sensorLabelText ?? sensorId} fault is not yet armed: ${requiredValidReadings - consecutiveValidReadings} more consecutive valid reading(s) required`,
    );
    this.name = 'SensorFaultNotArmedError';
  }

  get outstanding(): number {
    return this.requiredValidReadings - this.consecutiveValidReadings;
  }
}

/** Thrown by point-fault-recovery methods when a point id does not resolve in the given layout (mirrors `SensorNotFoundError`). */
export class PointNotFoundError extends Error {
  constructor(
    readonly pointId: string,
    pointLabelText?: string,
  ) {
    super(`Point ${pointLabelText ?? pointId} not found`);
    this.name = 'PointNotFoundError';
  }
}

/** Thrown by `acknowledgePointFault` when the named point has no fault latched. */
export class PointNotFaultedError extends Error {
  constructor(
    readonly pointId: string,
    pointLabelText?: string,
  ) {
    super(`Point ${pointLabelText ?? pointId} has no active fault`);
    this.name = 'PointNotFaultedError';
  }
}

/** Thrown by `acknowledgePointFault` when the fault has not yet accumulated `pointFaultClearAfterConfirmations` consecutive confirming readings (D4). */
export class PointFaultNotArmedError extends Error {
  constructor(
    readonly pointId: string,
    readonly consecutiveConfirmations: number,
    readonly requiredConfirmations: number,
    pointLabelText?: string,
  ) {
    super(
      // Mirrors SensorFaultNotArmedError's message shape exactly (D8 degradation contract).
      `Point ${pointLabelText ?? pointId} fault is not yet armed: ${requiredConfirmations - consecutiveConfirmations} more consecutive confirming reading(s) required`,
    );
    this.name = 'PointFaultNotArmedError';
  }

  get outstanding(): number {
    return this.requiredConfirmations - this.consecutiveConfirmations;
  }
}

/** One point command that did not take effect while setting a route's road (#4). */
interface PointCommandFailure {
  pointId: PointId;
  requiredPosition: 'normal' | 'reverse';
  message: string;
}

/** Thrown by `acknowledgeRouteFault` when the named route has no fault latched (#4). */
export class RouteNotFaultedError extends Error {
  constructor(readonly routeId: RouteId) {
    super(`Route ${routeId} has no latched fault`);
    this.name = 'RouteNotFaultedError';
  }
}

/** Thrown by `acknowledgeBrakingFault` when the named loco has no fault latched (#6, B10). */
export class LocoNotFaultedError extends Error {
  constructor(readonly locoAddress: LocoAddress) {
    super(`Loco ${locoAddress} has no latched braking fault`);
    this.name = 'LocoNotFaultedError';
  }
}

/**
 * One braking ramp in flight (#6 PR B, B3). `timer` holds the handle for the
 * *next* step only: the ramp chains one `IClock.setTimeout` into the next as
 * each step is issued, rather than arming every step up front, so aborting is
 * a single `cancel()` with no window in which a later timer survives.
 */
interface BrakingRun {
  locoAddress: LocoAddress;
  /** The route this run was planned against, or `null` for B8's unconstrained standard stop. */
  routeId: RouteId | null;
  schedule: BrakingSchedule;
  /** Index into `schedule.steps` of the next step to issue. */
  nextStepIndex: number;
  timer: ClockTimer | null;
}

/** What `startStandardStop`/`startRouteStop` answer: the plan that is now running, or why there is none. */
export type BrakingRunOutcome =
  | { started: true; schedule: BrakingSchedule }
  | { started: false; reason: BrakingRefusal };

export class LayoutService extends EventEmitter {
  private layoutId: LayoutId | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private health: SystemHealth = {
    mqttConnected: false,
    dccConnected: false,
    topologyValid: true,
    topologyReason: null,
    sensorFaults: {},
    pointFaults: {},
    routeFaults: {},
    brakingFaults: {},
    recoveredRouteCount: 0,
  };
  private graph: TrackGraph | null = null;
  /** Route ids revived by `ReservationService.loadOnStartup` (D9) that the
   * operator has not yet cancelled or resumed. Backs `SystemHealth.recoveredRouteCount`;
   * emptying this set is what lets the D9 Safe-Stop latch clear. */
  private recoveredRouteIds = new Set<RouteId>();
  private readonly options: LayoutServiceOptions;
  /** #25 D5: the confirmation-sweep handle, started next to the heartbeat and stopped in `stop()`. `null` when not running. */
  private confirmationSweepTimer: ClockTimer | null = null;
  /**
   * #6 PR B: the braking ramps currently in flight, one per loco — a second
   * run for a loco replaces the first (see `beginBrakingRun`). Each holds the
   * single live `IClock` timer for its *next* step; the ramp is a chain, not
   * a fan of timers, so cancelling one handle stops the whole remaining run.
   */
  private readonly brakingRuns = new Map<LocoAddress, BrakingRun>();
  /**
   * B5's armed overrun expectations, one per loco. Deliberately **outlives
   * its run**: the ramp finishing is not evidence the train stopped where it
   * was told to, and rolling into the target block a second after the last
   * speed command is exactly the overrun this exists to catch. Cleared only
   * by the three things that make it meaningless — a manual throttle command
   * for that loco (B6, the operator's command stands), its route ceasing to
   * be active, or the expectation firing.
   */
  private readonly stopExpectations = new Map<LocoAddress, BrakingStopExpectation>();

  constructor(
    private readonly dcc: IDccController,
    private readonly mqtt: IMqttAdapter,
    private readonly repo: ILayoutRepository,
    private readonly stateManager: LayoutStateManager,
    private readonly reservations: ReservationService,
    private readonly log: LayoutServiceLogger,
    options?: Partial<LayoutServiceOptions>,
    private readonly names: INameBook = INERT_NAME_BOOK,
    /**
     * How complete the compiled graph is (#103, D6). Optional and inert by
     * default, matching `INameBook`: an unwired service gates nothing, because
     * nothing has told it anything about completeness.
     */
    private readonly completeness: IGraphCompletenessView = INERT_GRAPH_COMPLETENESS,
    /**
     * #25: time and timers for the point-confirmation sweep (D5). Defaults to
     * a real `SystemClock` — every existing call site keeps behaving exactly
     * as it does today (the sweep runs on a real interval, the same way the
     * heartbeat always has); a caller that needs to control time (tests)
     * passes a `ManualClock` explicitly.
     */
    private readonly clock: IClock = new SystemClock(),
    /**
     * #25: owns point-confirmation policy (docs/point-feedback.md). Defaults
     * to one scoped to this instance's own `stateManager` with D5's 8000ms
     * timeout — `index.ts` constructs and passes its own, built from
     * `config.points.confirmTimeoutMs`, so this fallback only matters to a
     * call site that does not care.
     */
    private readonly pointConfirmations: PointConfirmationService = new PointConfirmationService(stateManager, {
      timeoutMs: 8000,
    }),
    /**
     * D9: the in-process hook `SimulatedPointController` (and, one day, a
     * real command-observing controller) learns of a point command through.
     * `LayoutService` never reads or imports anything about the simulator —
     * `index.ts` is the only thing that wires this, which is what keeps the
     * dependency one-way.
     */
    private readonly onPointCommanded?: (pointId: PointId, position: 'normal' | 'reverse') => void,
    /**
     * #6: owns braking *planning* (docs/braking.md). Defaults to one scoped
     * to this instance's own repository and state manager, mirroring
     * `pointConfirmations` — a call site that wants a different
     * `StoppingDistanceModel` (B2's seam, for a measured per-loco curve)
     * constructs its own and passes it here. This service executes what that
     * one plans and never re-implements any part of it.
     */
    private readonly braking: BrakingService = new BrakingService(repo, stateManager, log),
  ) {
    super();
    this.options = { ...DEFAULT_LAYOUT_SERVICE_OPTIONS, ...options };
    // A nonsense safety threshold must fail at boot, loudly, where it cannot
    // move hardware — not silently fall back to a default at the first
    // sensor fault (DD8).
    if (
      !Number.isInteger(this.options.clearAfterValidReadings) ||
      this.options.clearAfterValidReadings < 1
    ) {
      throw new Error(
        `[LayoutService] clearAfterValidReadings must be an integer >= 1, got ${this.options.clearAfterValidReadings}`,
      );
    }
    // Same posture, extended to #25's point-confirmation thresholds — a
    // nonsense sweep interval or arming threshold fails at boot, not silently
    // at the first point fault.
    if (
      !Number.isInteger(this.options.pointSweepIntervalMs) ||
      this.options.pointSweepIntervalMs < 1
    ) {
      throw new Error(
        `[LayoutService] pointSweepIntervalMs must be an integer >= 1, got ${this.options.pointSweepIntervalMs}`,
      );
    }
    if (
      !Number.isInteger(this.options.pointFaultClearAfterConfirmations) ||
      this.options.pointFaultClearAfterConfirmations < 1
    ) {
      throw new Error(
        `[LayoutService] pointFaultClearAfterConfirmations must be an integer >= 1, got ${this.options.pointFaultClearAfterConfirmations}`,
      );
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  async start(layoutId: LayoutId): Promise<void> {
    this.layoutId = layoutId;

    // Wire up connection health monitors before connecting
    this.mqtt.onConnectionChange((connected) => this.handleMqttConnectionChange(connected));
    this.dcc.onConnectionChange((connected) => this.handleDccConnectionChange(connected));

    // Connect adapters
    await this.mqtt.connect();
    await this.dcc.connect();

    // Go online before loading topology: reloadTopology (called from
    // initializeLayoutState below) applies Safe-Stop via the same path as a
    // connection failure, which is a no-op while systemStatus is 'offline'.
    // An invalid topology at boot must land on 'safe-stop', not silently be
    // skipped and then overwritten once this method returns.
    this.stateManager.setOnline();

    // Load layout config and register blocks/points in state, revive any
    // restart-surviving route reservations, then validate and build the
    // track graph.
    await this.initializeLayoutState(layoutId);

    // Subscribe to sensor topics
    await this.subscribeSensors(layoutId);
    // #25: one wildcard subscription for every point's reading, mirroring
    // subscribeSensors' per-topic shape but collapsed to one topic pattern —
    // there is no per-point in-service gate to honour the way sensors have.
    await this.subscribePointReadings(layoutId);

    this.publishSystemStatus();
    this.startHeartbeat();
    this.startConfirmationSweep();

    // #25 D2: recovers position live from every 'required' point — the only
    // recovery consistent with D1's retention argument, since nothing about
    // confirmation persists across a restart.
    await this.queryPointPositions();

    this.log.info('[LayoutService] Started', { layoutId });
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    this.stopConfirmationSweep();
    // Timers outlive a `stop()` that does not cancel them, and a ramp step
    // firing against a disconnected adapter is noise at best.
    this.abortAllBrakingRuns('service stopped');

    if (this.layoutId) {
      this.stateManager.setOffline();
      this.publishSystemStatus();
    }

    await this.dcc.disconnect();
    await this.mqtt.disconnect();
    this.log.info('[LayoutService] Stopped');
  }

  // ─── Command Handlers (called by transport layer) ─────────────────────────────

  async handleThrottleCommand(cmd: ThrottleCommand): Promise<void> {
    const state = this.stateManager.getState();

    if (!isValidLocoAddress(cmd.locoAddress)) {
      throw new Error(`Invalid loco address: ${cmd.locoAddress}`);
    }
    if (!isValidSpeed(cmd.speed)) {
      throw new Error(`Invalid speed: ${cmd.speed}. Must be 0–126.`);
    }
    if (!canIssueManualCommand(state.systemStatus)) {
      throw new Error(`Cannot issue command: system is ${state.systemStatus}`);
    }

    // B6: manual wins (D6, docs/route-locking.md), so an in-flight braking
    // ramp for this loco is aborted and its overrun expectation cleared —
    // the operator's command stands, and the blocks the run promised the
    // train would not reach are now theirs to enter. Done BEFORE the DCC
    // command below, so no ramp step can land on top of it.
    this.abortBrakingRun(cmd.locoAddress, 'manual throttle command', { clearExpectation: true });

    // D6: a manual throttle command for a loco that is the subject of an
    // auto-authority route cancels that route — the operator has taken the
    // train, and two authorities on one loco is worse than a lost route. A
    // manual-authority route is left alone: that IS the operator driving
    // their own reserved road.
    if (this.layoutId) {
      const holding = this.reservations.routeHoldingLoco(this.layoutId, cmd.locoAddress);
      if (holding && holding.authority === 'auto') {
        const outcome = await this.reservations.cancel(
          this.layoutId,
          holding.id,
          'manual throttle command took control of an auto-authority loco',
        );
        await this.finalizeReservationOutcome(outcome);
      }
    }

    await this.dcc.setSpeed(cmd.locoAddress, cmd.speed, cmd.direction);

    const locoState = this.stateManager.updateLoco(cmd.locoAddress, {
      speed: cmd.speed,
      direction: cmd.direction,
      authority: 'manual',
    });

    this.publishLocoState(locoState);
    this.emit('event', { type: 'LOCO_STATE', payload: locoState } satisfies LayoutEvent);
    this.log.info('[LayoutService] Throttle command applied', {
      address: cmd.locoAddress,
      locoName: this.names.get().locos.get(cmd.locoAddress),
      speed: cmd.speed,
      direction: cmd.direction,
    });
  }

  async handleFunctionCommand(cmd: FunctionCommand): Promise<void> {
    const state = this.stateManager.getState();

    if (!canIssueManualCommand(state.systemStatus)) {
      throw new Error(`Cannot issue command: system is ${state.systemStatus}`);
    }

    await this.dcc.setFunction(cmd.locoAddress, cmd.fn, cmd.state);

    const existing = this.stateManager.getLoco(cmd.locoAddress);
    const locoState = this.stateManager.updateLoco(cmd.locoAddress, {
      functions: { ...(existing?.functions ?? {}), [cmd.fn]: cmd.state },
    });

    this.publishLocoState(locoState);
    this.emit('event', { type: 'LOCO_STATE', payload: locoState } satisfies LayoutEvent);
  }

  async handlePointCommand(cmd: PointCommand): Promise<void> {
    const state = this.stateManager.getState();

    if (!canIssueManualCommand(state.systemStatus)) {
      throw new Error(`Cannot issue point command: system is ${state.systemStatus}`);
    }

    const pointState = state.points.get(cmd.pointId);
    if (pointState?.locked) {
      if (!cmd.force) {
        throw new PointLockedError(cmd.pointId, pointState.lockedByRoute!, pointLabel(cmd.pointId, this.names.get()));
      }
      // D6: force is refused outright in auto mode (no manual authority in
      // auto). Otherwise permitted, and it CANCELS the route holding the
      // point — releasing all of that route's locks and stopping its loco
      // if the route's authority is auto. It does NOT trigger a
      // system-wide Safe-Stop: this is a deliberate, authorised operator
      // action scoped to one route.
      if (!canForcePointOverride(state.systemStatus, state.systemMode)) {
        throw new Error(
          `Force override refused: not permitted while system is ${state.systemStatus} in ${state.systemMode} mode`,
        );
      }
      if (this.layoutId) {
        const routeId = pointState.lockedByRoute!;
        const outcome = await this.reservations.cancel(
          this.layoutId,
          routeId,
          `force override on point ${cmd.pointId}`,
        );
        if (outcome.reservation?.authority === 'auto') {
          await this.stopLoco(outcome.reservation.locoAddress);
        }
        await this.finalizeReservationOutcome(outcome);
        this.log.warn('[LayoutService] Force point override cancelled the holding route', {
          pointId: cmd.pointId,
          routeId,
        });
      }
    }

    // Look up the DCC accessory address for this point
    const pointRecord = (await this.repo.listPoints(this.layoutId!)).find(
      (p) => p.id === cmd.pointId,
    );
    if (!pointRecord) {
      throw new Error(
        `Point ${pointLabel(cmd.pointId, this.names.get())} not found in layout ${layoutLabel(this.layoutId!, this.names.get())}`,
      );
    }

    await this.dcc.setPoint(pointRecord.dccAddress, cmd.position);

    // #25: arms a confirmation deadline on a 'required' point (D5); a no-op
    // on `confirmation` for 'none' (D7). `onPointCommanded` — D9's in-process
    // hook, wired to the simulated point controller from index.ts — fires
    // regardless of feedback mode, same as the real command itself.
    const updated = this.pointConfirmations.noteCommanded(cmd.pointId, cmd.position, this.clock.now());
    if (updated) {
      this.publishPointState(updated);
      this.emit('event', { type: 'POINT_STATE', payload: updated } satisfies LayoutEvent);
    }
    this.onPointCommanded?.(cmd.pointId, cmd.position);
    this.log.info('[LayoutService] Point command applied', {
      pointId: cmd.pointId,
      pointName: this.names.get().points.get(cmd.pointId),
      position: cmd.position,
    });
  }

  async handleEmergencyStop(): Promise<void> {
    this.log.warn('[LayoutService] EMERGENCY STOP');
    // B6: before the broadcast stop, never after — a ramp's next step is a
    // scheduled `setSpeed`, and one landing after an emergency stop would
    // restart a train the operator has just halted.
    this.abortAllBrakingRuns('emergency stop');
    await this.dcc.emergencyStop();

    const stopped = this.stateManager.stopAllLocos();
    for (const loco of stopped) {
      this.publishLocoState(loco);
      this.emit('event', { type: 'LOCO_STATE', payload: loco } satisfies LayoutEvent);
    }
  }

  /**
   * Changes the system mode, refusing an automated one while the compiled graph
   * has gaps (#103, D6/D-C).
   *
   * **Gated here, at the transition, rather than inside `canIssueAutoCommand`.**
   * That predicate is pure over two enums and is called on every automated
   * command; threading a third argument through it would ripple into every
   * caller and turn a per-layout async read into a hot path. A mode change is
   * rare and human-initiated, so this is where the question is cheap to ask and
   * where the answer is useful — the operator finds out when they ask for
   * `auto`, not when a train has already started moving.
   *
   * **`hybrid` is gated as well as `auto`.** D6 names only `auto`, but
   * `canIssueAutoCommand` returns true for `hybrid` too, so gating `auto` alone
   * would leave the automated-command path open through the side door.
   *
   * A refusal is a **throw, not a Safe-Stop**. The transport turns it into an
   * `ERROR` frame and the layout keeps running in whatever mode it was already
   * in: refusing to grant new authority is not the same as taking existing
   * authority away, and halting a railway because someone clicked the wrong
   * button would be its own bug.
   */
  async handleSetMode(cmd: SetModeCommand): Promise<void> {
    if (this.layoutId && (cmd.mode === 'auto' || cmd.mode === 'hybrid')) {
      const gaps = await this.completeness.gapCount(this.layoutId);
      if (gaps > 0) {
        this.log.warn('[LayoutService] Refused mode change — compiled graph has gaps', {
          layoutId: this.layoutId,
          layoutName: this.names.get().layouts.get(this.layoutId),
          mode: cmd.mode,
          gapCount: gaps,
        });
        throw new Error(
          `Cannot enter ${cmd.mode} mode: the compiled track graph has ${pluralise(gaps, 'gap')}. Compile the drawing and resolve them first.`,
        );
      }
    }

    this.stateManager.setMode(cmd.mode);

    // D7: flipping systemMode to 'manual' suspends every auto-authority
    // route — suspends, not cancels, so the locks stay held and the
    // operator decides.
    if (cmd.mode === 'manual' && this.layoutId) {
      const outcomes = await this.reservations.suspendAuto(this.layoutId, 'system mode set to manual');
      for (const outcome of outcomes) {
        this.publishReservationOutcome(outcome);
      }
    }

    this.publishSystemStatus();
    this.log.info('[LayoutService] Mode changed', { mode: cmd.mode });
  }

  // ─── Route Reservations (see docs/route-locking.md) ────────────────────────────

  /**
   * Grants a route and **sets the road** for it (#4).
   *
   * `ReservationService.grant` resolves the path (searching the graph when
   * the request named a destination), plans, persists, and commits the
   * locks. Only then does this method issue the point commands the route
   * needs — after the locks are committed, never during acquisition (D3):
   * you never send a physical command for a route you have not yet fully
   * reserved.
   *
   * A point command the DCC adapter **rejects** invalidates the whole route.
   * That is #4's stated criterion and it is not a retry case: some points may
   * already have moved, so the physical state of the layout no longer matches
   * either the old road or the new one. The route is cancelled (locks
   * released), a `RouteFault` is latched, and the system Safe-Stops. The
   * caller is told `granted: false` — the reservation row survives as
   * `cancelled` for the record, but nothing the operator asked for is in
   * effect, and reporting it as granted would be a lie.
   */
  async requestRoute(request: GrantRequest): Promise<GrantOutcome> {
    if (!this.layoutId) throw new Error('[LayoutService] requestRoute called before start()');
    const outcome = await this.reservations.grant(this.layoutId, request, this.graph);

    if (!outcome.granted) {
      this.log.warn('[LayoutService] Route request rejected', {
        layoutId: this.layoutId,
        locoAddress: request.locoAddress,
        locoName: this.names.get().locos.get(request.locoAddress),
        rejections: outcome.rejections,
      });
      return outcome;
    }

    const reservation = outcome.reservation;
    this.emit('event', { type: 'ROUTE_STATE', payload: reservation } satisfies LayoutEvent);
    for (const block of outcome.changedBlocks) {
      this.publishBlockState(block);
      this.emit('event', { type: 'BLOCK_STATE', payload: block } satisfies LayoutEvent);
    }
    for (const point of outcome.changedPoints) {
      this.publishPointState(point);
      this.emit('event', { type: 'POINT_STATE', payload: point } satisfies LayoutEvent);
    }

    // `commandPointHolds` selects the point holds itself, so this passes the
    // whole set rather than pre-filtering it in two places.
    const failures = await this.commandPointHolds(reservation.holds.filter((h) => !h.released));
    if (failures.length > 0) {
      return this.abandonRouteOnPointFailure(reservation, failures);
    }

    this.log.info('[LayoutService] Route granted and road set', {
      layoutId: this.layoutId,
      routeId: reservation.id,
      locoAddress: reservation.locoAddress,
      locoName: this.names.get().locos.get(reservation.locoAddress),
    });
    return outcome;
  }

  /**
   * Undoes a grant whose road could not be set: cancel the route (releasing
   * its locks), latch a `RouteFault`, and Safe-Stop. Returns the rejection
   * list the caller sees in place of the grant.
   */
  private async abandonRouteOnPointFailure(
    reservation: RouteReservation,
    failures: PointCommandFailure[],
  ): Promise<GrantOutcome> {
    // The DCC adapter's error text inside each `failure.message` is not
    // named/bounded by #54 — pre-existing and out of scope (see docs/naming.md).
    const reason = `route ${reservation.id} abandoned — ${pluralise(failures.length, 'point command')} rejected: ${failures
      .map((f) => f.message)
      .join('; ')}`;

    this.log.error('[LayoutService] Route abandoned — point command rejected', {
      layoutId: this.layoutId,
      routeId: reservation.id,
      locoAddress: reservation.locoAddress,
      locoName: this.names.get().locos.get(reservation.locoAddress),
      failures: failures.map((f) => f.message),
    });

    const cancelled = await this.reservations.cancel(this.layoutId!, reservation.id, reason);
    this.publishReservationOutcome(cancelled);

    await this.raiseRouteFault({
      routeId: reservation.id,
      kind: 'point-command-rejected',
      reason,
      blockId: null,
      pointId: null,
      locoAddress: reservation.locoAddress,
    });

    const rejections: RouteRejection[] = failures.map((failure) => ({
      kind: 'point-command-rejected',
      pointId: failure.pointId,
      requiredPosition: failure.requiredPosition,
      reason: failure.message,
    }));
    return { granted: false, rejections };
  }

  async cancelRoute(routeId: RouteId, reason: string | null): Promise<ReservationOutcome> {
    if (!this.layoutId) throw new Error('[LayoutService] cancelRoute called before start()');
    const outcome = await this.reservations.cancel(this.layoutId, routeId, reason);
    await this.finalizeReservationOutcome(outcome);
    return outcome;
  }

  /**
   * D8's resume: `ReservationService.resume` validates preconditions and
   * flips the route back to `active`; this method then re-commands every
   * held point to its required position — `ReservationService` has no DCC
   * access, so the physical re-command necessarily happens here.
   *
   * That re-commanding is **not** best-effort. D8 refuses a resume unless
   * every held point is re-commanded, so a rejected command rolls the route
   * straight back to `suspended` (locks retained) and leaves the D9 restart
   * latch intact. A *rejected* command happens at send time, before any
   * confirmation reading could ever arrive (#25 D8, `docs/route-locking.md`
   * D11), so it is the only evidence available on EITHER kind of point that
   * the road is not set, and must not be swallowed.
   */
  async resumeRoute(routeId: RouteId): Promise<ResumeResult> {
    if (!this.layoutId) throw new Error('[LayoutService] resumeRoute called before start()');

    // #25 D8's resume precondition, checked here — never inside
    // `ReservationService`, which has no `SystemHealth` access and must not
    // gain any (docs/route-locking.md's existing boundary) — and BEFORE
    // `reservations.resume` is ever called: refuse if any point this route
    // holds carries a latched, unacknowledged `PointFault`.
    //
    // This is checked against the FAULT, deliberately never against
    // `confirmation === 'pending'`. Checking `pending` would deadlock:
    // resuming re-commands every held point below, which itself sets each
    // one back to `pending` as an unavoidable side effect of the resume — a
    // `pending` check would then refuse the very resume that was about to
    // clear it. Do not "simplify" this into a `pending` check.
    const reservation = this.reservations.getRoute(this.layoutId, routeId);
    if (reservation) {
      const faultedPointIds = reservation.holds
        .filter((h) => h.kind === 'point' && !h.released)
        .map((h) => h.targetId)
        .filter((pointId) => this.health.pointFaults[pointId] !== undefined);

      if (faultedPointIds.length > 0) {
        const reason = `resume refused — ${pluralise(faultedPointIds.length, 'point')} still faulted: ${faultedPointIds
          .map((pointId) => pointLabel(pointId, this.names.get()))
          .join(', ')}`;
        this.log.warn('[LayoutService] Resume refused — point fault latched', {
          layoutId: this.layoutId,
          routeId,
          pointIds: faultedPointIds,
        });
        return { resumed: false, reason };
      }
    }

    const result = await this.reservations.resume(this.layoutId, routeId);
    if (!result.resumed) {
      this.log.warn('[LayoutService] Resume refused', { routeId, reason: result.reason });
      return result;
    }

    // The commands are issued *before* this resume is treated as successful
    // — before the ROUTE_STATE event, and before the D9 restart latch is
    // cleared. A route must never sit `active` while a point it holds is
    // known not to have accepted its command, and a restart Safe-Stop must
    // never be cleared by a resume that then failed.
    const failures = (await this.commandPointHolds(result.pointsToRecommand)).map((f) => f.message);

    if (failures.length > 0) {
      const reason = `resume refused — ${pluralise(failures.length, 'point command')} failed: ${failures.join('; ')}`;
      this.log.error('[LayoutService] Resume rolled back — point re-command failed', {
        layoutId: this.layoutId,
        routeId,
        failures,
      });
      const outcome = await this.reservations.suspendOne(this.layoutId, routeId, reason);
      if (outcome?.reservation) {
        this.emit('event', { type: 'ROUTE_STATE', payload: outcome.reservation } satisfies LayoutEvent);
      }
      // The D9 latch is deliberately left intact: this route is not resolved,
      // so `recoveredRouteCount` must not drop and Safe-Stop must not clear.
      return { resumed: false, reason };
    }

    this.emit('event', { type: 'ROUTE_STATE', payload: result.reservation } satisfies LayoutEvent);
    if (this.recoveredRouteIds.delete(routeId)) {
      this.health = { ...this.health, recoveredRouteCount: this.recoveredRouteIds.size };
      await this.evaluateAndApplySafeStop();
    }

    this.log.info('[LayoutService] Route resumed', { routeId });
    return result;
  }

  listRoutes(statuses?: RouteStatus[]): RouteReservation[] {
    if (!this.layoutId) return [];
    return this.reservations.listRoutes(this.layoutId, statuses);
  }

  // ─── State Access ─────────────────────────────────────────────────────────────

  getSystemStatus(): { status: string; mode: SystemMode; reason: string | null } {
    const s = this.stateManager.getState();
    return { status: s.systemStatus, mode: s.systemMode, reason: s.safeStopReason };
  }

  getAllState() {
    return this.stateManager.getState();
  }

  getTrackGraph(): TrackGraph | null {
    return this.graph;
  }

  /** The layout id this service was `start()`-ed with, or `null` before that. Used by the sensor-faults route to refuse a `:layoutId` that is not the running layout. */
  getLayoutId(): LayoutId | null {
    return this.layoutId;
  }

  /** The current `NameBook` (#54), for the transport layer to render an HTTP-body-only string (D9) — `EMPTY_NAME_BOOK` before the first refresh or with no `INameBook` injected. */
  getNames(): NameBook {
    return this.names.get();
  }

  /**
   * Reloads and re-validates the track topology for the running layout,
   * applying Safe-Stop if it is invalid. Called on startup (after blocks and
   * points are registered) and again after any edge mutation via
   * `TopologyService`'s `onTopologyChanged` callback.
   *
   * Never throws for a topology data problem — `loadTopology` already turns
   * a fatal violation set or an invalid `block_edges` row into a result
   * object rather than an exception. A non-topology error (e.g. the
   * repository itself failing) is not caught here and propagates to the
   * caller, per the narrow-catch rule in `loadTopology`.
   */
  async reloadTopology(): Promise<TopologyLoadResult> {
    if (!this.layoutId) {
      throw new Error('[LayoutService] reloadTopology called before start()');
    }
    const layoutId = this.layoutId;

    // Refresh the name book BEFORE loading topology, so a fatal-violation
    // Safe-Stop reason is already named (D5). D10 guards the corrupt-row
    // case this ordering creates: `NameBookCache.refresh` narrowly catches
    // `BlockEdgeRowInvalidError` itself, so it can never be the thing that
    // escapes `loadTopology`'s own narrow catch below and regresses #10.
    await this.names.refresh(layoutId);

    const result = await loadTopology(this.repo, layoutId, this.names.get());

    this.graph = result.graph;
    this.health = { ...this.health, topologyValid: !result.fatal, topologyReason: result.reason };

    if (result.fatal) {
      this.log.error('[LayoutService] Topology invalid', {
        layoutId,
        violations: result.violations,
      });
    }

    await this.evaluateAndApplySafeStop();
    await this.demoteAutoModeIfGraphIncomplete(layoutId);

    return result;
  }

  /**
   * Drops an automated mode to `manual` when the graph the layout is now
   * running on has gaps (#103, D-C).
   *
   * The gate in `handleSetMode` covers entering an automated mode; this covers
   * the graph changing *underneath* one. Applying a compile that leaves holes,
   * or deleting a block, can turn a complete graph into an incomplete one while
   * the layout is already in `auto`, and an authority granted against a
   * complete graph should not survive the graph becoming incomplete.
   *
   * **Not a Safe-Stop, and not a fault latch.** Nothing has gone wrong with the
   * railway and no train's position is in doubt; the system simply no longer
   * has the information to drive one automatically. Removing the authority is
   * proportionate. Halting the layout because an operator erased a siding is
   * not, and D9 forbids a compile from being able to cause one.
   *
   * Runs after `evaluateAndApplySafeStop` so a genuine Safe-Stop is applied
   * first and this cannot mask it.
   */
  private async demoteAutoModeIfGraphIncomplete(layoutId: LayoutId): Promise<void> {
    const mode = this.stateManager.getState().systemMode;
    if (mode !== 'auto' && mode !== 'hybrid') return;

    const gaps = await this.completeness.gapCount(layoutId);
    if (gaps === 0) return;

    this.stateManager.setMode('manual');

    // The same D7 consequence a manual mode change has: an auto-authority route
    // is suspended, not cancelled, so its locks stay held and the operator
    // decides what happens to the train.
    const outcomes = await this.reservations.suspendAuto(
      layoutId,
      'compiled track graph has gaps',
    );
    for (const outcome of outcomes) {
      this.publishReservationOutcome(outcome);
    }

    this.log.warn('[LayoutService] Mode dropped to manual — compiled graph has gaps', {
      layoutId,
      layoutName: this.names.get().layouts.get(layoutId),
      previousMode: mode,
      gapCount: gaps,
    });

    this.publishSystemStatus();
  }

  // ─── Private: Initialisation ──────────────────────────────────────────────────

  private async initializeLayoutState(layoutId: LayoutId): Promise<void> {
    const [dbBlocks, dbPoints] = await Promise.all([
      this.repo.listBlocks(layoutId),
      this.repo.listPoints(layoutId),
    ]);

    for (const block of dbBlocks) {
      this.stateManager.registerBlock(block.id);
    }
    // #25 D2: every point starts 'unreported'/'unknown' this session,
    // regardless of what it was doing before a restart — and publishing its
    // state here overwrites any stale old-shape retained `point/*/state`
    // message the pre-#25 backend left on the broker.
    for (const point of dbPoints) {
      const registered = this.stateManager.registerPoint(point.id, point.positionFeedback, this.clock.now());
      this.publishPointState(registered);
    }

    this.log.info('[LayoutService] Layout state initialised', {
      blocks: dbBlocks.length,
      points: dbPoints.length,
    });

    // D9: revive any reservation that survived a restart BEFORE
    // reloadTopology (which calls evaluateAndApplySafeStop) — for the same
    // reason start() goes online before this method runs (see the comment
    // there): a recovered route must land on 'safe-stop', not be skipped.
    const { recovered } = await this.reservations.loadOnStartup(layoutId);
    this.recoveredRouteIds = new Set(recovered.map((r) => r.id));
    this.health = { ...this.health, recoveredRouteCount: this.recoveredRouteIds.size };
    for (const reservation of recovered) {
      this.emit('event', { type: 'ROUTE_STATE', payload: reservation } satisfies LayoutEvent);
    }
    if (recovered.length > 0) {
      this.log.warn('[LayoutService] Route reservation(s) survived a restart', {
        layoutId,
        count: recovered.length,
      });
    }

    await this.reloadTopology();
  }

  private async subscribeSensors(layoutId: LayoutId): Promise<void> {
    const dbSensors = await this.repo.listSensors(layoutId);

    for (const sensor of dbSensors) {
      this.stateManager.registerSensor({
        sensorId: sensor.id,
        blockId: sensor.blockId,
        type: sensor.type,
        inService: sensor.inService,
      });
      // DD4/Q1 (docs/sensor-fault-recovery.md): an out-of-service sensor is
      // never subscribed at all — this is the PRIMARY mechanism that makes
      // out-of-service an escape hatch from a bad device. The registry
      // check inside handleSensorReading below is defence in depth, for a
      // handler that somehow still fires (e.g. a stale subscription).
      if (!sensor.inService) continue;
      await this.mqtt.subscribe(sensor.mqttTopic, (payload, topic, retained) => {
        void this.handleSensorReading(sensor.id, topic, payload, retained);
      });
    }

    this.log.info('[LayoutService] Sensor subscriptions registered', {
      count: dbSensors.filter((s) => s.inService).length,
      total: dbSensors.length,
    });
  }

  // ─── Private: Sensor Ingestion ────────────────────────────────────────────────

  /**
   * A malformed sensor payload is a Fail-Safe Trigger (mqtt-contract.md
   * §Fail-Safe Triggers item 3 / CLAUDE.md safety rule 3), not a logged
   * warning. Trips (or re-latches — DD5) a per-sensor fault via
   * `tripSensorFault`, which is what enters Safe-Stop.
   *
   * The order below is load-bearing (see docs/sensor-fault-recovery.md D1/Q1):
   *  1. Registry lookup. A subscription firing for a sensor the state
   *     manager has never registered is a bug, not a layout hazard —
   *     dropped defensively, no fault.
   *  2. In-service check, BEFORE the Zod parse. An out-of-service sensor's
   *     payload — malformed or not — never trips a fault: D1 says
   *     out-of-service means the system stops trusting the sensor
   *     entirely, and a sensor that can still trip the latch is still
   *     trusted, which would make the escape hatch unusable. This is
   *     defence in depth; `subscribeSensors` not subscribing at all is the
   *     primary mechanism (DD4).
   *  2b. Empty-payload check, BEFORE the Zod parse (#65 D7, D9 in
   *     docs/sensor-fault-recovery.md). A genuinely zero-byte payload is an
   *     MQTT retained-clear, not a malformed reading — the sensor simulation
   *     panel's "clear retained" action publishes one to tidy up after a
   *     bench test, and treating it as malformed would Safe-Stop the layout
   *     every time an operator did that. Logged `info` and dropped: no
   *     fault, no counter change, no `recomputeBlock`. A *retained* empty
   *     payload cannot arrive here — a real broker never stores one, and
   *     `SimulatedMqttAdapter.clearRetained` deletes rather than stores —
   *     so there is deliberately no `retained` branch on this check.
   *  3. Zod parse. Failure trips/re-latches the fault (`tripSensorFault`)
   *     and returns — block state is never touched by the parse failure
   *     itself; the de-contribution that DOES happen is inside
   *     `tripSensorFault` (D4), a deliberate, separate effect.
   *  4. Fault-counter branch. A VALID reading arriving while the sensor is
   *     ALREADY faulted counts toward D1's arming threshold (unless
   *     retained — D1/D8) but never updates occupancy: a faulted sensor
   *     contributes nothing (D3/DD6).
   *  5. Occupancy path. Otherwise, record the reading and recompute the
   *     block's derived occupancy.
   */
  private async handleSensorReading(
    sensorId: string,
    topic: string,
    rawPayload: unknown,
    retained: boolean,
  ): Promise<void> {
    const obs = this.stateManager.getSensorObservation(sensorId);
    if (!obs) {
      this.log.warn('[LayoutService] Sensor reading for an unregistered sensor — dropping', {
        layoutId: this.layoutId,
        sensorId,
        sensorName: this.names.get().sensors.get(sensorId),
        topic,
      });
      return;
    }

    if (!obs.inService) {
      this.log.warn(
        '[LayoutService] Sensor reading from an out-of-service sensor — dropping before validation',
        { layoutId: this.layoutId, sensorId, sensorName: this.names.get().sensors.get(sensorId), topic },
      );
      return;
    }

    if (isEmptySensorPayload(rawPayload)) {
      // #65 D7 / docs/sensor-fault-recovery.md D9: a zero-byte payload is a
      // retained-clear, not a malformed reading — it asserts nothing about
      // occupancy, so derived state stays exactly where the last real
      // reading left it.
      this.log.info('[LayoutService] Empty (retained-clear) sensor payload — ignored, not a fault', {
        layoutId: this.layoutId,
        sensorId,
        sensorName: this.names.get().sensors.get(sensorId),
        blockId: obs.blockId,
        blockName: obs.blockId ? this.names.get().blocks.get(obs.blockId) : undefined,
        topic,
      });
      return;
    }

    const result = sensorReadingSchema.safeParse(rawPayload);
    if (!result.success) {
      await this.tripSensorFault(sensorId, topic, result.error.message);
      return;
    }

    const fault = this.health.sensorFaults[sensorId];
    if (fault) {
      if (retained) {
        // D1/D8: a retained replay is not evidence the sensor is healthy
        // NOW — it may be the very last (possibly stale) reading from
        // before it started publishing garbage.
        this.log.info('[LayoutService] Valid RETAINED reading while faulted — does not count toward arming', {
          layoutId: this.layoutId,
          sensorId,
          sensorName: this.names.get().sensors.get(sensorId),
        });
        return;
      }
      const updatedFault: SensorFault = {
        ...fault,
        consecutiveValidReadings: fault.consecutiveValidReadings + 1,
      };
      this.health = {
        ...this.health,
        sensorFaults: { ...this.health.sensorFaults, [sensorId]: updatedFault },
      };
      this.log.info('[LayoutService] Valid reading while faulted — counted toward recovery arming', {
        layoutId: this.layoutId,
        sensorId,
        sensorName: this.names.get().sensors.get(sensorId),
        consecutiveValidReadings: updatedFault.consecutiveValidReadings,
        requiredValidReadings: this.options.clearAfterValidReadings,
      });
      this.emitSensorFaults();
      return;
    }

    this.stateManager.recordSensorReading(sensorId, result.data.state, new Date());
    await this.recomputeBlock(obs.blockId);
  }

  /**
   * D2 + D4: latches (or re-latches) the fault, de-contributes the sensor
   * from its block's derived occupancy, and recomputes that block. Reason
   * text mirrors #27's original wording (naming the sensor and topic). A
   * re-fault (DD5) keeps the ORIGINAL `faultedAt`/`reason` — the first
   * cause — and resets `consecutiveValidReadings` to 0.
   */
  private async tripSensorFault(sensorId: SensorId, topic: string, parseErrorMessage: string): Promise<void> {
    const obs = this.stateManager.getSensorObservation(sensorId);
    const existing = this.health.sensorFaults[sensorId];
    // sensorLabel already quotes the name when one is known (or renders the
    // bare id verbatim when not) — the inner quotes #27's original wording
    // carried around a bare sensor id are redundant now and dropped.
    const reason = `Malformed sensor payload from sensor ${sensorLabel(sensorId, this.names.get())} on topic "${topic}": ${parseErrorMessage}`;

    const fault: SensorFault = existing
      ? { ...existing, consecutiveValidReadings: 0 }
      : { sensorId, reason, topic, faultedAt: new Date(), consecutiveValidReadings: 0 };

    this.log.error('[LayoutService] Invalid sensor payload — entering Safe-Stop', {
      layoutId: this.layoutId,
      sensorId,
      sensorName: this.names.get().sensors.get(sensorId),
      blockId: obs?.blockId ?? null,
      blockName: obs?.blockId ? this.names.get().blocks.get(obs.blockId) : undefined,
      topic,
      error: parseErrorMessage,
    });

    this.health = { ...this.health, sensorFaults: { ...this.health.sensorFaults, [sensorId]: fault } };
    this.stateManager.setSensorFaulted(sensorId, true);
    this.stateManager.clearSensorReading(sensorId);

    await this.recomputeBlock(obs?.blockId ?? null);
    await this.evaluateAndApplySafeStop();
    this.emitSensorFaults();
  }

  /**
   * Recomputes a block's derived occupancy (D3, `domain/occupancy.ts`) and
   * publishes/emits BLOCK_STATE only when it actually changed (DD2) — an IR
   * `clear` now legitimately changes nothing, and a retained-replay storm
   * must not spam the bus.
   *
   * Also the ONLY place `reservations.onOccupancyChange` is called (see
   * docs/route-locking.md D5 and the cross-reference in
   * docs/sensor-fault-recovery.md D6): it is fed the DERIVED occupancy, not
   * any single sensor's raw reading. That is what stops an `ir_position`
   * sensor's `clear` from ever reaching the reservation engine as the
   * block's occupancy — D3 already discards it before this point — so it
   * can never fire progressive release under a train.
   *
   * A transition to `unknown` is passed through faithfully, not filtered,
   * and since #4 it is no longer inert: `evaluateOccupancyChange` reports it
   * as `occupancy-unknown` when the block belongs to a live route, which
   * Safe-Stops. It was previously ignored on the grounds that a sensor fault
   * would Safe-Stop on its own account — true for that cause, but not for a
   * sensor taken out of service or deleted mid-route, which raises no fault.
   */
  private async recomputeBlock(blockId: BlockId | null): Promise<void> {
    if (!blockId) return;

    const derived = deriveBlockOccupancy(this.stateManager.listSensorObservationsForBlock(blockId));
    const previous = this.stateManager.getBlock(blockId);
    const previousOccupancy = previous?.occupancy ?? 'unknown';
    // D4: occupancy no longer determinable -> loco identity is nulled, not
    // carried forward as a going belief.
    const locoAddress = derived === 'unknown' ? null : previous?.locoAddress ?? null;

    if (previous && previous.occupancy === derived && previous.locoAddress === locoAddress) {
      return;
    }

    const updated = this.stateManager.updateBlockOccupancy(blockId, derived, locoAddress);
    this.publishBlockState(updated);
    this.emit('event', { type: 'BLOCK_STATE', payload: updated } satisfies LayoutEvent);

    if (isBlockEffectivelyOccupied(updated.occupancy)) {
      this.log.info('[LayoutService] Block occupied', { blockId, blockName: this.names.get().blocks.get(blockId) });
    }

    // B5, checked BEFORE `onOccupancyChange` below: a train reaching its
    // route's destination block is both a normal arrival and — under a
    // braked run whose target was that block's entry boundary — an overrun,
    // and the reservation engine cannot tell the two apart (D5,
    // docs/route-locking.md). Completing the route clears the expectation
    // through `publishReservationOutcome`, so asking first is what makes the
    // fault reachable at all.
    await this.checkBrakingOverrun(blockId, derived);

    if (this.layoutId) {
      const outcome = await this.reservations.onOccupancyChange(
        this.layoutId,
        blockId,
        derived,
        previousOccupancy,
      );
      this.publishReservationOutcome(outcome);
      // D7: occupancy in a reserved block that is not the route's next
      // expected step is a route violation — the route is already
      // cancelled and its locks released by ReservationService; this
      // service still owns stopping the loco and entering Safe-Stop, since
      // ReservationService has no DCC/MQTT access.
      if (outcome.unexpectedOccupancy && outcome.reservation) {
        await this.handleRouteViolation(blockId, outcome.reservation);
      }
      // #4: a block a live route still holds became undeterminable. Unlike
      // the violation above, the route keeps its locks — Safe-Stop suspends
      // it rather than cancelling it (D8).
      if (outcome.occupancyUnknownBlockId && outcome.reservation) {
        await this.handleRouteOccupancyUnknown(outcome.occupancyUnknownBlockId, outcome.reservation);
      }
    }
  }

  private emitSensorFaults(): void {
    this.emit('event', {
      type: 'SENSOR_FAULTS',
      payload: { faults: this.getSensorFaults() },
    } satisfies LayoutEvent);
  }

  // ─── Public: Sensor Fault Recovery (see docs/sensor-fault-recovery.md) ────────

  /** The current fault set, sorted by `faultedAt` ascending so the UI lists the first cause (D2) first. */
  getSensorFaults(): SensorFaultView[] {
    return Object.values(this.health.sensorFaults)
      .map((fault) => toSensorFaultView(fault, this.options.clearAfterValidReadings))
      .sort((a, b) => a.faultedAt.localeCompare(b.faultedAt));
  }

  /**
   * D1/D5: accepted only once the fault has armed (`clearAfterValidReadings`
   * consecutive valid, non-retained readings since the fault). Explicitly
   * does NOT touch routes (D6 / docs/route-locking.md D8) — a block reads
   * `unknown` until a further reading determines it, and any route through
   * it stays refused/suspended until that happens and the operator resumes
   * it separately.
   */
  async acknowledgeSensorFault(
    layoutId: LayoutId,
    sensorId: SensorId,
  ): Promise<{
    sensorId: SensorId;
    cleared: true;
    systemStatus: SystemStatus;
    safeStopReason: string | null;
    faults: SensorFaultView[];
  }> {
    if (this.layoutId !== layoutId) throw new SensorNotFoundError(sensorId, sensorLabel(sensorId, this.names.get()));
    const obs = this.stateManager.getSensorObservation(sensorId);
    if (!obs) throw new SensorNotFoundError(sensorId, sensorLabel(sensorId, this.names.get()));

    const fault = this.health.sensorFaults[sensorId];
    if (!fault) throw new SensorNotFaultedError(sensorId, sensorLabel(sensorId, this.names.get()));

    if (!isSensorFaultArmed(fault, this.options.clearAfterValidReadings)) {
      throw new SensorFaultNotArmedError(
        sensorId,
        fault.consecutiveValidReadings,
        this.options.clearAfterValidReadings,
        sensorLabel(sensorId, this.names.get()),
      );
    }

    const remaining = { ...this.health.sensorFaults };
    delete remaining[sensorId];
    this.health = { ...this.health, sensorFaults: remaining };
    this.stateManager.setSensorFaulted(sensorId, false);

    // Still 'unknown' unless another in-service sensor already determines
    // the block (D6) — lastReading was nulled at trip time (DD6) and this
    // acknowledge does not supply one.
    await this.recomputeBlock(obs.blockId);
    await this.evaluateAndApplySafeStop();
    this.emitSensorFaults();

    const state = this.stateManager.getState();
    this.log.info('[LayoutService] Sensor fault acknowledged', {
      layoutId,
      sensorId,
      sensorName: this.names.get().sensors.get(sensorId),
    });

    return {
      sensorId,
      cleared: true,
      systemStatus: state.systemStatus,
      safeStopReason: state.safeStopReason,
      faults: this.getSensorFaults(),
    };
  }

  // ─── Private: Point Confirmation Ingestion (see docs/point-feedback.md) ───────

  /**
   * One wildcard subscription for every point's reading — unlike sensors
   * there is no per-point in-service gate to honour, so this collapses to a
   * single `point/+/reading` subscribe rather than sensors' per-topic loop.
   * The callback does exactly what the plan requires and nothing else:
   * extract the point id from the topic and delegate.
   */
  private async subscribePointReadings(layoutId: LayoutId): Promise<void> {
    const topic = `${this.topicBase()}/point/+/reading`;
    await this.mqtt.subscribe(topic, (payload, receivedTopic, retained) => {
      const topicPointId = receivedTopic.split('/')[3];
      void this.handlePointReading(topicPointId, payload, retained);
    });
    this.log.info('[LayoutService] Point reading subscription registered', { layoutId, topic });
  }

  /**
   * A `point/{pointId}/reading` landed on the wildcard subscription above.
   * See docs/point-feedback.md D1/D3/D4 and the #25 plan's decision 4.
   *
   * Order, and why — this mirrors `handleSensorReading`'s, step for step:
   *  1. **Registry lookup, BEFORE the Zod parse.** The subscription is a
   *     wildcard, so anything on the broker publishing under `point/+/reading`
   *     reaches here, including a decommissioned controller nobody has
   *     unplugged. Such a device has no bearing on any point this layout
   *     tracks, and Safe-Stopping the railway over its garbage is the
   *     nuisance trip that teaches operators to ignore Safe-Stops (#25 plan
   *     decision 4, the same argument DD4 makes for an unregistered sensor).
   *     Warn and drop, latching nothing. Getting this order wrong is not
   *     theoretical: with the parse first, one stray retained message from a
   *     dead device halts the layout at every backend start.
   *  2. **Zod parse.** For a point this layout DOES have, a malformed payload
   *     is a Fail-Safe Trigger (mqtt-contract.md item 3) independent of
   *     retention — so a garbage payload cannot be waved through by also
   *     setting `retain`.
   *  3. `PointConfirmationService.applyReading` decides the rest: id-mismatch
   *     (a Fail-Safe Trigger, latched against the TOPIC point id, with the
   *     payload-named point's own state left untouched), or retained (D1 —
   *     drop, arms nothing, faults nothing on its own).
   */
  private async handlePointReading(topicPointId: PointId, rawPayload: unknown, retained: boolean): Promise<void> {
    if (!this.stateManager.getPoint(topicPointId)) {
      this.log.warn('[LayoutService] Point reading for a point not in this layout — dropping', {
        layoutId: this.layoutId,
        pointId: topicPointId,
      });
      return;
    }

    const parsed = pointReadingSchema.safeParse(rawPayload);
    if (!parsed.success) {
      await this.raisePointFault(
        topicPointId,
        'malformed-payload',
        `Malformed point reading payload on point ${pointLabel(topicPointId, this.names.get())}: ${parsed.error.message}`,
      );
      return;
    }

    const reading: PointReading = {
      pointId: parsed.data.pointId,
      position: parsed.data.position,
      source: parsed.data.source,
      reportedAt: parsed.data.updatedAt ? new Date(parsed.data.updatedAt) : null,
    };

    const outcome = this.pointConfirmations.applyReading(topicPointId, reading, this.clock.now(), retained);

    if (outcome.rejection?.kind === 'unknown-point') {
      // Defence in depth: step 1 above already dropped this case, and the
      // service refuses it independently so nothing that calls `applyReading`
      // by another route can write state for a point that does not exist.
      this.log.warn('[LayoutService] Point reading for an unregistered point — dropping', {
        layoutId: this.layoutId,
        pointId: topicPointId,
      });
      return;
    }

    if (outcome.rejection?.kind === 'id-mismatch') {
      await this.raisePointFault(
        topicPointId,
        'id-mismatch',
        `Point reading id mismatch: topic named ${pointLabel(topicPointId, this.names.get())} but payload named ${pointLabel(outcome.rejection.payloadPointId, this.names.get())}`,
      );
      return;
    }

    if (!outcome.point) {
      // D1: retained — confirms nothing, arms nothing, faults nothing on its own.
      this.log.warn('[LayoutService] Retained point reading — dropping, confirms nothing', {
        layoutId: this.layoutId,
        pointId: topicPointId,
        pointName: this.names.get().points.get(topicPointId),
      });
      return;
    }

    this.publishPointState(outcome.point);
    this.emit('event', { type: 'POINT_STATE', payload: outcome.point } satisfies LayoutEvent);

    if (outcome.point.confirmation === 'mismatch' || outcome.point.confirmation === 'indeterminate') {
      await this.handlePointNotConfirmed(
        topicPointId,
        outcome.point.confirmation,
        `Point ${pointLabel(topicPointId, this.names.get())} failed to confirm: ${outcome.point.confirmation}`,
      );
      return;
    }

    // D4: while already faulted, a reading that does not itself re-fault the
    // point still counts toward (or resets) the arming counter — the same
    // "valid reading while faulted" bookkeeping `handleSensorReading` does,
    // gated on `confirmationArms` (`outcome.arms`) rather than re-checking
    // the reading's shape here.
    const fault = this.health.pointFaults[topicPointId];
    if (fault) {
      const updatedFault: PointFault = {
        ...fault,
        consecutiveConfirmations: outcome.arms ? fault.consecutiveConfirmations + 1 : 0,
      };
      this.health = { ...this.health, pointFaults: { ...this.health.pointFaults, [topicPointId]: updatedFault } };
      this.log.info('[LayoutService] Reading applied while point faulted', {
        layoutId: this.layoutId,
        pointId: topicPointId,
        pointName: this.names.get().points.get(topicPointId),
        arms: outcome.arms,
        consecutiveConfirmations: updatedFault.consecutiveConfirmations,
        requiredConfirmations: this.options.pointFaultClearAfterConfirmations,
      });
      this.emitPointFaults();
    }
  }

  /**
   * Latches (or re-latches, keeping the FIRST cause — D4) a `PointFault` and
   * re-evaluates Safe-Stop. The only path a point-confirmation problem
   * enters Safe-Stop through — never `stateManager.enterSafeStop` directly
   * (CLAUDE.md Traps). Mirrors `raiseRouteFault`/`tripSensorFault`.
   */
  private async raisePointFault(pointId: PointId, kind: PointFault['kind'], reason: string): Promise<void> {
    const existing = this.health.pointFaults[pointId];
    const fault: PointFault = existing
      ? { ...existing, consecutiveConfirmations: 0 }
      : { pointId, kind, reason, faultedAt: this.clock.now(), consecutiveConfirmations: 0 };

    this.log.error('[LayoutService] Point fault latched — entering Safe-Stop', {
      layoutId: this.layoutId,
      pointId,
      pointName: this.names.get().points.get(pointId),
      kind,
      reason,
    });

    this.health = { ...this.health, pointFaults: { ...this.health.pointFaults, [pointId]: fault } };
    await this.evaluateAndApplySafeStop();
    this.emitPointFaults();
  }

  /** D5: applies `evaluateTimeout` to every registered point via the sweep, publishing and fault-latching each transition. */
  private async runConfirmationSweep(): Promise<void> {
    const transitioned = this.pointConfirmations.sweep(this.clock.now());
    for (const point of transitioned) {
      this.publishPointState(point);
      this.emit('event', { type: 'POINT_STATE', payload: point } satisfies LayoutEvent);
      if (point.confirmation === 'timed-out') {
        await this.handlePointNotConfirmed(
          point.pointId,
          'timeout',
          `Point ${pointLabel(point.pointId, this.names.get())} failed to confirm within the timeout — no reading received`,
        );
      }
    }
  }

  /** D5: started next to the heartbeat, stopped in `stop()`. Runs on `this.clock`, never a bare `setInterval` — the seam `ManualClock` drives in tests. */
  private startConfirmationSweep(): void {
    this.confirmationSweepTimer = this.clock.setInterval(() => {
      void this.runConfirmationSweep();
    }, this.options.pointSweepIntervalMs);
  }

  private stopConfirmationSweep(): void {
    this.confirmationSweepTimer?.cancel();
    this.confirmationSweepTimer = null;
  }

  private emitPointFaults(): void {
    this.emit('event', {
      type: 'POINT_FAULTS',
      payload: { faults: this.getPointFaults() },
    } satisfies LayoutEvent);
  }

  // ─── Public: Point Confirmation (see docs/point-feedback.md) ──────────────────

  /**
   * Publishes `point/{id}/query` `{ requestedAt }` at `{ qos: 1, retain:
   * false }` for every 'required' point (D2) — at the end of `start()` and
   * on every MQTT reconnect. `noteQueried` first, so a query never arms a
   * confirmation deadline (D6) even though it touches `lastUpdated`.
   */
  async queryPointPositions(): Promise<void> {
    if (!this.layoutId) return;
    const pointIds = this.pointConfirmations.pointsRequiringFeedback();
    const requestedAt = this.clock.now();

    for (const pointId of pointIds) {
      this.pointConfirmations.noteQueried(pointId, requestedAt);
      await this.mqtt
        .publish(
          `${this.topicBase()}/point/${pointId}/query`,
          { requestedAt: requestedAt.toISOString() },
          { qos: 1, retain: false },
        )
        .catch((err: Error) =>
          this.log.error('[LayoutService] Failed to publish point query', {
            layoutId: this.layoutId,
            pointId,
            pointName: this.names.get().points.get(pointId),
            error: err.message,
          }),
        );
    }

    if (pointIds.length > 0) {
      this.log.info('[LayoutService] Point positions queried', { layoutId: this.layoutId, count: pointIds.length });
    }
  }

  /** The current latched point faults, oldest first — the first cause leads, matching `getSensorFaults`. */
  getPointFaults(): PointFaultView[] {
    return Object.values(this.health.pointFaults)
      .map((fault) => toPointFaultView(fault, this.options.pointFaultClearAfterConfirmations))
      .sort((a, b) => a.faultedAt.localeCompare(b.faultedAt));
  }

  /**
   * D4: accepted only once the fault has armed
   * (`pointFaultClearAfterConfirmations` consecutive confirming, non-retained
   * readings since the fault). Mirrors `acknowledgeSensorFault` exactly.
   * Deliberately does NOT touch the point's own `confirmation`/
   * `confirmedPosition` — those stay whatever the last reading (or timeout)
   * left them; only the latch clears.
   */
  async acknowledgePointFault(
    layoutId: LayoutId,
    pointId: PointId,
  ): Promise<{
    pointId: PointId;
    cleared: true;
    systemStatus: SystemStatus;
    safeStopReason: string | null;
    faults: PointFaultView[];
  }> {
    if (this.layoutId !== layoutId) throw new PointNotFoundError(pointId, pointLabel(pointId, this.names.get()));
    const point = this.stateManager.getPoint(pointId);
    if (!point) throw new PointNotFoundError(pointId, pointLabel(pointId, this.names.get()));

    const fault = this.health.pointFaults[pointId];
    if (!fault) throw new PointNotFaultedError(pointId, pointLabel(pointId, this.names.get()));

    if (!isPointFaultArmed(fault, this.options.pointFaultClearAfterConfirmations)) {
      throw new PointFaultNotArmedError(
        pointId,
        fault.consecutiveConfirmations,
        this.options.pointFaultClearAfterConfirmations,
        pointLabel(pointId, this.names.get()),
      );
    }

    const remaining = { ...this.health.pointFaults };
    delete remaining[pointId];
    this.health = { ...this.health, pointFaults: remaining };

    await this.evaluateAndApplySafeStop();
    this.emitPointFaults();

    const state = this.stateManager.getState();
    this.log.info('[LayoutService] Point fault acknowledged', {
      layoutId,
      pointId,
      pointName: this.names.get().points.get(pointId),
    });

    return {
      pointId,
      cleared: true,
      systemStatus: state.systemStatus,
      safeStopReason: state.safeStopReason,
      faults: this.getPointFaults(),
    };
  }

  /** `effectivePosition` (D7) over every registered point — what a road-confirmation check or the UI wants, never `commandedPosition` directly. */
  getPointPositions(): ReadonlyMap<PointId, PointPosition> {
    return buildPointPositionMap(this.stateManager.getState().points);
  }

  /**
   * Config write path (DD12) — the route parses and delegates here, no
   * decisions in the transport layer (safety rule 2).
   */
  async createSensorConfig(layoutId: LayoutId, input: SensorCreateInput): Promise<SensorRecord> {
    const created = await this.repo.createSensor({
      layoutId,
      name: input.name,
      type: input.type,
      blockId: input.blockId,
      mqttTopic: input.mqttTopic,
      inService: input.inService,
    });

    this.stateManager.registerSensor({
      sensorId: created.id,
      blockId: created.blockId,
      type: created.type,
      inService: created.inService,
    });

    if (created.inService) {
      await this.mqtt.subscribe(created.mqttTopic, (payload, topic, retained) =>
        void this.handleSensorReading(created.id, topic, payload, retained),
      );
    }

    // D5: refresh before recomputeBlock/evaluateAndApplySafeStop, so any
    // reason generated downstream in this same call already carries the new
    // name.
    await this.names.refresh(layoutId);
    await this.recomputeBlock(created.blockId);
    this.log.info('[LayoutService] Sensor config created', {
      layoutId,
      sensorId: created.id,
      sensorName: created.name,
    });
    return created;
  }

  /**
   * Re-syncs runtime state (subscription, registry, fault) to match the
   * persisted change, in the order documented inline below — see
   * docs/sensor-fault-recovery.md D1/D5.
   */
  async updateSensorConfig(
    layoutId: LayoutId,
    sensorId: SensorId,
    patch: SensorUpdateInput,
  ): Promise<SensorRecord> {
    const existingSensors = await this.repo.listSensors(layoutId);
    const existing = existingSensors.find((s) => s.id === sensorId);
    if (!existing) throw new SensorNotFoundError(sensorId, sensorLabel(sensorId, this.names.get()));

    const updated = await this.repo.updateSensor(sensorId, patch);
    const handler = (payload: unknown, topic: string, retained: boolean) =>
      void this.handleSensorReading(sensorId, topic, payload, retained);

    // mqttTopic changed: resubscribe under the new topic (if still in
    // service once the inService transition below is also applied).
    if (patch.mqttTopic !== undefined && patch.mqttTopic !== existing.mqttTopic) {
      await this.mqtt.unsubscribe(existing.mqttTopic);
      if (existing.inService && updated.inService) {
        await this.mqtt.subscribe(updated.mqttTopic, handler);
      }
    }

    if (existing.inService && !updated.inService) {
      // D1/DD4: out-of-service stops trusting this sensor entirely — clear
      // its fault, its reading, and unsubscribe so no later payload
      // (malformed or not) can ever reach handleSensorReading for it again.
      await this.mqtt.unsubscribe(updated.mqttTopic);
      this.stateManager.clearSensorReading(sensorId);
      if (this.health.sensorFaults[sensorId]) {
        const remaining = { ...this.health.sensorFaults };
        delete remaining[sensorId];
        this.health = { ...this.health, sensorFaults: remaining };
      }
      this.stateManager.setSensorFaulted(sensorId, false);
    } else if (!existing.inService && updated.inService) {
      // D5: returning to service starts with no fault and no reading — a
      // de-serviced sensor already had both cleared, and nothing above this
      // branch can have set either since.
      await this.mqtt.subscribe(updated.mqttTopic, handler);
    }

    this.stateManager.registerSensor({
      sensorId: updated.id,
      blockId: updated.blockId,
      type: updated.type,
      inService: updated.inService,
    });

    // D5: refresh before recomputeBlock/evaluateAndApplySafeStop, so any
    // reason generated downstream in this same call already carries the new
    // name.
    await this.names.refresh(layoutId);
    await this.recomputeBlock(existing.blockId);
    if (updated.blockId !== existing.blockId) {
      await this.recomputeBlock(updated.blockId);
    }
    await this.evaluateAndApplySafeStop();
    this.emitSensorFaults();

    this.log.info('[LayoutService] Sensor config updated', {
      layoutId,
      sensorId,
      sensorName: updated.name,
    });
    return updated;
  }

  /** Q2 (docs/sensor-fault-recovery.md): a sensor delete clears its fault — a latch on a sensor that no longer exists could otherwise never be acknowledged. */
  async deleteSensorConfig(layoutId: LayoutId, sensorId: SensorId): Promise<void> {
    const existingSensors = await this.repo.listSensors(layoutId);
    const existing = existingSensors.find((s) => s.id === sensorId);
    if (!existing) throw new SensorNotFoundError(sensorId, sensorLabel(sensorId, this.names.get()));

    if (existing.inService) {
      await this.mqtt.unsubscribe(existing.mqttTopic);
    }
    await this.repo.deleteSensor(sensorId);
    this.stateManager.unregisterSensor(sensorId);

    if (this.health.sensorFaults[sensorId]) {
      const remaining = { ...this.health.sensorFaults };
      delete remaining[sensorId];
      this.health = { ...this.health, sensorFaults: remaining };
    }

    // D5: refresh before recomputeBlock/evaluateAndApplySafeStop — this
    // sensor's name should no longer appear once its config write commits.
    await this.names.refresh(layoutId);
    await this.recomputeBlock(existing.blockId);
    await this.evaluateAndApplySafeStop();
    this.emitSensorFaults();

    this.log.info('[LayoutService] Sensor config deleted', {
      layoutId,
      sensorId,
      sensorName: existing.name,
    });
  }

  /** D7: a manual train has entered reserved track the system did not expect it in — stop that loco and enter Safe-Stop. Scoped to reserved track; unreserved track is #7. */
  /**
   * D7's route violation. The route is already cancelled and its locks
   * released by `ReservationService` before this runs; what is left is the
   * hardware and system-state half it has no access to.
   *
   * The Safe-Stop is raised through `raiseRouteFault` — i.e. through
   * `SystemHealth` — rather than by calling `stateManager.enterSafeStop`
   * directly the way this used to. The direct call left no latch, so the
   * next unrelated health evaluation cleared it (#4).
   */
  private async handleRouteViolation(blockId: BlockId, reservation: RouteReservation): Promise<void> {
    await this.stopLoco(reservation.locoAddress);
    await this.raiseRouteFault({
      routeId: reservation.id,
      kind: 'unexpected-occupancy',
      reason: `Route ${reservation.id} violated: unexpected occupancy in block ${blockLabel(blockId, this.names.get())}`,
      blockId,
      pointId: null,
      locoAddress: reservation.locoAddress,
    });
  }

  /**
   * A block a live route still holds stopped being determinable (#4). The
   * route was granted on the assertion that every block ahead was positively
   * clear, and that assertion no longer holds.
   *
   * The route is NOT cancelled: Safe-Stop holds locks rather than releasing
   * them (D8), and `evaluateAndApplySafeStop` suspends it as part of
   * entering Safe-Stop. The loco is stopped, because a train moving into
   * track whose state is unknown is the failure this exists to prevent.
   *
   * This can double up with a sensor fault, when a malformed payload is what
   * made the block undeterminable — the operator then acknowledges both.
   * That is deliberate: they are different facts ("this detector is faulty"
   * versus "route R's road is no longer known to be clear") and clearing one
   * does not resolve the other. The case this catches that nothing else does
   * is a sensor being taken out of service or deleted while a route is
   * running over it, which raises no sensor fault at all.
   */
  private async handleRouteOccupancyUnknown(
    blockId: BlockId,
    reservation: RouteReservation,
  ): Promise<void> {
    await this.stopLoco(reservation.locoAddress);
    await this.raiseRouteFault({
      routeId: reservation.id,
      kind: 'occupancy-unknown',
      reason: `Route ${reservation.id} suspended: block ${blockLabel(blockId, this.names.get())} occupancy became unknown`,
      blockId,
      pointId: null,
      locoAddress: reservation.locoAddress,
    });
  }

  /**
   * D8 (docs/point-feedback.md): the consequence of a point transitioning to
   * `timeout`, `mismatch`, or `indeterminate` while a route holds it — the
   * point-fault sibling of `handleRouteOccupancyUnknown`. Never called for
   * `malformed-payload`/`id-mismatch` (the caller narrows `kind` to the three
   * D8 names): those leave the point's own confirmation untouched, so the
   * road may still be genuinely set and there is nothing for a route to
   * react to.
   *
   * Always latches the `PointFault` first (`raisePointFault`, unconditional —
   * a point with no route on it still faults, per D4/PR A). Then, for every
   * `active`/`suspended` reservation still holding this point
   * (`ReservationService.routesHoldingPoint`): stop that route's loco
   * unconditionally — not gated on `authority === 'auto'`, matching
   * `handleRouteOccupancyUnknown` — and latch a `RouteFault` naming this
   * point. The route itself is never cancelled here: `raiseRouteFault`
   * re-evaluates Safe-Stop, and Safe-Stop suspends every active reservation
   * with its locks retained (D8, `docs/route-locking.md` D8) — the same
   * mechanism `handleRouteOccupancyUnknown` already relies on rather than
   * suspending the one route directly.
   *
   * Two separate latches for one event, deliberately: "this point motor is
   * dead" (`PointFault`) and "route R's road is no longer known to be set"
   * (`RouteFault`) are different facts an operator may resolve at different
   * times, by different actions.
   */
  private async handlePointNotConfirmed(
    pointId: PointId,
    kind: 'timeout' | 'mismatch' | 'indeterminate',
    pointFaultReason: string,
  ): Promise<void> {
    await this.raisePointFault(pointId, kind, pointFaultReason);

    if (!this.layoutId) return;
    const routes = this.reservations.routesHoldingPoint(this.layoutId, pointId);
    for (const route of routes) {
      await this.stopLoco(route.locoAddress);
      await this.raiseRouteFault({
        routeId: route.id,
        kind: 'point-not-confirmed',
        reason: `Route ${route.id} suspended: point ${pointLabel(pointId, this.names.get())} failed to confirm (${kind})`,
        blockId: null,
        pointId,
        locoAddress: route.locoAddress,
      });
    }
  }

  // ─── Private: Setting the road (#4) ──────────────────────────────────────────

  /**
   * Commands every point hold to its required position, returning one entry
   * per command that did not succeed. The single place a route's points are
   * physically set, shared by the initial grant and by D8's resume — the two
   * used to differ only by accident, and a rejected command has to mean the
   * same thing in both.
   *
   * Deliberately does NOT stop at the first failure: the caller invalidates
   * the route either way, and an operator diagnosing a dead point motor is
   * better served by "p1 and p4 rejected" than by "p1 rejected" followed by
   * a second attempt that reveals p4.
   *
   * A hold naming a point that no longer exists counts as a failure, not a
   * skip: it means the reservation and the config have drifted apart, which
   * is exactly the kind of uncertainty that must not be driven through.
   */
  private async commandPointHolds(holds: readonly RouteHold[]): Promise<PointCommandFailure[]> {
    const pointHolds = holds.filter(
      (hold): hold is RouteHold & { requiredPosition: 'normal' | 'reverse' } =>
        hold.kind === 'point' && hold.requiredPosition !== null,
    );
    if (pointHolds.length === 0) return [];

    const points: PointRecord[] = this.layoutId ? await this.repo.listPoints(this.layoutId) : [];
    const failures: PointCommandFailure[] = [];

    for (const hold of pointHolds) {
      const pointRecord = points.find((p) => p.id === hold.targetId);
      if (!pointRecord) {
        failures.push({
          pointId: hold.targetId,
          requiredPosition: hold.requiredPosition,
          message: `point ${pointLabel(hold.targetId, this.names.get())} is held by the route but no longer exists`,
        });
        continue;
      }

      try {
        await this.dcc.setPoint(pointRecord.dccAddress, hold.requiredPosition);
        // #25: same noteCommanded/onPointCommanded pair as handlePointCommand
        // — a route's own point commands arm/skip a confirmation deadline
        // exactly the same way a manual command does (D5/D7).
        const updated = this.pointConfirmations.noteCommanded(hold.targetId, hold.requiredPosition, this.clock.now());
        if (updated) {
          this.publishPointState(updated);
          this.emit('event', { type: 'POINT_STATE', payload: updated } satisfies LayoutEvent);
        }
        this.onPointCommanded?.(hold.targetId, hold.requiredPosition);
      } catch (err) {
        failures.push({
          pointId: hold.targetId,
          requiredPosition: hold.requiredPosition,
          message: `point ${pointLabel(hold.targetId, this.names.get())} rejected ${hold.requiredPosition}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }

    return failures;
  }

  // ─── Route faults (#4, see docs/pathfinding.md P8) ───────────────────────────

  /** The current latched route faults, oldest first — the first cause leads, matching `getSensorFaults`. */
  getRouteFaults(): RouteFaultView[] {
    return Object.values(this.health.routeFaults)
      .map(toRouteFaultView)
      .sort((a, b) => a.faultedAt.localeCompare(b.faultedAt));
  }

  /**
   * Latches a route fault and re-evaluates Safe-Stop.
   *
   * Every route-level Safe-Stop goes through here rather than calling
   * `stateManager.enterSafeStop` directly. That direct call was the bug this
   * replaces: it set the status but left nothing in `SystemHealth`, so the
   * next health evaluation — an MQTT reconnect, a sensor-fault acknowledge,
   * any config write — found nothing wrong and cleared a Safe-Stop caused by
   * a train being somewhere it should not be.
   *
   * Re-faulting an already-faulted route keeps the FIRST cause, matching
   * `SensorFault`'s DD5: the original reason is the diagnostic one.
   */
  private async raiseRouteFault(fault: Omit<RouteFault, 'faultedAt'>): Promise<void> {
    if (this.health.routeFaults[fault.routeId]) {
      this.emitRouteFaults();
      return;
    }

    this.health = {
      ...this.health,
      routeFaults: {
        ...this.health.routeFaults,
        [fault.routeId]: { ...fault, faultedAt: new Date() },
      },
    };
    this.log.error('[LayoutService] Route fault latched', {
      layoutId: this.layoutId,
      routeId: fault.routeId,
      locoAddress: fault.locoAddress,
      locoName: this.names.get().locos.get(fault.locoAddress),
      kind: fault.kind,
      reason: fault.reason,
    });

    await this.evaluateAndApplySafeStop();
    this.emitRouteFaults();
  }

  /**
   * Clears one latched route fault (#4). Any authenticated role, like the
   * sensor-fault acknowledge it mirrors.
   *
   * There is no arming threshold — the sensor equivalent has one because a
   * sensor can prove itself by publishing valid readings, and a route cannot
   * prove anything: it is already cancelled or suspended. The operator's
   * acknowledgement *is* the recovery.
   *
   * Clearing this does not make the route runnable again. A cancelled route
   * is terminal. A suspended one still has to pass `resume`'s preconditions,
   * which require every remaining block to read `clear` — so acknowledging a
   * fault whose block is still `unknown` returns the system to `online` with
   * that block simply un-routable, exactly as an acknowledged sensor fault
   * does (docs/sensor-fault-recovery.md D6).
   */
  async acknowledgeRouteFault(
    layoutId: LayoutId,
    routeId: RouteId,
  ): Promise<{
    routeId: RouteId;
    cleared: true;
    systemStatus: SystemStatus;
    safeStopReason: string | null;
    faults: RouteFaultView[];
  }> {
    if (this.layoutId !== layoutId) throw new RouteNotFaultedError(routeId);
    if (!this.health.routeFaults[routeId]) throw new RouteNotFaultedError(routeId);

    const remaining = { ...this.health.routeFaults };
    delete remaining[routeId];
    this.health = { ...this.health, routeFaults: remaining };

    await this.evaluateAndApplySafeStop();
    this.emitRouteFaults();

    const state = this.stateManager.getState();
    this.log.info('[LayoutService] Route fault acknowledged', { layoutId, routeId });

    return {
      routeId,
      cleared: true,
      systemStatus: state.systemStatus,
      safeStopReason: state.safeStopReason,
      faults: this.getRouteFaults(),
    };
  }

  private emitRouteFaults(): void {
    this.emit('event', {
      type: 'ROUTE_FAULTS',
      payload: { faults: this.getRouteFaults() },
    } satisfies LayoutEvent);
  }

  // ─── Braking runs (#6 PR B, see docs/braking.md) ──────────────────────────────

  /**
   * B8's unconstrained standard stop: the full ramp from the loco's current
   * commanded speed, with no target and therefore **no overrun expectation**
   * — there is no route to have one against. This is the fixed, reproducible
   * stimulus B8's calibration procedure measures against, and the surface
   * `POST .../locos/:address/brake` exposes.
   */
  async startStandardStop(locoAddress: LocoAddress): Promise<BrakingRunOutcome> {
    if (!this.layoutId) throw new Error('[LayoutService] startStandardStop called before start()');

    const online = this.refuseUnlessOnline();
    if (online) return online;

    const plan = await this.braking.planStop(this.layoutId, locoAddress);
    return this.beginBrakingRun(plan, locoAddress, null, null);
  }

  /**
   * Plans and runs a stop at the entry boundary of `path[targetIndex]` on a
   * granted route (B4), arming B5's overrun expectation once the ramp's first
   * command has actually gone out.
   *
   * This is the seam the automation engine (#7) drives; nothing in this
   * service decides *when* to call it. A braking run has to be asked for —
   * that is the whole boundary between #6 and #7.
   *
   * **Refused unless the system is online AND in an auto-capable mode** (B6).
   * `canIssueAutoCommand` is the same predicate every other automated
   * command is gated on: braking a train along a reserved road is an
   * automation action, and a `manual`-mode layout is one where the operator
   * is driving. `BrakingService` then applies the route-level refusals it
   * owns (route not active, manual authority, unmeasured track, a point that
   * has not confirmed) — this method deliberately re-checks none of them.
   */
  async startRouteStop(routeId: RouteId, targetIndex?: number): Promise<BrakingRunOutcome> {
    if (!this.layoutId) throw new Error('[LayoutService] startRouteStop called before start()');

    const state = this.stateManager.getState();
    const online = this.refuseUnlessOnline();
    if (online) return online;
    if (!canIssueAutoCommand(state.systemStatus, state.systemMode)) {
      return this.refuseBrakingRun({
        kind: 'auto-not-permitted',
        status: state.systemStatus,
        mode: state.systemMode,
      });
    }

    const reservation = this.reservations.getRoute(this.layoutId, routeId);
    if (!reservation) throw new RouteNotFoundError(routeId);

    const resolvedTargetIndex = targetIndex ?? reservation.path.length - 1;
    const plan = await this.braking.planStopAtRouteBoundary(
      this.layoutId,
      reservation,
      this.graph,
      resolvedTargetIndex,
    );

    return this.beginBrakingRun(
      plan,
      reservation.locoAddress,
      routeId,
      buildStopExpectation(reservation, resolvedTargetIndex),
    );
  }

  /** The current latched braking faults, oldest first — the first cause leads, matching `getRouteFaults`. */
  getBrakingFaults(): BrakingFaultView[] {
    return Object.values(this.health.brakingFaults)
      .map(toBrakingFaultView)
      .sort((a, b) => a.faultedAt.localeCompare(b.faultedAt));
  }

  /**
   * Clears one latched braking fault (B10), releasing the Safe-Stop it holds.
   *
   * No arming threshold, for P8's reason restated in B10: a sensor can prove
   * itself by publishing valid readings, and a loco cannot prove anything —
   * it has already been Safe-Stopped, so nothing it does next is evidence.
   * The operator's acknowledgement *is* the recovery, exactly as for a route
   * fault.
   *
   * Any lingering overrun expectation for this loco is dropped here too. An
   * `overrun` fault is latched by an expectation firing, and the expectation
   * is disarmed at that moment (see `checkBrakingOverrun`) — but a
   * `speed-command-rejected` fault can be acknowledged while an expectation
   * from the aborted run is still armed, and leaving it would re-Safe-Stop
   * the layout on the next occupancy report from track the operator has
   * already dealt with.
   */
  async acknowledgeBrakingFault(
    layoutId: LayoutId,
    locoAddress: LocoAddress,
  ): Promise<{
    locoAddress: LocoAddress;
    cleared: true;
    systemStatus: SystemStatus;
    safeStopReason: string | null;
    faults: BrakingFaultView[];
  }> {
    if (this.layoutId !== layoutId) throw new LocoNotFaultedError(locoAddress);
    if (!this.health.brakingFaults[locoAddress]) throw new LocoNotFaultedError(locoAddress);

    const remaining = { ...this.health.brakingFaults };
    delete remaining[locoAddress];
    this.health = { ...this.health, brakingFaults: remaining };
    this.stopExpectations.delete(locoAddress);

    await this.evaluateAndApplySafeStop();
    this.emitBrakingFaults();

    const state = this.stateManager.getState();
    this.log.info('[LayoutService] Braking fault acknowledged', {
      layoutId,
      locoAddress,
      locoName: this.names.get().locos.get(locoAddress),
    });

    return {
      locoAddress,
      cleared: true,
      systemStatus: state.systemStatus,
      safeStopReason: state.safeStopReason,
      faults: this.getBrakingFaults(),
    };
  }

  /**
   * B6's status gate, shared by both entry points: a ramp's *first* command
   * is a non-zero speed step, so starting one while Safe-Stopped would be a
   * ghost movement. Deliberately stricter than `canIssueManualCommand`,
   * which permits a command in `safe-stop` precisely so an operator can
   * recover — this is not that, and `handleEmergencyStop` remains the way to
   * stop a train when the system is not online.
   */
  private refuseUnlessOnline(): BrakingRunOutcome | null {
    const state = this.stateManager.getState();
    if (state.systemStatus === 'online') return null;
    return this.refuseBrakingRun({ kind: 'system-not-online', status: state.systemStatus });
  }

  private refuseBrakingRun(reason: BrakingRefusal): BrakingRunOutcome {
    this.log.warn('[LayoutService] Braking run refused', {
      layoutId: this.layoutId,
      reason: describeBrakingRefusal(reason, this.names.get()),
    });
    return { started: false, reason };
  }

  /**
   * Turns a granted `BrakingPlan` into a running ramp: issues step 0 inline
   * and chains the rest onto the injected `IClock`.
   *
   * **Step 0 is awaited, not scheduled.** B6 draws a distinction the code has
   * to keep: a rejection on the first command means nothing was ever
   * commanded and the caller is told `started: false` — while still latching
   * the fault, because the train is moving at its pre-braking speed and is
   * now uncommandable, which is the hazard. A rejection mid-ramp cannot be
   * reported to a caller who has long since returned, so it goes to the
   * fault latch alone.
   *
   * **The expectation is armed only after step 0 succeeds.** Arming it before
   * would leave a refused run's forbidden blocks live, so an unrelated train
   * entering them later would fault a loco that never braked.
   *
   * A second run for a loco already braking replaces the first, cancelling
   * its remaining steps: two ramps commanding one decoder is worse than
   * either.
   */
  private async beginBrakingRun(
    plan: BrakingPlan,
    locoAddress: LocoAddress,
    routeId: RouteId | null,
    expectation: BrakingStopExpectation | null,
  ): Promise<BrakingRunOutcome> {
    if (!plan.ok) {
      return this.refuseBrakingRun(plan.reason);
    }

    this.abortBrakingRun(locoAddress, 'superseded by a new braking run', { clearExpectation: true });

    const run: BrakingRun = {
      locoAddress,
      routeId,
      schedule: plan.schedule,
      nextStepIndex: 0,
      timer: null,
    };
    this.brakingRuns.set(locoAddress, run);

    const firstStep = plan.schedule.steps[0];
    run.nextStepIndex = 1;
    try {
      await this.issueBrakingStep(locoAddress, firstStep);
    } catch (err) {
      this.brakingRuns.delete(locoAddress);
      const message = err instanceof Error ? err.message : String(err);
      await this.raiseBrakingFault({
        locoAddress,
        kind: 'speed-command-rejected',
        reason: `Braking run for loco ${locoLabel(locoAddress, this.names.get())} failed on its first command: ${message}`,
        routeId,
        blockId: null,
      });
      return { started: false, reason: { kind: 'command-rejected', message } };
    }

    if (expectation) {
      this.stopExpectations.set(locoAddress, expectation);
    }

    this.log.info('[LayoutService] Braking run started', {
      layoutId: this.layoutId,
      locoAddress,
      locoName: this.names.get().locos.get(locoAddress),
      routeId,
      steps: plan.schedule.steps.length,
      estimatedStoppingDistanceMm: plan.schedule.estimatedStoppingDistanceMm,
      requiredDistanceMm: plan.schedule.requiredDistanceMm,
      totalDurationMs: plan.schedule.totalDurationMs,
    });

    this.scheduleNextBrakingStep(run);
    return { started: true, schedule: plan.schedule };
  }

  /**
   * Arms the timer for `run`'s next step, or retires the run when the ramp is
   * done. The delay is the *difference* between consecutive `atOffsetMs`
   * values, because each timer is armed as the previous step is issued —
   * `BrakingStep.atOffsetMs` is measured from the first step (B3), not from
   * the one before it.
   *
   * Retiring a finished run deliberately leaves its overrun expectation
   * armed: reaching speed step 0 is a command, not a confirmation that the
   * train stopped.
   */
  private scheduleNextBrakingStep(run: BrakingRun): void {
    const step = run.schedule.steps[run.nextStepIndex];
    if (!step) {
      this.brakingRuns.delete(run.locoAddress);
      this.log.info('[LayoutService] Braking run complete', {
        layoutId: this.layoutId,
        locoAddress: run.locoAddress,
        locoName: this.names.get().locos.get(run.locoAddress),
        routeId: run.routeId,
      });
      return;
    }

    const previousOffsetMs = run.schedule.steps[run.nextStepIndex - 1].atOffsetMs;
    run.timer = this.clock.setTimeout(() => {
      void this.runBrakingStep(run, step);
    }, step.atOffsetMs - previousOffsetMs);
  }

  /**
   * One scheduled step of a ramp. Re-reads `brakingRuns` before doing
   * anything: a timer that has already fired cannot be cancelled, so an abort
   * that lands between the fire and this callback is caught here rather than
   * commanding a speed step for a run that no longer exists.
   */
  private async runBrakingStep(run: BrakingRun, step: BrakingStep): Promise<void> {
    if (this.brakingRuns.get(run.locoAddress) !== run) return;

    run.nextStepIndex += 1;
    try {
      await this.issueBrakingStep(run.locoAddress, step);
    } catch (err) {
      // B6: abort the run, latch a fault, Safe-Stop — deliberately NOT the
      // cancel-and-release posture of `point-command-rejected`. A moving
      // train the system cannot command is the last thing to release track
      // underneath.
      this.abortBrakingRun(run.locoAddress, 'speed command rejected mid-ramp', {
        clearExpectation: false,
      });
      const message = err instanceof Error ? err.message : String(err);
      await this.raiseBrakingFault({
        locoAddress: run.locoAddress,
        kind: 'speed-command-rejected',
        reason: `Braking run for loco ${locoLabel(run.locoAddress, this.names.get())} aborted: speed command rejected mid-ramp (${message})`,
        routeId: run.routeId,
        blockId: null,
      });
      return;
    }

    this.scheduleNextBrakingStep(run);
  }

  /**
   * Issues one ramp step and mirrors it into `LocoState` — the same
   * publish/emit pair `stopLoco` and `handleThrottleCommand` do, so a browser
   * watching a braking train sees the speed come down step by step.
   *
   * **`authority` is deliberately not written.** A braking run does not
   * change who owns the loco: an auto-authority route's train stays `auto`,
   * and a loco an operator is driving stays `manual` even while B8's
   * calibration ramp is running. Writing `'auto'` here would silently take a
   * train away from its driver.
   *
   * Rejections propagate — `beginBrakingRun`/`runBrakingStep` decide what a
   * failed command means, and neither can decide it if this swallows the
   * error the way `stopLoco` deliberately does.
   */
  private async issueBrakingStep(locoAddress: LocoAddress, step: BrakingStep): Promise<void> {
    await this.dcc.setSpeed(locoAddress, step.speedStep, step.direction);
    const locoState = this.stateManager.updateLoco(locoAddress, {
      speed: step.speedStep,
      direction: step.direction,
    });
    this.publishLocoState(locoState);
    this.emit('event', { type: 'LOCO_STATE', payload: locoState } satisfies LayoutEvent);
  }

  /**
   * Cancels a loco's in-flight ramp, if any. Returns whether there was one.
   *
   * `clearExpectation` is the B6 distinction between "stop commanding" and
   * "forget what this run promised": a manual throttle command clears it (the
   * operator's command stands, and the blocks ahead are theirs to enter now),
   * while a mid-ramp command rejection does not — the train is still moving
   * and reaching the target block is still the thing worth catching.
   */
  private abortBrakingRun(
    locoAddress: LocoAddress,
    reason: string,
    options: { clearExpectation: boolean },
  ): boolean {
    if (options.clearExpectation) {
      this.stopExpectations.delete(locoAddress);
    }

    const run = this.brakingRuns.get(locoAddress);
    if (!run) return false;

    run.timer?.cancel();
    this.brakingRuns.delete(locoAddress);
    this.log.warn('[LayoutService] Braking run aborted', {
      layoutId: this.layoutId,
      locoAddress,
      locoName: this.names.get().locos.get(locoAddress),
      routeId: run.routeId,
      reason,
    });
    return true;
  }

  /**
   * B6's emergency-stop row: every in-flight ramp is aborted **before**
   * `dcc.emergencyStop()` goes out, so no pending timer can re-command a
   * non-zero speed step after the broadcast stop. Called from
   * `handleEmergencyStop` and from the Safe-Stop transition.
   *
   * Expectations are left armed: an emergency stop does not mean the train
   * stopped where it was told to, and it may still coast into the block the
   * run promised it would not reach.
   */
  private abortAllBrakingRuns(reason: string): void {
    for (const locoAddress of [...this.brakingRuns.keys()]) {
      this.abortBrakingRun(locoAddress, reason, { clearExpectation: false });
    }
  }

  /**
   * B5's armed check, applied to one block's freshly derived occupancy. Only
   * `occupied` counts — `clear`/`unknown` are never evidence of an overrun on
   * their own (`isBrakingOverrun`).
   *
   * The expectation is **disarmed as it fires**. Leaving it armed would
   * re-latch on every subsequent recompute of the same block, and since a
   * re-fault keeps the first cause, the operator could acknowledge the fault
   * and have it reappear on the next sensor reading — an unclearable
   * Safe-Stop.
   *
   * The run, if one is still in flight, is aborted before the fault is
   * raised, for the same reason as the emergency-stop path: `raiseBrakingFault`
   * ends in `dcc.emergencyStop()` via Safe-Stop, and no timer may re-command a
   * speed step after that.
   */
  private async checkBrakingOverrun(blockId: BlockId, occupancy: Occupancy): Promise<void> {
    for (const [locoAddress, expectation] of [...this.stopExpectations]) {
      if (!isBrakingOverrun(expectation, blockId, occupancy)) continue;

      this.stopExpectations.delete(locoAddress);
      this.abortBrakingRun(locoAddress, 'overrun detected', { clearExpectation: true });
      await this.raiseBrakingFault({
        locoAddress,
        kind: 'overrun',
        reason: `Loco ${locoLabel(locoAddress, this.names.get())} overran its braking target: block ${blockLabel(blockId, this.names.get())} is occupied at or beyond the stopping point of route ${expectation.routeId}`,
        routeId: expectation.routeId,
        blockId,
      });
    }
  }

  /**
   * Latches a braking fault and re-evaluates Safe-Stop, mirroring
   * `raiseRouteFault` exactly — including keeping the FIRST cause on a
   * re-fault (DD5). Every braking Safe-Stop goes through here; no braking
   * path calls `stateManager.enterSafeStop` directly (P8's rule, restated by
   * B10).
   */
  private async raiseBrakingFault(fault: Omit<BrakingFault, 'faultedAt'>): Promise<void> {
    if (this.health.brakingFaults[fault.locoAddress]) {
      this.emitBrakingFaults();
      return;
    }

    this.health = {
      ...this.health,
      brakingFaults: {
        ...this.health.brakingFaults,
        [fault.locoAddress]: { ...fault, faultedAt: new Date() },
      },
    };
    this.log.error('[LayoutService] Braking fault latched', {
      layoutId: this.layoutId,
      locoAddress: fault.locoAddress,
      locoName: this.names.get().locos.get(fault.locoAddress),
      routeId: fault.routeId,
      blockId: fault.blockId,
      blockName: fault.blockId ? this.names.get().blocks.get(fault.blockId) : undefined,
      kind: fault.kind,
      reason: fault.reason,
    });

    await this.evaluateAndApplySafeStop();
    this.emitBrakingFaults();
  }

  private emitBrakingFaults(): void {
    this.emit('event', {
      type: 'BRAKING_FAULTS',
      payload: { faults: this.getBrakingFaults() },
    } satisfies LayoutEvent);
  }

  private async stopLoco(locoAddress: number): Promise<void> {
    await this.dcc
      .setSpeed(locoAddress, 0, 'stop')
      .catch((err: Error) =>
        this.log.error('[LayoutService] Failed to stop loco', {
          locoAddress,
          locoName: this.names.get().locos.get(locoAddress),
          error: err.message,
        }),
      );
    const locoState = this.stateManager.updateLoco(locoAddress, { speed: 0, direction: 'stop' });
    this.publishLocoState(locoState);
    this.emit('event', { type: 'LOCO_STATE', payload: locoState } satisfies LayoutEvent);
  }

  // ─── Private: Reservation outcome publishing ───────────────────────────────────

  private publishReservationOutcome(outcome: ReservationOutcome): void {
    if (outcome.reservation) {
      // B6's "route cancelled mid-ramp" row, widened to any route that has
      // stopped being `active`. This is the one choke point every status
      // transition already passes through, so a route cancelled by an
      // operator, by a force override, by a violation, or suspended into
      // Safe-Stop all reach it without a second bookkeeping path.
      //
      // The expectation goes with the run: a route that is no longer active
      // has released, or is about to release, the track its expectation was
      // about, and a *different* train entering those blocks must not fault
      // the loco that used to be routed through them.
      if (outcome.reservation.status !== 'active') {
        this.abortBrakingRun(
          outcome.reservation.locoAddress,
          `route ${outcome.reservation.id} is ${outcome.reservation.status}`,
          { clearExpectation: true },
        );
      }
      this.emit('event', { type: 'ROUTE_STATE', payload: outcome.reservation } satisfies LayoutEvent);
    }
    for (const block of outcome.changedBlocks) {
      this.publishBlockState(block);
      this.emit('event', { type: 'BLOCK_STATE', payload: block } satisfies LayoutEvent);
    }
    for (const point of outcome.changedPoints) {
      this.publishPointState(point);
      this.emit('event', { type: 'POINT_STATE', payload: point } satisfies LayoutEvent);
    }
  }

  /** Publishes a reservation outcome and, if it resolved a D9 restart-recovered route, folds that into `SystemHealth.recoveredRouteCount` and re-evaluates Safe-Stop — the mechanism that lets the D9 latch clear. */
  private async finalizeReservationOutcome(outcome: ReservationOutcome): Promise<void> {
    this.publishReservationOutcome(outcome);
    if (outcome.reservation && this.recoveredRouteIds.delete(outcome.reservation.id)) {
      this.health = { ...this.health, recoveredRouteCount: this.recoveredRouteIds.size };
      await this.evaluateAndApplySafeStop();
    }
  }

  // ─── Private: Connection Health ───────────────────────────────────────────────

  private handleMqttConnectionChange(connected: boolean): void {
    this.health = { ...this.health, mqttConnected: connected };
    this.evaluateAndApplySafeStop().catch((err: Error) =>
      this.log.error('[LayoutService] evaluateAndApplySafeStop failed', { error: err.message }),
    );
    // #25 D2: a reconnect (including the initial connect inside start(),
    // which is a harmless no-op — no points are registered yet at that
    // point) re-issues every 'required' point's query, the same recovery
    // moment a retained-cache alternative would have relied on a broker
    // replay for.
    if (connected) {
      this.queryPointPositions().catch((err: Error) =>
        this.log.error('[LayoutService] queryPointPositions failed', { error: err.message }),
      );
    }
  }

  private handleDccConnectionChange(connected: boolean): void {
    this.health = { ...this.health, dccConnected: connected };
    this.evaluateAndApplySafeStop().catch((err: Error) =>
      this.log.error('[LayoutService] evaluateAndApplySafeStop failed', { error: err.message }),
    );
  }

  private async evaluateAndApplySafeStop(): Promise<void> {
    const state = this.stateManager.getState();
    if (state.systemStatus === 'offline') return;

    const { shouldStop, reason } = evaluateSystemSafeStop(this.health);

    if (shouldStop && state.systemStatus !== 'safe-stop') {
      this.log.warn('[LayoutService] Entering Safe-Stop', { reason });
      this.stateManager.enterSafeStop(reason!);
      // B6, same rule as `handleEmergencyStop`: no pending ramp step may
      // survive the emergency stop below.
      this.abortAllBrakingRuns(`safe-stop: ${reason}`);
      // Best-effort stop — DCC may be down, so we don't await
      this.dcc.emergencyStop().catch(() => {});
      this.stateManager.stopAllLocos();
      // D8: every active reservation -> suspended. Locks retained.
      if (this.layoutId) {
        const outcomes = await this.reservations.suspendAll(this.layoutId, reason!);
        for (const outcome of outcomes) {
          this.publishReservationOutcome(outcome);
        }
      }
      this.publishSystemStatus();
      this.emit('event', {
        type: 'SYSTEM_STATUS',
        payload: {
          status: 'safe-stop',
          mode: state.systemMode,
          reason,
        },
      } satisfies LayoutEvent);
    } else if (shouldStop && state.systemStatus === 'safe-stop' && reason !== state.safeStopReason) {
      // Still stopped, but the underlying cause has changed — e.g. two
      // sensor faults were latched (D2, docs/sensor-fault-recovery.md) and
      // the oldest was just acknowledged, so a different one is now
      // reported. No entry side effects (DCC stop, loco stop, route
      // suspend) are re-run here: they already happened on the original
      // transition into Safe-Stop, and re-running them for a reason that
      // never left Safe-Stop would be pure noise. Just refresh what the
      // operator is shown.
      this.log.warn('[LayoutService] Safe-Stop reason changed', { reason });
      this.stateManager.enterSafeStop(reason!);
      this.publishSystemStatus();
      this.emit('event', {
        type: 'SYSTEM_STATUS',
        payload: {
          status: 'safe-stop',
          mode: state.systemMode,
          reason,
        },
      } satisfies LayoutEvent);
    } else if (!shouldStop && state.systemStatus === 'safe-stop') {
      // Renamed from "Connections restored" — a sensor fault acknowledge
      // (or a sensor going out of service) is now a second reason this can
      // clear, not just a connection/topology recovery.
      this.log.info('[LayoutService] Clearing Safe-Stop', { health: this.health });
      this.stateManager.clearSafeStop();
      // D8: clearing Safe-Stop does NOT resume routes. Suspended routes
      // never auto-resume — the operator must explicitly cancel or resume
      // each one. Locks stay held; nothing new can take that track.
      this.publishSystemStatus();
    }
  }

  // ─── Private: MQTT Publishing ─────────────────────────────────────────────────

  private topicBase(): string {
    return `layout/${this.layoutId}`;
  }

  private publishSystemStatus(): void {
    const state = this.stateManager.getState();
    const payload = {
      status: state.systemStatus,
      mode: state.systemMode,
      reason: state.safeStopReason,
      updatedAt: new Date().toISOString(),
    };
    this.mqtt
      .publish(`${this.topicBase()}/system/status`, payload, { qos: 1, retain: true })
      .catch((err: Error) => this.log.error('[LayoutService] Failed to publish system status', { error: err.message }));

    this.emit('event', {
      type: 'SYSTEM_STATUS',
      payload: { status: state.systemStatus, mode: state.systemMode, reason: state.safeStopReason },
    } satisfies LayoutEvent);
  }

  private publishLocoState(loco: LocoState): void {
    const payload = { ...loco, updatedAt: loco.lastUpdated.toISOString() };
    this.mqtt
      .publish(`${this.topicBase()}/loco/${loco.address}/state`, payload, { qos: 1, retain: true })
      .catch((err: Error) => this.log.error('[LayoutService] Failed to publish loco state', { error: err.message }));
  }

  /** Publishes exactly the contract's field set (docs/mqtt-contract.md `point/{pointId}/state`) — `awaitingSince` and `lastReadingAt` stay off MQTT, internal-only bookkeeping. */
  private publishPointState(point: PointState): void {
    const payload = {
      pointId: point.pointId,
      commandedPosition: point.commandedPosition,
      confirmedPosition: point.confirmedPosition,
      confirmation: point.confirmation,
      positionFeedback: point.positionFeedback,
      locked: point.locked,
      lockedByRoute: point.lockedByRoute,
      updatedAt: point.lastUpdated.toISOString(),
    };
    this.mqtt
      .publish(`${this.topicBase()}/point/${point.pointId}/state`, payload, {
        qos: 1,
        retain: true,
      })
      .catch((err: Error) => this.log.error('[LayoutService] Failed to publish point state', { error: err.message }));
  }

  private publishBlockState(block: BlockState): void {
    const payload = { ...block, updatedAt: block.lastUpdated.toISOString() };
    this.mqtt
      .publish(`${this.topicBase()}/block/${block.blockId}/state`, payload, {
        qos: 1,
        retain: true,
      })
      .catch((err: Error) => this.log.error('[LayoutService] Failed to publish block state', { error: err.message }));
  }

  // ─── Private: Heartbeat ───────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.mqtt
        .publish(`${this.topicBase()}/system/heartbeat`, { ts: Date.now() }, { qos: 0, retain: false })
        .catch(() => {});
    }, 5000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// Re-export Direction for convenience when constructing commands
export type { Direction };
