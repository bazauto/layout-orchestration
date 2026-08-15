/**
 * Shared types mirroring the backend domain — kept in sync manually.
 * In a future phase these could be generated from a shared package.
 */

export type Occupancy = 'occupied' | 'clear' | 'unknown';
export type PointPosition = 'normal' | 'reverse' | 'unknown';
export type Direction = 'fwd' | 'rev' | 'stop';
export type SystemStatus = 'online' | 'safe-stop' | 'offline';
export type SystemMode = 'manual' | 'auto' | 'hybrid';

/**
 * Operator account role. 'admin' may edit topology and config; 'operator' may
 * drive; 'monitor' (#63) is situational awareness only — no authority to move
 * anything. See `docs/auth.md` "Roles".
 */
export type Role = 'admin' | 'operator' | 'monitor';

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
  /**
   * Measured length in mm, or `null` for unmeasured — which **refuses** an
   * automated braked run rather than guessing (`docs/braking.md` B4). Distance
   * is on the block, not the edge (D4, `docs/track-graph-compilation.md`).
   */
  lengthMm: number | null;
}

export interface PointRecord {
  id: string;
  layoutId: string;
  name: string;
  dccAddress: number;
  blockId: string | null;
  /**
   * Mirrors `points.position_feedback` (#25). Configuration, not runtime
   * state: `'required'` means the backend refuses to trust this point's
   * commanded position until its controller confirms it, `'none'` means it
   * trusts the command as it always did. The runtime counterpart is
   * `PointState.positionFeedback`.
   */
  positionFeedback: PointFeedbackMode;
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
  /**
   * Where the live graph stands against the drawing it was compiled from
   * (#103). Optional because the field is newer than this type and a cached
   * response may not carry it — never because it is unimportant.
   */
  compiled?: CompiledGraphStatus;
}

/**
 * Mirrors `CompiledGraphStatus` in the backend's `services/CompileService.ts`.
 *
 * `stale` is a **warning, never a gate** — gating on it would stop an operator
 * moving a platform tile. `gapCount` is the one that gates, and it gates
 * `SystemMode: auto`, not any authoring action.
 */
export interface CompiledGraphStatus {
  compiledAt: string | null;
  compiledFingerprint: string | null;
  drawingFingerprint: string;
  stale: boolean;
  gapCount: number;
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

/*
 * `BlockEndView` and `GenerateEndsSummary` were here. Nothing on the client
 * reads `block_ends` any more: `Ends ⟳` and `Ends ✎` are gone (#103 PR 6.2),
 * and opening names come from `CompiledOpening` above, compiled from the
 * drawing on every read rather than stored and reconciled.
 *
 * The table and its routes still exist on the backend and are deleted in PR 7.
 */

// ─── Compiling the graph from the drawing (#103) ──────────────────────────────

/**
 * Mirrors `NamedCompiledEdge` — one directed connection the drawing implies.
 *
 * No `id` and no `lengthMm`. It is a candidate, not a row, and distance lives
 * on `blocks.length_mm` where an operator measured it (D4); there is no field
 * here for geometry to guess into.
 *
 * `via` and `crossesDiamond` are review aids and are never persisted: `via`
 * lets the operator find the connection on the drawing, `crossesDiamond` says
 * the path runs through the #26 blind spot.
 */
export interface CompiledEdge {
  fromBlockId: string;
  fromEnd: string;
  toBlockId: string;
  toEnd: string;
  pointConditions: PointCondition[];
  via: Array<{ x: number; y: number }>;
  crossesDiamond: boolean;
}

/**
 * Mirrors `CompileGap` — something the compiler is **not confident about**,
 * recorded outside the graph rather than inside it wearing a badge (D6).
 *
 * The first three are D7's graph-level assertions and are the primary
 * findings; the rest are per-cell walk notes carried through as supporting
 * evidence. `diagram/compile.ts#gapRank` is what keeps that order on screen.
 */
export type CompileGap =
  | { kind: 'block-not-in-graph'; blockId: string }
  | { kind: 'block-without-detection'; blockId: string }
  | { kind: 'opening-unresolved'; blockId: string; label: string; at: { x: number; y: number } }
  | { kind: 'dangling-block-reference'; at: { x: number; y: number }; blockId: string }
  | { kind: 'tile-metadata-unreadable'; at: { x: number; y: number } }
  | { kind: 'opening-unnamed'; blockId: string; at: { x: number; y: number } }
  | { kind: 'blocked-by-unclassified'; at: { x: number; y: number } }
  | { kind: 'blocked-by-unmapped-point'; at: { x: number; y: number }; pointId: string }
  | { kind: 'leg-not-covered-by-road'; at: { x: number; y: number }; edge: TileEdge }
  | {
      kind: 'no-road-out-of-block';
      at: { x: number; y: number };
      blockId: string;
      edge: TileEdge;
    }
  | { kind: 'search-truncated'; blockId: string; at: { x: number; y: number } };

/** Mirrors `CompileReport`. `components.length > 1` is reported, never gated (D-B). */
export interface CompileReport {
  fingerprint: string;
  edges: CompiledEdge[];
  gaps: CompileGap[];
  components: string[][];
}

/**
 * Mirrors `CompileDiff` — how the candidate graph differs from the live one,
 * matched in two passes (D-J).
 *
 * `changed` is the safety-relevant bucket: the same two openings, now needing
 * different blades. `relabelled` is the same physical connection under a new
 * disposable name, and exists so a redraw that renumbers ends does not read as
 * "every edge removed, every edge added" — which would make the diff useless
 * for review, and review is the whole safety argument for compiling (D1).
 */
export interface CompileDiff {
  added: CompiledEdge[];
  removed: BlockEdgeRecord[];
  unchanged: BlockEdgeRecord[];
  changed: Array<{ live: BlockEdgeRecord; proposed: CompiledEdge }>;
  relabelled: Array<{ live: BlockEdgeRecord; proposed: CompiledEdge }>;
}

/** Mirrors `CompileView` — the whole body of `GET .../topology/compile`. */
export interface CompileView {
  report: CompileReport;
  status: CompiledGraphStatus;
  diff: CompileDiff;
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
  /**
   * The only end-related diagnostic left (#103 PR 7). `end-unfinished`,
   * `end-not-on-diagram`, `pinned-end-not-on-diagram` and
   * `end-label-collision` were all findings about a stored `block_ends` row and
   * cannot occur now; `block-without-detection` moved to the compile gaps,
   * where it gates `auto` instead of merely advising.
   */
  | {
      kind: 'buffer-contradicted-by-edge';
      severity: 'warning';
      blockId: string;
      label: string;
      edgeIds: string[];
    };

// ─── Compiled openings (#103, D-H) ─────────────────────────────────────────────

/**
 * Mirrors `tileGeometry.ts`'s `Port`. One place drawn track crosses a tile
 * boundary. `edge` is already in the **rotated (screen)** frame — do not
 * apply a tile's `metadata.rotation` to it a second time.
 */
export interface Port {
  x: number;
  y: number;
  edge: TileEdge;
}

/**
 * Mirrors the backend's `CompiledOpening` — pure geometry, disposable compiler
 * output (D8). Read via `GET .../grid/openings` on every stroke end, the way
 * `grid/diagnostics` already is.
 */
export interface CompiledOpening {
  blockId: string;
  /** 8-point cardinal, suffixed `-1`…`-n` when a block has several facing the same way. */
  label: string;
  /** A tile of the block, where the label may be drawn. */
  at: { x: number; y: number };
  terminated: boolean;
  /** The tile boundaries this opening covers. Empty for a buffer's closed side. */
  ports: Port[];
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

/**
 * Mirrors the backend's `PointConfirmation` (#25, docs/point-feedback.md D3):
 * `'unreported'` — no reading has ever landed; `'pending'` — a command is
 * outstanding, a confirmation deadline is running; `'confirmed'` — the last
 * reading matched what was commanded (or nothing was commanded to disagree
 * with); `'mismatch'` — a well-formed reading that did NOT match what was
 * commanded, `confirmedPosition` holding the reported value; `'indeterminate'`
 * — the last reading reported `'unknown'`, or was `'driver'`-sourced on a
 * `'required'` point; `'timed-out'` — the confirmation deadline elapsed with
 * no reading.
 */
export type PointConfirmation = 'unreported' | 'pending' | 'confirmed' | 'mismatch' | 'indeterminate' | 'timed-out';

/**
 * Mirrors `PointFeedbackMode` — whether a point is configured to require a
 * confirmed reading before its position is trusted (D10). Opt-in per point,
 * defaulting to `'none'`.
 */
export type PointFeedbackMode = 'none' | 'required';

/**
 * Mirrors the backend's `PointState` (#25, docs/point-feedback.md D3). The
 * pre-#25 single `position` field is **gone**, replaced by
 * `commandedPosition`/`confirmedPosition`/`confirmation` — see D3 for why the
 * conflation it carried was the defect. Dates are ISO 8601 strings on the
 * wire, as every other mirror in this file does it.
 */
export interface PointState {
  pointId: string;
  /** Last position the backend commanded this session. `null` = never commanded. NOT a confirmation of anything physical. */
  commandedPosition: 'normal' | 'reverse' | null;
  /** Last position the point controller reported. `'unknown'` until a reading lands, and again after a confirmation timeout. */
  confirmedPosition: PointPosition;
  confirmation: PointConfirmation;
  /** Configuration, not runtime state — mirrors `points.position_feedback` (D10). */
  positionFeedback: PointFeedbackMode;
  /** Non-null iff `confirmation === 'pending'`. */
  awaitingSince: string | null;
  lastReadingAt: string | null;
  locked: boolean;
  lockedByRoute: string | null;
  lastUpdated: string;
}

/**
 * Wire projection of the backend's `PointFault` (#25, docs/point-feedback.md
 * D4). `faultedAt` is ISO 8601; `armed`/`requiredConfirmations` are
 * precomputed server-side, mirroring `SensorFaultView` exactly.
 */
export interface PointFaultView {
  pointId: string;
  kind: 'timeout' | 'mismatch' | 'indeterminate' | 'malformed-payload' | 'id-mismatch';
  reason: string;
  faultedAt: string;
  consecutiveConfirmations: number;
  requiredConfirmations: number;
  armed: boolean;
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
  /** #25: current latched point faults, likewise always the complete set. See docs/point-feedback.md D4. */
  pointFaults: PointFaultView[];
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
  | { type: 'POINT_FAULTS'; payload: { faults: PointFaultView[] } }
  | { type: 'ROUTE_STATE'; payload: RouteReservation }
  | { type: 'ROUTE_FAULTS'; payload: { faults: RouteFaultView[] } }
  | { type: 'ERROR'; payload: { message: string; details?: unknown } }
  /**
   * #82 D5 (docs/liveness.md): an application-level message, not a
   * protocol-level `ws` ping, which the browser `WebSocket` API cannot
   * observe. `serverTime` is the send time, ISO 8601. The UI consumer
   * (connection-health indicator, staleness treatment) lands in a later PR —
   * this member exists so the type carries the message today.
   */
  | { type: 'HEARTBEAT'; payload: { serverTime: string } };

// ─── Connection liveness (#82, see docs/liveness.md) ───────────────────────────
//
// Mirrors `HEARTBEAT_INTERVAL_MS`/`STALE_AFTER_MISSED_HEARTBEATS` in the
// backend's `domain/liveness.ts`, which is authoritative — there is no shared
// workspace package today (CLAUDE.md), so this is a plain mirrored constant
// with a pointer comment, the same posture as every other type duplicated
// across the wire in this file. Keep in step with the backend value by hand.

/** How often the backend sends a HEARTBEAT `ServerMessage`. */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** How many heartbeats a client may miss before treating the connection as stale. */
export const STALE_AFTER_MISSED_HEARTBEATS = 3;

/** Derived, not independently tuned (D6/D7) — one threshold, tied to the interval above. */
export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * STALE_AFTER_MISSED_HEARTBEATS;

// ─── Client → Server messages ─────────────────────────────────────────────────

export type ClientMessage =
  | { type: 'THROTTLE_COMMAND'; payload: { locoAddress: number; speed: number; direction: Direction } }
  | { type: 'POINT_COMMAND'; payload: { pointId: string; position: 'normal' | 'reverse'; force?: boolean } }
  | { type: 'FUNCTION_COMMAND'; payload: { locoAddress: number; fn: number; state: boolean } }
  | { type: 'SET_MODE'; payload: { mode: SystemMode } }
  | { type: 'EMERGENCY_STOP' };
