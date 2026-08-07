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

export type UserId = string;
export type SessionId = string;

export type BlockEdgeId = string;
/**
 * A named physical opening of a block ('north', 'yard-3', ...).
 * Labels are arbitrary but must be used consistently for a given block.
 * A non-reversing movement must leave a block via an end different from
 * the one it entered by.
 */
export type BlockEndLabel = string;

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

/** Operator account role. 'admin' may edit topology and config; 'operator' may drive. */
export type Role = 'admin' | 'operator';

// ─── Track Topology ───────────────────────────────────────────────────────────

/**
 * A point that must be at a specific position for an edge to be traversable.
 * `requiredPosition` deliberately excludes 'unknown' — you cannot require
 * uncertainty. An actual position of 'unknown' never satisfies a condition.
 */
export interface PointCondition {
  pointId: PointId;
  requiredPosition: 'normal' | 'reverse';
}

/**
 * A directed connection from one block to another.
 * A bidirectional physical connection is represented as two edges.
 * Edge direction is geometric and unrelated to loco `Direction`.
 */
export interface BlockEdge {
  id: BlockEdgeId;
  layoutId: LayoutId;
  fromBlockId: BlockId;
  /** End of `fromBlockId` this edge leaves by. */
  fromEnd: BlockEndLabel;
  toBlockId: BlockId;
  /** End of `toBlockId` this edge arrives at. */
  toEnd: BlockEndLabel;
  /**
   * All conditions must hold for the edge to be traversable.
   * Empty means plain track with no point gating.
   */
  pointConditions: PointCondition[];
  /** Physical length in millimetres. `null` means unmeasured — treat as unsafe for automated braking. */
  lengthMm: number | null;
}

/**
 * A specific way in which a set of `BlockEdge`s fails to describe a coherent
 * track graph. `validateTopology`/`validateEdgeAgainstLayout` in `./topology`
 * return these; `isFatalViolation` in the same module decides whether a given
 * kind blocks graph construction or is merely degraded (see `unknown-point`).
 */
export type TopologyViolation =
  | {
      kind: 'layout-mismatch';
      edgeId: BlockEdgeId;
      expectedLayoutId: LayoutId;
      actualLayoutId: LayoutId;
    }
  | { kind: 'duplicate-edge-id'; edgeId: BlockEdgeId }
  | { kind: 'self-loop'; edgeId: BlockEdgeId; blockId: BlockId }
  | { kind: 'unknown-block'; edgeId: BlockEdgeId; blockId: BlockId }
  | { kind: 'unknown-point'; edgeId: BlockEdgeId; pointId: PointId }
  | { kind: 'duplicate-connection'; edgeId: BlockEdgeId; conflictingEdgeId: BlockEdgeId };

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
  routes: Map<RouteId, RouteReservation>;
}

// ─── Route Reservations (see docs/route-locking.md) ───────────────────────────

/**
 * Lifecycle of a `RouteReservation`. 'active' holds live locks under normal
 * operation; 'suspended' also holds locks but forbids driving (Safe-Stop, or
 * `systemMode === 'manual'` suspending auto-authority routes — D7/D8);
 * 'released' and 'cancelled' hold nothing and are terminal.
 */
export type RouteStatus = 'active' | 'suspended' | 'released' | 'cancelled';

/** What kind of entity a `RouteHold` exclusively reserves. See D1: edges are
 * recorded as route membership, not a third lock namespace — an edge hold
 * exists so the topology write-guard and #6's braking model can find it, not
 * because edges are independently exclusive. */
export type RouteHoldKind = 'block' | 'point' | 'edge';

/**
 * One block in an ordered route path. `edgeId`/`entryEnd` are null only for
 * step 0 (the starting block, entered by no edge in this route); `exitEnd` is
 * null only for the final step (the route ends there, no edge leaves it).
 */
export interface RoutePathStep {
  edgeId: BlockEdgeId | null;
  blockId: BlockId;
  entryEnd: BlockEndLabel | null;
  exitEnd: BlockEndLabel | null;
}

/**
 * An exclusive hold a `RouteReservation` places on one block, point, or edge.
 * `requiredPosition` is set only for a `point` hold — the position the route
 * needs the point locked at, per its `pointConditions`. `releaseAfterIndex`
 * is the `RoutePathStep` index this hold sits "behind": it is eligible for
 * release once the route's `confirmedIndex` moves strictly past it (see
 * `holdsReleasableAt`). A block hold ALSO requires the block to have gone
 * `occupied` -> `clear` before it actually releases (D5's two-condition
 * rule); a point or edge hold releases on the index condition alone.
 */
export interface RouteHold {
  kind: RouteHoldKind;
  targetId: string;
  requiredPosition: 'normal' | 'reverse' | null;
  releaseAfterIndex: number;
  released: boolean;
}

/**
 * The authoritative record of what a route holds (D1). `BlockState.lockedByRoute`
 * / `PointState.lockedByRoute` are a projection of this, maintained by the
 * same code path (`ReservationService`) — never written independently.
 */
export interface RouteReservation {
  id: RouteId;
  layoutId: LayoutId;
  locoAddress: LocoAddress;
  /** Who drives this route once granted — does not affect whether it can be
   * granted (D7); governs what a manual throttle/force-point command does. */
  authority: Authority;
  status: RouteStatus;
  path: RoutePathStep[];
  holds: RouteHold[];
  /** Index into `path` of the last block the train has been confirmed in. */
  confirmedIndex: number;
  /** Safe-Stop reason, restart-recovery reason, or cancel reason — null while `active`. */
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Every reason `planReservation` (see `domain/routeLocking.ts`) may refuse a
 * grant. A rejected grant returns every applicable member of this union, not
 * just the first found (D14) — matching `validateTopology`'s posture.
 */
export type RouteRejection =
  | { kind: 'system-not-online'; status: SystemStatus }
  | { kind: 'empty-path' }
  | { kind: 'unknown-edge'; edgeId: BlockEdgeId }
  | { kind: 'path-not-connected'; index: number }
  | { kind: 'reversal-at-block'; blockId: BlockId }
  | { kind: 'start-block-not-occupied'; blockId: BlockId; occupancy: Occupancy }
  | { kind: 'start-block-holds-other-loco'; blockId: BlockId; locoAddress: LocoAddress }
  | { kind: 'block-not-clear'; blockId: BlockId; occupancy: Occupancy }
  | { kind: 'block-locked'; blockId: BlockId; heldBy: RouteId }
  | { kind: 'point-locked'; pointId: PointId; heldBy: RouteId }
  | { kind: 'point-position-conflict'; pointId: PointId }
  | { kind: 'loco-already-routed'; locoAddress: LocoAddress; routeId: RouteId }
  | { kind: 'unknown-loco'; locoAddress: LocoAddress }
  | { kind: 'no-graph' };

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
  | { type: 'ROUTE_STATE'; payload: RouteReservation }
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
