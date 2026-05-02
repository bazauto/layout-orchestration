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
 */

import { EventEmitter } from 'events';
import {
  BlockState,
  Direction,
  FunctionCommand,
  LayoutEvent,
  LayoutId,
  LocoState,
  PointCommand,
  PointState,
  SetModeCommand,
  SystemMode,
  ThrottleCommand,
} from '../domain/types';
import { LayoutStateManager } from '../domain/layoutState';
import {
  canIssueManualCommand,
  ConnectionHealth,
  evaluateSafeStop,
  isBlockEffectivelyOccupied,
  isValidLocoAddress,
  isValidSpeed,
} from '../domain/safety';
import { IDccController } from '../ports/IDccController';
import { IMqttAdapter } from '../ports/IMqttAdapter';
import { ILayoutRepository } from '../ports/ILayoutRepository';
import { sensorReadingSchema } from './validation';

export interface LayoutServiceLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export class LayoutService extends EventEmitter {
  private layoutId: LayoutId | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private health: ConnectionHealth = { mqttConnected: false, dccConnected: false };

  constructor(
    private readonly dcc: IDccController,
    private readonly mqtt: IMqttAdapter,
    private readonly repo: ILayoutRepository,
    private readonly stateManager: LayoutStateManager,
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

    // Load layout config and register blocks/points in state
    await this.initializeLayoutState(layoutId);

    // Subscribe to sensor topics
    await this.subscribeSensors(layoutId);

    this.stateManager.setOnline();
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
    if (pointState?.locked && !cmd.force) {
      throw new Error(
        `Point ${cmd.pointId} is locked by route ${pointState.lockedByRoute}. Use force=true to override.`,
      );
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
    this.publishSystemStatus();
    this.log.info('[LayoutService] Mode changed', { mode: cmd.mode });
  }

  // ─── State Access ─────────────────────────────────────────────────────────────

  getSystemStatus(): { status: string; mode: SystemMode; reason: string | null } {
    const s = this.stateManager.getState();
    return { status: s.systemStatus, mode: s.systemMode, reason: s.safeStopReason };
  }

  getAllState() {
    return this.stateManager.getState();
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
  }

  private async subscribeSensors(layoutId: LayoutId): Promise<void> {
    const dbSensors = await this.repo.listSensors(layoutId);

    for (const sensor of dbSensors) {
      await this.mqtt.subscribe(sensor.mqttTopic, (payload) => {
        this.handleSensorReading(sensor.id, sensor.blockId, payload);
      });
    }

    this.log.info('[LayoutService] Sensor subscriptions registered', {
      count: dbSensors.length,
    });
  }

  // ─── Private: Sensor Ingestion ────────────────────────────────────────────────

  private handleSensorReading(
    sensorId: string,
    blockId: string | null,
    rawPayload: unknown,
  ): void {
    const result = sensorReadingSchema.safeParse(rawPayload);
    if (!result.success) {
      this.log.warn('[LayoutService] Invalid sensor payload', {
        sensorId,
        error: result.error.message,
      });
      return;
    }

    if (!blockId) return;

    const updated = this.stateManager.updateBlockOccupancy(blockId, result.data.state);
    this.publishBlockState(updated);
    this.emit('event', { type: 'BLOCK_STATE', payload: updated } satisfies LayoutEvent);

    // If a block becomes occupied and has an auto-mode loco approaching, the
    // automation engine (Phase 3) will hook into this event. For now, just log.
    if (isBlockEffectivelyOccupied(updated.occupancy)) {
      this.log.info('[LayoutService] Block occupied', { blockId, sensorId });
    }
  }

  // ─── Private: Connection Health ───────────────────────────────────────────────

  private handleMqttConnectionChange(connected: boolean): void {
    this.health = { ...this.health, mqttConnected: connected };
    this.evaluateAndApplySafeStop();
  }

  private handleDccConnectionChange(connected: boolean): void {
    this.health = { ...this.health, dccConnected: connected };
    this.evaluateAndApplySafeStop();
  }

  private evaluateAndApplySafeStop(): void {
    const state = this.stateManager.getState();
    if (state.systemStatus === 'offline') return;

    const { shouldStop, reason } = evaluateSafeStop(this.health);

    if (shouldStop && state.systemStatus !== 'safe-stop') {
      this.log.warn('[LayoutService] Entering Safe-Stop', { reason });
      this.stateManager.enterSafeStop(reason!);
      // Best-effort stop — DCC may be down, so we don't await
      this.dcc.emergencyStop().catch(() => {});
      this.stateManager.stopAllLocos();
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
