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
  Direction,
  FunctionCommand,
  LayoutEvent,
  LayoutId,
  LocoState,
  PointCommand,
  PointId,
  PointState,
  RouteId,
  RouteReservation,
  RouteStatus,
  SetModeCommand,
  SystemMode,
  ThrottleCommand,
} from '../domain/types';
import { LayoutStateManager } from '../domain/layoutState';
import {
  canForcePointOverride,
  canIssueManualCommand,
  evaluateSystemSafeStop,
  isBlockEffectivelyOccupied,
  isValidLocoAddress,
  isValidSpeed,
  SystemHealth,
} from '../domain/safety';
import { TrackGraph } from '../domain/graph';
import { ReservationRequest } from '../domain/routeLocking';
import { IDccController } from '../ports/IDccController';
import { IMqttAdapter } from '../ports/IMqttAdapter';
import { ILayoutRepository } from '../ports/ILayoutRepository';
import { sensorReadingSchema } from './validation';
import { loadTopology, TopologyLoadResult } from './topologyLoader';
import { GrantOutcome, ReservationOutcome, ReservationService, ResumeResult } from './ReservationService';

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
  ) {
    super(`Point ${pointId} is locked by route ${routeId}. Use force=true to override.`);
    this.name = 'PointLockedError';
  }
}

export class LayoutService extends EventEmitter {
  private layoutId: LayoutId | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private health: SystemHealth = {
    mqttConnected: false,
    dccConnected: false,
    topologyValid: true,
    topologyReason: null,
    sensorFault: false,
    sensorFaultReason: null,
    recoveredRouteCount: 0,
  };
  private graph: TrackGraph | null = null;
  /** Route ids revived by `ReservationService.loadOnStartup` (D9) that the
   * operator has not yet cancelled or resumed. Backs `SystemHealth.recoveredRouteCount`;
   * emptying this set is what lets the D9 Safe-Stop latch clear. */
  private recoveredRouteIds = new Set<RouteId>();

  constructor(
    private readonly dcc: IDccController,
    private readonly mqtt: IMqttAdapter,
    private readonly repo: ILayoutRepository,
    private readonly stateManager: LayoutStateManager,
    private readonly reservations: ReservationService,
    private readonly log: LayoutServiceLogger,
  ) {
    super();
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

    this.publishSystemStatus();
    this.startHeartbeat();

    this.log.info('[LayoutService] Started', { layoutId });
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();

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
        throw new PointLockedError(cmd.pointId, pointState.lockedByRoute!);
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
      throw new Error(`Point ${cmd.pointId} not found in layout ${this.layoutId}`);
    }

    await this.dcc.setPoint(pointRecord.dccAddress, cmd.position);

    const updated = this.stateManager.updatePointPosition(cmd.pointId, cmd.position);
    this.publishPointState(updated);
    this.emit('event', { type: 'POINT_STATE', payload: updated } satisfies LayoutEvent);
    this.log.info('[LayoutService] Point command applied', {
      pointId: cmd.pointId,
      position: cmd.position,
    });
  }

  async handleEmergencyStop(): Promise<void> {
    this.log.warn('[LayoutService] EMERGENCY STOP');
    await this.dcc.emergencyStop();

    const stopped = this.stateManager.stopAllLocos();
    for (const loco of stopped) {
      this.publishLocoState(loco);
      this.emit('event', { type: 'LOCO_STATE', payload: loco } satisfies LayoutEvent);
    }
  }

  async handleSetMode(cmd: SetModeCommand): Promise<void> {
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

  async requestRoute(request: Omit<ReservationRequest, 'layoutId'>): Promise<GrantOutcome> {
    if (!this.layoutId) throw new Error('[LayoutService] requestRoute called before start()');
    const outcome = await this.reservations.grant(this.layoutId, request, this.graph);
    if (outcome.granted) {
      this.emit('event', { type: 'ROUTE_STATE', payload: outcome.reservation } satisfies LayoutEvent);
      for (const block of outcome.changedBlocks) {
        this.publishBlockState(block);
        this.emit('event', { type: 'BLOCK_STATE', payload: block } satisfies LayoutEvent);
      }
      for (const point of outcome.changedPoints) {
        this.publishPointState(point);
        this.emit('event', { type: 'POINT_STATE', payload: point } satisfies LayoutEvent);
      }
      this.log.info('[LayoutService] Route granted', {
        layoutId: this.layoutId,
        routeId: outcome.reservation.id,
        locoAddress: outcome.reservation.locoAddress,
      });
    } else {
      this.log.warn('[LayoutService] Route request rejected', {
        layoutId: this.layoutId,
        rejections: outcome.rejections,
      });
    }
    return outcome;
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
   * held point to its required position, best-effort — `ReservationService`
   * has no DCC access, so the physical re-command necessarily happens here.
   * A point lock is an authority lock, not a physical position guarantee
   * (D11), so a re-command failure does not undo the resume.
   */
  async resumeRoute(routeId: RouteId): Promise<ResumeResult> {
    if (!this.layoutId) throw new Error('[LayoutService] resumeRoute called before start()');
    const result = await this.reservations.resume(this.layoutId, routeId);
    if (!result.resumed) {
      this.log.warn('[LayoutService] Resume refused', { routeId, reason: result.reason });
      return result;
    }

    this.emit('event', { type: 'ROUTE_STATE', payload: result.reservation } satisfies LayoutEvent);
    if (this.recoveredRouteIds.delete(routeId)) {
      this.health = { ...this.health, recoveredRouteCount: this.recoveredRouteIds.size };
      await this.evaluateAndApplySafeStop();
    }

    const points = await this.repo.listPoints(this.layoutId);
    for (const hold of result.pointsToRecommand) {
      if (!hold.requiredPosition) continue;
      const pointRecord = points.find((p) => p.id === hold.targetId);
      if (!pointRecord) continue;
      try {
        await this.dcc.setPoint(pointRecord.dccAddress, hold.requiredPosition);
        const updated = this.stateManager.updatePointPosition(hold.targetId, hold.requiredPosition);
        this.publishPointState(updated);
        this.emit('event', { type: 'POINT_STATE', payload: updated } satisfies LayoutEvent);
      } catch (err) {
        this.log.error('[LayoutService] Failed to re-command point on resume', {
          pointId: hold.targetId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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

    const result = await loadTopology(this.repo, layoutId);

    this.graph = result.graph;
    this.health = { ...this.health, topologyValid: !result.fatal, topologyReason: result.reason };

    if (result.fatal) {
      this.log.error('[LayoutService] Topology invalid', {
        layoutId,
        violations: result.violations,
      });
    }

    await this.evaluateAndApplySafeStop();

    return result;
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
    for (const point of dbPoints) {
      this.stateManager.registerPoint(point.id);
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
      await this.mqtt.subscribe(sensor.mqttTopic, (payload) => {
        void this.handleSensorReading(sensor.id, sensor.blockId, sensor.mqttTopic, payload);
      });
    }

    this.log.info('[LayoutService] Sensor subscriptions registered', {
      count: dbSensors.length,
    });
  }

  // ─── Private: Sensor Ingestion ────────────────────────────────────────────────

  /**
   * A malformed sensor payload is a Fail-Safe Trigger (mqtt-contract.md
   * §Fail-Safe Triggers item 3 / CLAUDE.md safety rule 3), not a logged
   * warning: a sensor that has started sending garbage is indistinguishable,
   * from the domain's point of view, from one that has silently stopped
   * updating — and occupancy state that has silently stopped updating is
   * indistinguishable from track that is genuinely clear. Trips immediately
   * on the first malformed message, via the same `evaluateAndApplySafeStop`
   * path as a connection or topology failure — no parallel mechanism, no
   * tolerance/threshold. Block state is never touched on this path; the
   * `return` happens before `stateManager.updateBlockOccupancy` is reached.
   * Async because a *valid* payload continues on into
   * `reservations.onOccupancyChange` (see docs/route-locking.md) — the
   * malformed-payload branch below is itself fully synchronous.
   */
  private async handleSensorReading(
    sensorId: string,
    blockId: string | null,
    topic: string,
    rawPayload: unknown,
  ): Promise<void> {
    const result = sensorReadingSchema.safeParse(rawPayload);
    if (!result.success) {
      const reason = `Malformed sensor payload from sensor "${sensorId}" on topic "${topic}": ${result.error.message}`;
      this.log.error('[LayoutService] Invalid sensor payload — entering Safe-Stop', {
        layoutId: this.layoutId,
        sensorId,
        blockId,
        topic,
        error: result.error.message,
      });
      this.health = { ...this.health, sensorFault: true, sensorFaultReason: reason };
      await this.evaluateAndApplySafeStop();
      return;
    }

    if (!blockId) return;

    const previousOccupancy = this.stateManager.getBlock(blockId)?.occupancy ?? 'unknown';
    const updated = this.stateManager.updateBlockOccupancy(blockId, result.data.state);
    this.publishBlockState(updated);
    this.emit('event', { type: 'BLOCK_STATE', payload: updated } satisfies LayoutEvent);

    if (isBlockEffectivelyOccupied(updated.occupancy)) {
      this.log.info('[LayoutService] Block occupied', { blockId, sensorId });
    }

    if (this.layoutId) {
      const outcome = await this.reservations.onOccupancyChange(
        this.layoutId,
        blockId,
        result.data.state,
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
    }
  }

  /** D7: a manual train has entered reserved track the system did not expect it in — stop that loco and enter Safe-Stop. Scoped to reserved track; unreserved track is #7. */
  private async handleRouteViolation(blockId: BlockId, reservation: RouteReservation): Promise<void> {
    this.log.error('[LayoutService] Route violation — unexpected occupancy', {
      blockId,
      routeId: reservation.id,
      locoAddress: reservation.locoAddress,
    });
    await this.stopLoco(reservation.locoAddress);

    const state = this.stateManager.getState();
    if (state.systemStatus !== 'safe-stop') {
      this.stateManager.enterSafeStop(
        `Route ${reservation.id} violated: unexpected occupancy in block ${blockId}`,
      );
      this.publishSystemStatus();
    }
  }

  private async stopLoco(locoAddress: number): Promise<void> {
    await this.dcc
      .setSpeed(locoAddress, 0, 'stop')
      .catch((err: Error) =>
        this.log.error('[LayoutService] Failed to stop loco', { locoAddress, error: err.message }),
      );
    const locoState = this.stateManager.updateLoco(locoAddress, { speed: 0, direction: 'stop' });
    this.publishLocoState(locoState);
    this.emit('event', { type: 'LOCO_STATE', payload: locoState } satisfies LayoutEvent);
  }

  // ─── Private: Reservation outcome publishing ───────────────────────────────────

  private publishReservationOutcome(outcome: ReservationOutcome): void {
    if (outcome.reservation) {
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
    } else if (!shouldStop && state.systemStatus === 'safe-stop') {
      this.log.info('[LayoutService] Connections restored, clearing Safe-Stop');
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

  private publishPointState(point: PointState): void {
    const payload = { ...point, updatedAt: point.lastUpdated.toISOString() };
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
