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

/** Mirrors `TILE_EDGES` — the eight edges of a tile in its own **unrotated** frame (#73). */
export type TileEdge = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

/** Mirrors `ANNOTATION_ENTITY_TYPES`. A discriminator, not a convenience: an id alone cannot be resolved back to a table. */
export type AnnotationEntityType = 'sensor';

/**
 * Mirrors `TileAnnotation` (#74). "An entity of type T with id X sits at this
 * tile" — presentational placement, deliberately generic so signals (#79) and
 * RFID readers (#39) need no second mechanism. Nothing may assume an
 * annotation is an IR sensor.
 */
export interface TileAnnotation {
  entityType: AnnotationEntityType;
  entityId: string;
  /** Cosmetic only: which way a beam points on the diagram. The system models no detection direction. */
  orientation?: TileRotation;
}

/**
 * Mirrors `TilePointRoad` (#73). Which drawn legs are joined when a set of
 * points stands in a set of positions.
 *
 * `when` is a list and `legs` is a pair, both so three-way points and slips
 * are not foreclosed (#83) — a slip is one piece of track carrying two
 * independently switched mechanisms.
 */
export interface TilePointRoad {
  when: Array<{ pointId: string; position: 'normal' | 'reverse' }>;
  legs: [TileEdge, TileEdge];
}

/**
 * Mirrors the backend's `GridTileMetadata`. Closed: the write path rejects an
 * unknown key, so a field added here without its backend counterpart is a 400
 * at runtime rather than a silently dropped write.
 */
export interface GridTileMetadata {
  rotation?: TileRotation;
  blockId?: string;
  pointId?: string;
  /** #71 — the positive assertion "deliberately not part of any block". Mutually exclusive with `blockId`. */
  trackRole?: 'decorative';
  annotations?: TileAnnotation[];
  pointRoads?: TilePointRoad[];
}

/**
 * The three-way classification of a tile (#71), derived rather than stored.
 *
 * "Untagged" cannot be an error — the Westgate Hollow entry feeder is plain
 * track the system neither detects nor reserves, and warning on it would light
 * up the whole run. But a tile that *should* have been tagged and was not is
 * silently invisible to live state. Both used to be the same absent key.
 */
export type TileClassification = 'block' | 'decorative' | 'unclassified';

export function classifyTile(metadata: GridTileMetadata): TileClassification {
  if (metadata.blockId !== undefined) return 'block';
  if (metadata.trackRole === 'decorative') return 'decorative';
  return 'unclassified';
}

// ─── Block ends (#72) ─────────────────────────────────────────────────────────

/**
 * A named opening of a block, plus where it currently sits on the drawing.
 *
 * `pinned` means authored — either set by hand or adopted because an edge
 * already referenced the label. Regeneration never touches a pinned end, which
 * is what stops a redraw from silently renaming the thing every edge depends
 * on.
 *
 * `geometry: null` means the drawing has no opening by that name any more.
 * For an end edges reference, that is a real mismatch worth showing.
 */
export interface BlockEndView {
  id: string;
  layoutId: string;
  blockId: string;
  label: string;
  pinned: boolean;
  geometry: { x: number; y: number; terminated: boolean } | null;
}

export interface GenerateEndsSummary {
  adopted: Array<{ blockId: string; label: string }>;
  created: Array<{ blockId: string; label: string }>;
  removed: Array<{ blockId: string; label: string }>;
  collisions: Array<{ blockId: string; label: string; at: Array<{ x: number; y: number }> }>;
}

// ─── Edge proposals (#78) ─────────────────────────────────────────────────────

/**
 * Mirrors `EdgeProposalStatus`. Only `new` is acceptable; the other three each
 * mean something different about *why* not, and the panel says which.
 */
export type EdgeProposalStatus = 'new' | 'needs-end-label' | 'existing' | 'conflicting';

/**
 * Mirrors the backend's `EdgeProposal` — a candidate `block_edges` row the
 * drawing implies, never a written one.
 *
 * `lengthMm` is the literal `null` here as it is there: geometry can never
 * supply distance (`docs/braking.md` B4), and typing it as `number | null`
 * would invite a later change to compute one from tile count.
 */
export interface EdgeProposal {
  /** Stable within one response; pairs the two directions of one physical connection. */
  pairId: string;
  fromBlockId: string;
  /** `null` when no `block_ends` row names this opening. Never a guessed label. */
  fromEnd: string | null;
  toBlockId: string;
  toEnd: string | null;
  pointConditions: PointCondition[];
  lengthMm: null;
  /** Cells crossed between the two blocks, in walk order. */
  via: Array<{ x: number; y: number }>;
  /** The path crosses a plain diamond, whose route conflicts are not detected (#26). */
  crossesDiamond: boolean;
  status: EdgeProposalStatus;
  existingEdgeId?: string;
}

/**
 * Mirrors `ProposalNote`. Why a connection that looks drawn produced no
 * proposal — each names a cell to go and look at, which is the whole
 * difference between a to-do and a mystery.
 */
export type ProposalNote =
  | { kind: 'blocked-by-unclassified'; at: { x: number; y: number } }
  | { kind: 'blocked-by-unmapped-point'; at: { x: number; y: number }; pointId: string }
  | { kind: 'stopped-in-own-block'; blockId: string; at: { x: number; y: number } }
  | { kind: 'leg-not-covered-by-road'; at: { x: number; y: number }; edge: TileEdge }
  | {
      kind: 'no-road-out-of-block';
      at: { x: number; y: number };
      blockId: string;
      edge: TileEdge;
    }
  | { kind: 'search-truncated'; blockId: string; at: { x: number; y: number } };

export interface EdgeProposalReport {
  proposals: EdgeProposal[];
  notes: ProposalNote[];
}

// ─── Grid diagnostics ─────────────────────────────────────────────────────────

/**
 * Mirrors `GridDiagnostic`. Advisory only — nothing here refuses a write.
 *
 * `warning` means two representations disagree, or a known hazard is drawn.
 * `info` means authoring is unfinished, which is a normal state for a layout
 * being built and must not be styled as an error.
 */
export type GridDiagnostic =
  | { kind: 'unclassified-tile'; severity: 'info'; at: { x: number; y: number } }
  | { kind: 'tile-metadata-unreadable'; severity: 'warning'; at: { x: number; y: number } }
  | {
      kind: 'dangling-tile-reference';
      severity: 'warning';
      at: { x: number; y: number };
      refKind: 'block' | 'point' | 'sensor';
      recordId: string;
    }
  | {
      kind: 'point-tile-unmapped';
      severity: 'info';
      at: { x: number; y: number };
      pointId: string;
    }
  | {
      kind: 'duplicate-annotation';
      severity: 'warning';
      entityType: AnnotationEntityType;
      entityId: string;
      at: Array<{ x: number; y: number }>;
    }
  | { kind: 'diamond-blind-spot'; severity: 'warning'; at: { x: number; y: number } }
  | {
      kind: 'track-not-joined';
      severity: 'warning';
      at: { x: number; y: number };
      edge: TileEdge;
      against: { x: number; y: number };
    }
  | {
      kind: 'buffer-contradicted-by-edge';
      severity: 'warning';
      blockId: string;
      label: string;
      edgeIds: string[];
    }
  | {
      kind: 'end-unfinished';
      severity: 'info';
      blockId: string;
      label: string;
      at: { x: number; y: number };
    }
  | { kind: 'end-not-on-diagram'; severity: 'warning'; blockId: string; label: string }
  | { kind: 'pinned-end-not-on-diagram'; severity: 'info'; blockId: string; label: string }
  | {
      kind: 'end-label-collision';
      severity: 'warning';
      blockId: string;
      label: string;
      at: Array<{ x: number; y: number }>;
    }
  | { kind: 'block-without-detection'; severity: 'info'; blockId: string };

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
