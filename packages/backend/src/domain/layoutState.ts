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
  PointId,
  PointState,
  RouteId,
  SystemMode,
  SystemStatus,
} from './types';

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

  // ─── Point Updates ────────────────────────────────────────────────────────────

  /** Registers a point in state. Called during layout initialisation. */
  registerPoint(pointId: PointId): PointState {
    const initial: PointState = {
      pointId,
      position: 'unknown',
      locked: false,
      lockedByRoute: null,
      lastUpdated: new Date(),
    };
    this.state.points.set(pointId, initial);
    return initial;
  }

  updatePointPosition(pointId: PointId, position: 'normal' | 'reverse'): PointState {
    const existing = this.state.points.get(pointId);
    const updated: PointState = {
      pointId,
      position,
      locked: existing?.locked ?? false,
      lockedByRoute: existing?.lockedByRoute ?? null,
      lastUpdated: new Date(),
    };
    this.state.points.set(pointId, updated);
    return updated;
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
}
