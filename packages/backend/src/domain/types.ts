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

// ─── Users (see docs/auth.md) ──────────────────────────────────────────────────

/**
 * API-facing view of a `users` row (issue #53). Deliberately excludes
 * `passwordHash` — that never leaves `AuthService`, matching the posture of
 * `SensorFaultView`/`RouteFaultView` stripping runtime-only fields.
 */
export interface UserView {
  id: UserId;
  username: string;
  role: Role;
  createdAt: Date;
  /** Derived: `passwordHash !== null`. Distinguishes a future WebAuthn-only account. */
  hasPassword: boolean;
}

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

// ─── Sensors (see docs/sensor-fault-recovery.md) ──────────────────────────────

/**
 * `block_detection` is a whole-block current-sensing detector; `ir_position`
 * is a beam at one specific spot. They are not interchangeable evidence — a
 * detector's reading governs its block outright, an IR sensor may only ever
 * raise occupancy, never lower it (D3, `domain/occupancy.ts`).
 */
export type SensorType = 'block_detection' | 'ir_position';

/**
 * One sensor's latest contribution to its block's derived occupancy.
 * Runtime state, held in `LayoutRuntimeState.sensors` — never persisted;
 * rebuilt from `sensors.in_service` and readings on each startup, same
 * posture as blocks/points.
 */
export interface SensorObservation {
  sensorId: SensorId;
  blockId: BlockId | null;
  type: SensorType;
  /** Mirror of `sensors.in_service`. An out-of-service sensor contributes nothing. */
  inService: boolean;
  /** Latched by a malformed payload; cleared only by acknowledge or out-of-service. */
  faulted: boolean;
  /** Latest validated reading, or null (never read, faulted, or de-serviced). */
  lastReading: 'occupied' | 'clear' | null;
  lastReadingAt: Date | null;
}

/**
 * A latched fault on one sensor (D2). `reason`/`faultedAt` are the FIRST
 * cause and do not move on a re-fault (DD5) — only `consecutiveValidReadings`
 * resets. Held in `SystemHealth.sensorFaults`, keyed by `sensorId`.
 */
export interface SensorFault {
  sensorId: SensorId;
  reason: string;
  topic: string;
  faultedAt: Date;
  /** Consecutive valid, non-retained readings since the fault (or the last malformed one) — D1's arming counter. */
  consecutiveValidReadings: number;
}

/** Wire projection of `SensorFault` (DD10). Dates as ISO 8601; `armed`/`requiredValidReadings` precomputed by `toSensorFaultView`. */
export interface SensorFaultView {
  sensorId: SensorId;
  reason: string;
  topic: string;
  faultedAt: string;
  consecutiveValidReadings: number;
  requiredValidReadings: number;
  armed: boolean;
}

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
  /**
   * DCC speed step 0–126. Commanded, never confirmed — there is no loco
   * feedback channel (docs/braking.md B7).
   */
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
  /** Per-sensor observations feeding block occupancy derivation (D3). Diagnostic runtime state — deliberately not part of the WebSocket snapshot (DD10). */
  sensors: Map<SensorId, SensorObservation>;
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
  | { kind: 'no-graph' }
  // ── Pathfinding (#4, see docs/pathfinding.md) ──
  // Produced by `ReservationService` before `planReservation` runs, when a
  // request named a destination rather than an explicit edge list and the
  // search could not produce one. Deliberately part of the same union: an
  // operator asking for a route gets one rejection list, whether the refusal
  // came from the search or from the planner.
  | { kind: 'unknown-block'; blockId: BlockId }
  | { kind: 'destination-is-start'; blockId: BlockId }
  | { kind: 'no-path'; destinationBlockId: BlockId; blockers: PathBlocker[] }
  // ── Setting the road (#4) ──
  // Not a planning refusal at all: the route WAS granted, its locks were
  // committed, and a point command was then rejected by the DCC adapter.
  // `LayoutService` cancels the route and Safe-Stops, and reports the
  // request as refused, because nothing the operator asked for took effect.
  | { kind: 'point-command-rejected'; pointId: PointId; requiredPosition: 'normal' | 'reverse'; reason: string };

/**
 * Why the pathfinder could not use a particular edge. Collected during the
 * search and reported alongside a `no-path` rejection so an operator is told
 * *what is in the way* ("block 4 is occupied") rather than a bare "no route".
 * Diagnostic, not exhaustive: an edge is reported against the first reason it
 * failed, and the list is capped (see `MAX_REPORTED_BLOCKERS`).
 */
export type PathBlocker =
  | { kind: 'block-not-clear'; blockId: BlockId; occupancy: Occupancy }
  | { kind: 'block-locked'; blockId: BlockId; heldBy: RouteId }
  | { kind: 'point-locked'; pointId: PointId; heldBy: RouteId }
  | { kind: 'returns-to-start'; blockId: BlockId };

// ─── Route Faults (#4, see docs/pathfinding.md) ───────────────────────────────

/**
 * Why a route lost the certainty it was granted under. Each one is a
 * Safe-Stop trigger:
 *  - 'unexpected-occupancy' — a reserved block read `occupied` that was not
 *    the route's next expected step (D7). The route is cancelled.
 *  - 'occupancy-unknown'    — a reserved block stopped being determinable
 *    mid-route. The route is suspended, locks retained (D8).
 *  - 'point-command-rejected' — the DCC adapter refused a point command while
 *    setting the road. The route is cancelled; some points may already have
 *    moved, which is precisely why this is a Safe-Stop and not a retry.
 */
export type RouteFaultKind = 'unexpected-occupancy' | 'occupancy-unknown' | 'point-command-rejected';

/**
 * A latched fault against one route. Keyed by `routeId` in
 * `SystemHealth.routeFaults` for the same reason `sensorFaults` is keyed by
 * sensor (docs/sensor-fault-recovery.md D2): acknowledging the fault an
 * operator can see must never silently clear one they were never told about.
 *
 * Latched — nothing clears an entry automatically. Before #4, a route
 * violation called `enterSafeStop` directly, outside `SystemHealth`, so the
 * next unrelated health evaluation cleared the Safe-Stop it had caused.
 */
export interface RouteFault {
  routeId: RouteId;
  kind: RouteFaultKind;
  reason: string;
  /** The block whose occupancy caused this, for the two occupancy kinds. */
  blockId: BlockId | null;
  locoAddress: LocoAddress;
  faultedAt: Date;
}

/** Wire projection of `RouteFault`, mirroring `SensorFaultView`. Dates as ISO 8601. */
export interface RouteFaultView {
  routeId: RouteId;
  kind: RouteFaultKind;
  reason: string;
  blockId: BlockId | null;
  locoAddress: LocoAddress;
  faultedAt: string;
}

// ─── Braking (see docs/braking.md) ─────────────────────────────────────────────

/**
 * One loco's braking-relevant roster data, as `BrakingService` builds it from
 * `ILayoutRepository.LocoRecord` before handing it to a `StoppingDistanceModel`.
 */
export interface BrakingProfile {
  locoAddress: LocoAddress;
  maxSpeed: number;
  /** Dimensionless braking effectiveness 0.0–1.0 (B1). NOT a distance, NOT a rate. */
  brakingFactor: number;
}

/** One command in a `BrakingSchedule` (B3). */
export interface BrakingStep {
  /** ms after the first step. The first step is always 0. */
  atOffsetMs: number;
  speedStep: number;
  direction: Direction;
}

/**
 * A pure, timer-free plan produced by `domain/braking.ts#planBrakingSchedule`
 * (B3). `LayoutService` (PR B) is what executes it against an `IClock`.
 */
export interface BrakingSchedule {
  locoAddress: LocoAddress;
  steps: BrakingStep[];
  /** What the model predicts (B1). Never confirmed (B7). */
  estimatedStoppingDistanceMm: number;
  /** estimate + margin (B5). */
  requiredDistanceMm: number;
  totalDurationMs: number;
}

/** Why a `StoppingDistanceModel` could not produce an estimate. */
export type BrakingModelFault =
  | { kind: 'invalid-braking-factor'; brakingFactor: number }
  | { kind: 'invalid-max-speed'; maxSpeed: number }
  | { kind: 'invalid-speed-step'; commandedSpeedStep: number }
  | { kind: 'speed-exceeds-max'; commandedSpeedStep: number; maxSpeed: number }
  | { kind: 'speed-direction-mismatch'; commandedSpeedStep: number; direction: Direction };

/**
 * Every reason a braking plan may be refused. Following the `RouteRejection`
 * precedent (`docs/pathfinding.md` P6), this deliberately mixes domain- and
 * service-produced kinds so callers see one refusal vocabulary regardless of
 * which layer detected the problem.
 */
export type BrakingRefusal =
  | { kind: 'model-unavailable'; fault: BrakingModelFault }
  | { kind: 'already-stopped'; locoAddress: LocoAddress }
  | { kind: 'insufficient-distance'; requiredMm: number; availableMm: number }
  | { kind: 'unmeasured-track'; edgeId: BlockEdgeId }
  | { kind: 'unknown-edge'; edgeId: BlockEdgeId }
  | { kind: 'target-behind-train'; targetIndex: number; confirmedIndex: number }
  | { kind: 'unknown-loco'; locoAddress: LocoAddress }
  | { kind: 'ambiguous-loco'; locoAddress: LocoAddress; count: number }
  | { kind: 'unknown-loco-state'; locoAddress: LocoAddress }
  | { kind: 'system-not-online'; status: SystemStatus }
  | { kind: 'auto-not-permitted'; status: SystemStatus; mode: SystemMode }
  | { kind: 'manual-authority'; routeId: RouteId }
  | { kind: 'route-not-active'; routeId: RouteId; status: RouteStatus }
  | { kind: 'command-rejected'; message: string };

/**
 * A latched fault against one loco's braking run (B10), keyed by
 * `locoAddress` in `SystemHealth.brakingFaults` — same posture as
 * `SensorFault`/`RouteFault`. `speed-command-rejected` is a `setSpeed`
 * rejection mid-ramp (B6); `overrun` is B5's armed-expectation check firing.
 */
export type BrakingFaultKind = 'speed-command-rejected' | 'overrun';

export interface BrakingFault {
  locoAddress: LocoAddress;
  kind: BrakingFaultKind;
  reason: string;
  routeId: RouteId | null;
  blockId: BlockId | null;
  faultedAt: Date;
}

/** Wire projection of `BrakingFault`, mirroring `SensorFaultView`/`RouteFaultView`. Dates as ISO 8601. */
export interface BrakingFaultView {
  locoAddress: LocoAddress;
  kind: BrakingFaultKind;
  reason: string;
  routeId: RouteId | null;
  blockId: BlockId | null;
  faultedAt: string;
}

/**
 * Blocks a braking run has told its train not to reach (B5). A snapshot
 * taken at run start, not a live query — the overrun check needs no
 * reservation lookup and cannot race the release path in `recomputeBlock`.
 */
export interface BrakingStopExpectation {
  locoAddress: LocoAddress;
  routeId: RouteId;
  targetIndex: number;
  forbiddenBlockIds: BlockId[];
}

// ─── Naming (see docs/naming.md) ───────────────────────────────────────────────

/**
 * Id → display-name lookup used to render operator-facing strings
 * (`domain/naming.ts`'s `label`/`*Label` helpers) instead of a bare UUID.
 * Passed as data to every `describe*` function — never a port or a service,
 * so the domain stays dependency-free. Values are pre-truncated to
 * `MAX_LABEL_CHARS` at build time (see `services/nameBook.ts#buildNameBook`).
 */
export interface NameBook {
  layouts: ReadonlyMap<LayoutId, string>;
  blocks: ReadonlyMap<BlockId, string>;
  points: ReadonlyMap<PointId, string>;
  sensors: ReadonlyMap<SensorId, string>;
  locos: ReadonlyMap<LocoAddress, string>;
  /** Derived labels ("Down Platform:north → Up Loop:south"), not names —
   * `block_edges` has no name column. See docs/naming.md. */
  edges: ReadonlyMap<BlockEdgeId, string>;
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
  | { type: 'ROUTE_STATE'; payload: RouteReservation }
  | {
      type: 'SYSTEM_STATUS';
      payload: { status: SystemStatus; mode: SystemMode; reason: string | null };
    }
  | { type: 'SENSOR_FAULTS'; payload: { faults: SensorFaultView[] } }
  | { type: 'ROUTE_FAULTS'; payload: { faults: RouteFaultView[] } }
  | { type: 'BRAKING_FAULTS'; payload: { faults: BrakingFaultView[] } };

// ─── WebSocket Message Shapes ─────────────────────────────────────────────────

/** Messages sent FROM the frontend TO the backend over WebSocket. */
export type ClientMessage =
  | { type: 'THROTTLE_COMMAND'; payload: ThrottleCommand }
  | { type: 'POINT_COMMAND'; payload: PointCommand }
  | { type: 'FUNCTION_COMMAND'; payload: FunctionCommand }
  | { type: 'SET_MODE'; payload: SetModeCommand }
  | { type: 'EMERGENCY_STOP' };
