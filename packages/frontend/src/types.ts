/**
 * Shared types mirroring the backend domain — kept in sync manually.
 * In a future phase these could be generated from a shared package.
 */

export type Occupancy = 'occupied' | 'clear' | 'unknown';
export type PointPosition = 'normal' | 'reverse' | 'unknown';
export type Direction = 'fwd' | 'rev' | 'stop';
export type SystemStatus = 'online' | 'safe-stop' | 'offline';
export type SystemMode = 'manual' | 'auto' | 'hybrid';

// ─── REST / config types (mirror backend records) ────────────────────────────

export interface BlockRecord {
  id: string;
  layoutId: string;
  name: string;
}

export interface PointRecord {
  id: string;
  layoutId: string;
  name: string;
  dccAddress: number;
  blockId: string | null;
}

export interface SensorRecord {
  id: string;
  layoutId: string;
  name: string;
  type: 'block_detection' | 'ir_position';
  blockId: string | null;
  mqttTopic: string;
}

export interface LocoRecord {
  id: string;
  layoutId: string;
  name: string;
  address: number;
  type: string;
  maxSpeed: number;
  brakingFactor: number;
}

// ─── Topology (mirrors backend domain/types.ts) ───────────────────────────────

export interface PointCondition {
  pointId: string;
  requiredPosition: 'normal' | 'reverse';
}

export interface BlockEdgeRecord {
  id: string;
  layoutId: string;
  fromBlockId: string;
  fromEnd: string;
  toBlockId: string;
  toEnd: string;
  pointConditions: PointCondition[];
  lengthMm: number | null;
}

/** Mirrors the `TopologyViolation` union in `domain/topology.ts` exactly. */
export type TopologyViolation =
  | {
      kind: 'layout-mismatch';
      edgeId: string;
      expectedLayoutId: string;
      actualLayoutId: string;
    }
  | { kind: 'duplicate-edge-id'; edgeId: string }
  | { kind: 'self-loop'; edgeId: string; blockId: string }
  | { kind: 'unknown-block'; edgeId: string; blockId: string }
  | { kind: 'unknown-point'; edgeId: string; pointId: string }
  | { kind: 'duplicate-connection'; edgeId: string; conflictingEdgeId: string };

export interface TopologyStatus {
  valid: boolean;
  violations: TopologyViolation[];
  edgeCount: number;
}

// ─── Grid ─────────────────────────────────────────────────────────────────────

export type TileType =
  | 'straight-h'    // ─ (also covers legacy straight-v via rotation)
  | 'straight-v'    // │ (legacy – still renderable)
  | 'straight-45'   // ╱ (diagonal / "Corner")
  | 'curve'         // ╭ (quarter-circle, rotatable)
  // Legacy named curves – kept for backward compat with saved grids
  | 'curve-ne'      // ╭
  | 'curve-nw'      // ╮
  | 'curve-se'      // ╰
  | 'curve-sw'      // ╯
  | 'point-left'    // ╠
  | 'point-right'   // ╣
  | 'buffer'        // ■
  | 'platform'      // ▬
  | 'crossing'      // ╋
  | 'empty';

export interface GridTileRecord {
  id: string;
  layoutId: string;
  x: number;
  y: number;
  tileType: TileType;
  metadata: string; // JSON
}

export interface BlockState {
  blockId: string;
  occupancy: Occupancy;
  locoAddress: number | null;
  lockedByRoute: string | null;
  lastUpdated: string;
}

export interface PointState {
  pointId: string;
  position: PointPosition;
  locked: boolean;
  lockedByRoute: string | null;
  lastUpdated: string;
}

export interface LocoState {
  address: number;
  speed: number;
  direction: Direction;
  functions: Record<number, boolean>;
  authority: 'manual' | 'auto';
  lastUpdated: string;
}

export interface StateSnapshot {
  systemStatus: SystemStatus;
  systemMode: SystemMode;
  safeStopReason: string | null;
  blocks: Record<string, BlockState>;
  points: Record<string, PointState>;
  locos: Record<number, LocoState>;
}

// ─── Server → Client messages ─────────────────────────────────────────────────

export type ServerMessage =
  | { type: 'STATE_SNAPSHOT'; payload: StateSnapshot }
  | { type: 'BLOCK_STATE'; payload: BlockState }
  | { type: 'POINT_STATE'; payload: PointState }
  | { type: 'LOCO_STATE'; payload: LocoState }
  | { type: 'SYSTEM_STATUS'; payload: { status: SystemStatus; mode: SystemMode; reason: string | null } }
  | { type: 'ERROR'; payload: { message: string; details?: unknown } };

// ─── Client → Server messages ─────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'THROTTLE_COMMAND'; payload: { locoAddress: number; speed: number; direction: Direction } }
  | { type: 'POINT_COMMAND'; payload: { pointId: string; position: 'normal' | 'reverse'; force?: boolean } }
  | { type: 'FUNCTION_COMMAND'; payload: { locoAddress: number; fn: number; state: boolean } }
  | { type: 'SET_MODE'; payload: { mode: SystemMode } }
  | { type: 'EMERGENCY_STOP' };
