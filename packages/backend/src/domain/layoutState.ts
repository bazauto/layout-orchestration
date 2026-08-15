/**
 * LayoutStateManager: manages the in-memory runtime state of a single layout.
 *
 * This class is the single source of truth for live state during a session.
 * It is NOT persisted to the database — it is rebuilt from sensor readings
 * and operator interactions on each startup.
 */

import {
  BlockId,
  BlockState,
  LayoutId,
  LayoutRuntimeState,
  LocoAddress,
  LocoState,
  Occupancy,
  PointFeedbackMode,
  PointId,
  PointState,
  RouteId,
  RouteReservation,
  RouteStatus,
  SensorId,
  SensorObservation,
  SensorType,
  SystemMode,
} from './types';
import { initialPointState } from './pointConfirmation';

export class LayoutStateManager {
  private state: LayoutRuntimeState;

  constructor(layoutId: LayoutId) {
    this.state = {
      layoutId,
      systemStatus: 'offline',
      systemMode: 'manual',
      safeStopReason: null,
      blocks: new Map(),
      points: new Map(),
      locos: new Map(),
      routes: new Map(),
      sensors: new Map(),
    };
  }

  // ─── Read ────────────────────────────────────────────────────────────────────

  /** Returns a snapshot of the current state. The Maps themselves are shared — treat as read-only. */
  getState(): Readonly<LayoutRuntimeState> {
    return this.state;
  }

  getBlock(blockId: BlockId): BlockState | undefined {
    return this.state.blocks.get(blockId);
  }

  getPoint(pointId: PointId): PointState | undefined {
    return this.state.points.get(pointId);
  }

  getLoco(address: LocoAddress): LocoState | undefined {
    return this.state.locos.get(address);
  }

  // ─── System Status ────────────────────────────────────────────────────────────

  setOnline(): void {
    this.state.systemStatus = 'online';
    this.state.safeStopReason = null;
  }

  setOffline(): void {
    this.state.systemStatus = 'offline';
  }

  enterSafeStop(reason: string): void {
    this.state.systemStatus = 'safe-stop';
    this.state.safeStopReason = reason;
  }

  clearSafeStop(): void {
    if (this.state.systemStatus === 'safe-stop') {
      this.state.systemStatus = 'online';
      this.state.safeStopReason = null;
    }
  }

  setMode(mode: SystemMode): void {
    this.state.systemMode = mode;
  }

  // ─── Block Updates ────────────────────────────────────────────────────────────

  /** Registers a block in state. Called during layout initialisation. */
  registerBlock(blockId: BlockId): BlockState {
    const initial: BlockState = {
      blockId,
      occupancy: 'unknown',
      locoAddress: null,
      lockedByRoute: null,
      lastUpdated: new Date(),
    };
    this.state.blocks.set(blockId, initial);
    return initial;
  }

  updateBlockOccupancy(
    blockId: BlockId,
    occupancy: Occupancy,
    locoAddress?: LocoAddress | null,
  ): BlockState {
    const existing = this.state.blocks.get(blockId);
    const updated: BlockState = {
      blockId,
      occupancy,
      locoAddress: locoAddress !== undefined ? locoAddress : (existing?.locoAddress ?? null),
      lockedByRoute: existing?.lockedByRoute ?? null,
      lastUpdated: new Date(),
    };
    this.state.blocks.set(blockId, updated);
    return updated;
  }

  lockBlock(blockId: BlockId, routeId: RouteId): void {
    const block = this.state.blocks.get(blockId);
    if (block) {
      this.state.blocks.set(blockId, { ...block, lockedByRoute: routeId });
    }
  }

  unlockBlock(blockId: BlockId): void {
    const block = this.state.blocks.get(blockId);
    if (block) {
      this.state.blocks.set(blockId, { ...block, lockedByRoute: null });
    }
  }

  // ─── Point Updates (see docs/point-feedback.md) ───────────────────────────────

  /**
   * Registers a point in state via `initialPointState` (#25). Called during
   * layout initialisation. `feedback` is the point's configured
   * `positionFeedback` — carried straight through, never defaulted here (the
   * caller resolves the default).
   */
  registerPoint(pointId: PointId, feedback: PointFeedbackMode, now: Date): PointState {
    const initial = initialPointState(pointId, feedback, now);
    this.state.points.set(pointId, initial);
    return initial;
  }

  /**
   * Stores whatever the domain decided (#25) — same posture as
   * `upsertRoute`: this class holds state, it does not compute it.
   * `PointConfirmationService` is the only caller, via
   * `domain/pointConfirmation.ts`'s pure transition functions.
   *
   * A `setPointState` for an UNREGISTERED point id is a no-op that returns
   * `next` unchanged without inserting — `PointConfirmationService` relies
   * on this: a reading or command naming a point this layout does not have
   * must not silently create a phantom entry.
   */
  setPointState(pointId: PointId, next: PointState): PointState {
    if (!this.state.points.has(pointId)) return next;
    this.state.points.set(pointId, next);
    return next;
  }

  lockPoint(pointId: PointId, routeId: RouteId): void {
    const point = this.state.points.get(pointId);
    if (point) {
      this.state.points.set(pointId, { ...point, locked: true, lockedByRoute: routeId });
    }
  }

  unlockPoint(pointId: PointId): void {
    const point = this.state.points.get(pointId);
    if (point) {
      this.state.points.set(pointId, { ...point, locked: false, lockedByRoute: null });
    }
  }

  // ─── Loco Updates ─────────────────────────────────────────────────────────────

  /** Registers or updates a loco in state. */
  updateLoco(address: LocoAddress, update: Partial<Omit<LocoState, 'address'>>): LocoState {
    const existing = this.state.locos.get(address);
    const updated: LocoState = {
      address,
      speed: update.speed ?? existing?.speed ?? 0,
      direction: update.direction ?? existing?.direction ?? 'stop',
      functions: update.functions ?? existing?.functions ?? {},
      authority: update.authority ?? existing?.authority ?? 'manual',
      lastUpdated: new Date(),
    };
    this.state.locos.set(address, updated);
    return updated;
  }

  /** Sets all locos to speed 0 / stop. Used for emergency stop and safe-stop. */
  stopAllLocos(): LocoState[] {
    const stopped: LocoState[] = [];
    for (const [address, loco] of this.state.locos) {
      const updated: LocoState = {
        ...loco,
        speed: 0,
        direction: 'stop',
        lastUpdated: new Date(),
      };
      this.state.locos.set(address, updated);
      stopped.push(updated);
    }
    return stopped;
  }

  // ─── Route Reservations ───────────────────────────────────────────────────────
  //
  // `LayoutStateManager` is storage only, same posture as blocks/points above:
  // it holds whatever `ReservationService` (which owns policy — grant/cancel/
  // release decisions) tells it to. It does not validate a reservation
  // against block/point state itself.

  getRoute(routeId: RouteId): RouteReservation | undefined {
    return this.state.routes.get(routeId);
  }

  /** All routes, optionally filtered to the given statuses. Unfiltered order matches insertion order. */
  listRoutes(statuses?: RouteStatus[]): RouteReservation[] {
    const all = [...this.state.routes.values()];
    if (!statuses) return all;
    return all.filter((r) => statuses.includes(r.status));
  }

  /** Inserts or replaces a route's cached state — the projection (block/point `lockedByRoute`) is maintained separately by the caller, not derived here. */
  upsertRoute(route: RouteReservation): void {
    this.state.routes.set(route.id, route);
  }

  removeRoute(routeId: RouteId): void {
    this.state.routes.delete(routeId);
  }

  // ─── Sensor Observations (see docs/sensor-fault-recovery.md) ─────────────────
  //
  // Storage only, same posture as blocks/points/routes above: `LayoutService`
  // owns the policy (when to fault, de-service, or recompute a block's
  // derived occupancy); this class just holds whatever it is told.

  /** Upsert of config fields. Preserves `faulted`, `lastReading`, `lastReadingAt` for an already-registered sensor — only `LayoutService` decides to change those. A no-op... it always creates/updates; never throws. */
  registerSensor(config: {
    sensorId: SensorId;
    blockId: BlockId | null;
    type: SensorType;
    inService: boolean;
  }): SensorObservation {
    const existing = this.state.sensors.get(config.sensorId);
    const updated: SensorObservation = {
      sensorId: config.sensorId,
      blockId: config.blockId,
      type: config.type,
      inService: config.inService,
      faulted: existing?.faulted ?? false,
      lastReading: existing?.lastReading ?? null,
      lastReadingAt: existing?.lastReadingAt ?? null,
    };
    this.state.sensors.set(config.sensorId, updated);
    return updated;
  }

  unregisterSensor(sensorId: SensorId): void {
    this.state.sensors.delete(sensorId);
  }

  getSensorObservation(sensorId: SensorId): SensorObservation | undefined {
    return this.state.sensors.get(sensorId);
  }

  /** Every sensor observation registered against `blockId`, in no particular order. `[]` for a block with none. */
  listSensorObservationsForBlock(blockId: BlockId): SensorObservation[] {
    return [...this.state.sensors.values()].filter((s) => s.blockId === blockId);
  }

  /** No-op for an unknown `sensorId` — mirrors `lockBlock`'s "must not rely on this to validate anything" posture. */
  recordSensorReading(sensorId: SensorId, reading: 'occupied' | 'clear', at: Date): void {
    const existing = this.state.sensors.get(sensorId);
    if (!existing) return;
    this.state.sensors.set(sensorId, { ...existing, lastReading: reading, lastReadingAt: at });
  }

  /** Nulls the reading (DD6) — a faulted or de-serviced sensor's last reading is not retained as a going belief. No-op for an unknown `sensorId`. */
  clearSensorReading(sensorId: SensorId): void {
    const existing = this.state.sensors.get(sensorId);
    if (!existing) return;
    this.state.sensors.set(sensorId, { ...existing, lastReading: null, lastReadingAt: null });
  }

  /** Deliberately does NOT also clear the reading — that is `LayoutService`'s call (DD6), so this storage layer holds no policy about when a fault and a reading are cleared together. No-op for an unknown `sensorId`. */
  setSensorFaulted(sensorId: SensorId, faulted: boolean): void {
    const existing = this.state.sensors.get(sensorId);
    if (!existing) return;
    this.state.sensors.set(sensorId, { ...existing, faulted });
  }
}
