/**
 * Core domain types for the Layout Orchestrator.
 * These types are the authoritative vocabulary for the entire system.
 * No transport, persistence, or hardware concepts live here.
 */

// ─── Branded Identifiers ──────────────────────────────────────────────────────

export type LayoutId = string;
export type BlockId = string;
export type PointId = string;
export type SensorId = string;
export type RouteId = string;

/** DCC loco address (1–9999) */
export type LocoAddress = number;

// ─── State Enumerations ───────────────────────────────────────────────────────

/** Block occupancy. Unknown is the safe default on startup or after sensor timeout. */
export type Occupancy = 'occupied' | 'clear' | 'unknown';

/** Point position. Unknown until first confirmation received from DCC controller. */
export type PointPosition = 'normal' | 'reverse' | 'unknown';

/** Loco direction of travel. */
export type Direction = 'fwd' | 'rev' | 'stop';

/** Who has control authority over a loco or block. */
export type Authority = 'manual' | 'auto';

/** Current operating mode of the layout. */
export type SystemMode = 'manual' | 'auto' | 'hybrid';

/** Current operating status of the orchestrator. */
export type SystemStatus = 'online' | 'safe-stop' | 'offline';

// ─── Runtime State ────────────────────────────────────────────────────────────

export interface BlockState {
  blockId: BlockId;
  occupancy: Occupancy;
  /** DCC address of the loco believed to be in this block, if known. */
  locoAddress: LocoAddress | null;
  /** Route ID that holds a reservation on this block. */
  lockedByRoute: RouteId | null;
  lastUpdated: Date;
}

export interface PointState {
  pointId: PointId;
  position: PointPosition;
  /** Whether this point is locked by an active route. */
  locked: boolean;
  lockedByRoute: RouteId | null;
  lastUpdated: Date;
}

export interface LocoState {
  address: LocoAddress;
  /** DCC speed step 0–126. */
  speed: number;
  direction: Direction;
  /** Map of DCC function number to boolean state. */
  functions: Record<number, boolean>;
  authority: Authority;
  lastUpdated: Date;
}

export interface LayoutRuntimeState {
  layoutId: LayoutId;
  systemStatus: SystemStatus;
  systemMode: SystemMode;
  safeStopReason: string | null;
  blocks: Map<BlockId, BlockState>;
  points: Map<PointId, PointState>;
  locos: Map<LocoAddress, LocoState>;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export interface ThrottleCommand {
  locoAddress: LocoAddress;
  speed: number;
  direction: Direction;
}

export interface PointCommand {
  pointId: PointId;
  position: 'normal' | 'reverse';
  /** If true, the operator is explicitly overriding a lock. Requires manual authority. */
  force?: boolean;
}

export interface FunctionCommand {
  locoAddress: LocoAddress;
  fn: number;
  state: boolean;
}

export interface SetModeCommand {
  mode: SystemMode;
}

// ─── Events ───────────────────────────────────────────────────────────────────

/** Discriminated union of all events emitted by LayoutService. */
export type LayoutEvent =
  | { type: 'BLOCK_STATE'; payload: BlockState }
  | { type: 'POINT_STATE'; payload: PointState }
  | { type: 'LOCO_STATE'; payload: LocoState }
  | {
      type: 'SYSTEM_STATUS';
      payload: { status: SystemStatus; mode: SystemMode; reason: string | null };
    };

// ─── WebSocket Message Shapes ─────────────────────────────────────────────────

/** Messages sent FROM the frontend TO the backend over WebSocket. */
export type ClientMessage =
  | { type: 'THROTTLE_COMMAND'; payload: ThrottleCommand }
  | { type: 'POINT_COMMAND'; payload: PointCommand }
  | { type: 'FUNCTION_COMMAND'; payload: FunctionCommand }
  | { type: 'SET_MODE'; payload: SetModeCommand }
  | { type: 'EMERGENCY_STOP' };
