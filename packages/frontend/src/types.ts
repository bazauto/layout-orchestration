/**
 * Shared types mirroring the backend domain — kept in sync manually.
 * In a future phase these could be generated from a shared package.
 */

export type Occupancy = 'occupied' | 'clear' | 'unknown';
export type PointPosition = 'normal' | 'reverse' | 'unknown';
export type Direction = 'fwd' | 'rev' | 'stop';
export type SystemStatus = 'online' | 'safe-stop' | 'offline';
export type SystemMode = 'manual' | 'auto' | 'hybrid';

/** Operator account role. 'admin' may edit topology and config; 'operator' may drive. */
export type Role = 'admin' | 'operator';

/**
 * Wire projection of the backend's `UserView` (#53, `domain/types.ts`).
 * `createdAt` is ISO 8601; there is no `passwordHash` field on the wire at
 * all — the backend strips it before the record ever leaves `AuthService`.
 */
export interface UserView {
  id: string;
  username: string;
  role: Role;
  createdAt: string;
  hasPassword: boolean;
}

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
  /** Mirrors `sensors.in_service` (#34). An out-of-service sensor is unsubscribed and contributes nothing. */
  inService: boolean;
}

/**
 * Wire projection of the backend's `SensorFault` (#34, `domain/types.ts`).
 * `faultedAt` is ISO 8601; `armed`/`requiredValidReadings` are precomputed
 * server-side so the frontend never re-implements D1's arming rule.
 */
export interface SensorFaultView {
  sensorId: string;
  reason: string;
  topic: string;
  faultedAt: string;
  consecutiveValidReadings: number;
  requiredValidReadings: number;
  armed: boolean;
}

// ─── Sensor Simulation (#65, see docs/sensor-simulation.md) ───────────────────

export type MalformedVariant = 'bad-enum' | 'missing-field' | 'not-an-object';

/** Mirrors the backend's `simulateReadingSchema` discriminated union exactly (#65 R5). */
export type SimulateReadingRequest =
  | { action: 'reading'; state: 'occupied' | 'clear'; retain: boolean }
  | { action: 'malformed'; variant: MalformedVariant; retain: boolean }
  | { action: 'clear-retained' };

/** Wire shape of `POST .../simulate-reading`'s 202 body — the exact bytes published. */
export interface SimulateReadingResponse {
  sensorId: string;
  sensorName: string | null;
  topic: string;
  action: 'reading' | 'malformed' | 'clear-retained';
  /** The exact JSON value published. `null` for clear-retained (zero bytes, no JSON). */
  payload: unknown;
  retain: boolean;
  publishedAt: string;
}

/** Wire shape of `GET /api/capabilities` (#65 D3). Fails closed — see `useCapabilities`. */
export interface Capabilities {
  sensorSimulation: boolean;
}

// ─── Route reservations (mirror backend domain/types.ts) ─────────────────────

export type RouteStatus = 'active' | 'suspended' | 'released' | 'cancelled';
export type RouteHoldKind = 'block' | 'point' | 'edge';

export interface RoutePathStep {
  edgeId: string | null;
  blockId: string;
  entryEnd: string | null;
  exitEnd: string | null;
}

export interface RouteHold {
  kind: RouteHoldKind;
  targetId: string;
  requiredPosition: 'normal' | 'reverse' | null;
  releaseAfterIndex: number;
  released: boolean;
}

export interface RouteReservation {
  id: string;
  layoutId: string;
  locoAddress: number;
  authority: 'manual' | 'auto';
  status: RouteStatus;
  path: RoutePathStep[];
  holds: RouteHold[];
  confirmedIndex: number;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `PathBlocker` in the backend's `domain/types.ts` (#4). */
export type PathBlocker =
  | { kind: 'block-not-clear'; blockId: string; occupancy: Occupancy }
  | { kind: 'block-locked'; blockId: string; heldBy: string }
  | { kind: 'point-locked'; pointId: string; heldBy: string }
  | { kind: 'returns-to-start'; blockId: string };

/**
 * Mirrors `RouteRejection`. Only `kind` is read structurally by the UI — the
 * server also sends a rendered `error` string alongside, which is what gets
 * displayed, so this exists for the cases the panel highlights specifically
 * rather than to re-implement `describeRejections` in the browser.
 */
export interface RouteRejection {
  kind: string;
  [field: string]: unknown;
}

/** Wire projection of the backend's `RouteFault` (#4). `faultedAt` is ISO 8601. */
export interface RouteFaultView {
  routeId: string;
  kind: 'unexpected-occupancy' | 'occupancy-unknown' | 'point-command-rejected';
  reason: string;
  blockId: string | null;
  locoAddress: number;
  faultedAt: string;
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

/**
 * Mirrors `TILE_TYPES` in the backend's `domain/types.ts`, which is
 * authoritative and, since #70, the closed set the write path validates
 * against. A value absent here is a 400, not a tile.
 *
 * `'empty'` was removed in #70: the absence of a tile is expressed by DELETE,
 * not by a persisted row claiming to be nothing — such a row rendered as
 * nothing (`TilePath`'s `default`) while still occupying its cell and still
 * blocking placement. The legacy `straight-v` and named `curve-*` entries stay
 * because they are in already-authored grids and must keep round-tripping.
 */
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
  | 'crossing';     // ╋

/** Mirrors `TILE_ROTATIONS` — the eight 45° steps the editor authors. */
export type TileRotation = 0 | 45 | 90 | 135 | 180 | 225 | 270 | 315;

/**
 * Mirrors the backend's `GridTileMetadata`. Closed: the write path rejects an
 * unknown key, so a field added here without its backend counterpart is a 400
 * at runtime rather than a silently dropped write.
 */
export interface GridTileMetadata {
  rotation?: TileRotation;
  blockId?: string;
  pointId?: string;
}

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
  routes: Record<string, RouteReservation>;
  /** #34: current per-sensor faults, always the complete set, never a delta. */
  sensorFaults: SensorFaultView[];
  /** #4: current latched route faults, likewise always the complete set. */
  routeFaults: RouteFaultView[];
}

// ─── Server → Client messages ─────────────────────────────────────────────────

export type ServerMessage =
  | { type: 'STATE_SNAPSHOT'; payload: StateSnapshot }
  | { type: 'BLOCK_STATE'; payload: BlockState }
  | { type: 'POINT_STATE'; payload: PointState }
  | { type: 'LOCO_STATE'; payload: LocoState }
  | { type: 'SYSTEM_STATUS'; payload: { status: SystemStatus; mode: SystemMode; reason: string | null } }
  | { type: 'SENSOR_FAULTS'; payload: { faults: SensorFaultView[] } }
  | { type: 'ROUTE_STATE'; payload: RouteReservation }
  | { type: 'ROUTE_FAULTS'; payload: { faults: RouteFaultView[] } }
  | { type: 'ERROR'; payload: { message: string; details?: unknown } };

// ─── Client → Server messages ─────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'THROTTLE_COMMAND'; payload: { locoAddress: number; speed: number; direction: Direction } }
  | { type: 'POINT_COMMAND'; payload: { pointId: string; position: 'normal' | 'reverse'; force?: boolean } }
  | { type: 'FUNCTION_COMMAND'; payload: { locoAddress: number; fn: number; state: boolean } }
  | { type: 'SET_MODE'; payload: { mode: SystemMode } }
  | { type: 'EMERGENCY_STOP' };
