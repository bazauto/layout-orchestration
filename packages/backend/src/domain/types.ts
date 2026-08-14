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
 * A named physical opening of a block (`north`, `southeast-1`, ...).
 *
 * **Disposable compiler output** (`docs/track-graph-compilation.md` D8). It is
 * derived from the drawing by `compileOpenings` on every compile, unique per
 * block within one compile, and referenced by nothing but the `block_edges`
 * row that carries it. Nobody stores one, nobody edits one, and a recompile may
 * legitimately produce a different set — the apply rewrites every edge at once,
 * which is what makes that safe.
 *
 * It was the join key into a `block_ends` table until #103 PR 7, and that is
 * the whole story of this issue: an identifier must be stable and a
 * geometry-derived description must not be, and one string was being asked to
 * do both. String equality against the paired `blockId` is now the **only**
 * operation performed on it.
 *
 * A non-reversing movement must still leave a block via an end different from
 * the one it entered by — that is `domain/pathfinding.ts`'s search state, and
 * it needs only inequality.
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
 *
 * **No length.** The joint between two detected sections is treated as zero and
 * distance lives on `BlockRecord.lengthMm` (D4/D5,
 * `docs/track-graph-compilation.md`) — the edge convention did not decompose and
 * overshot by the destination block (#105). Nothing an operator owns is on an
 * edge, which is what lets a compiler own the whole edge set.
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

// ─── Grid Tiles (the Track Editor's drawing — see docs/track-grid.md) ─────────

/**
 * The closed vocabulary of tile shapes the Track Editor can draw.
 *
 * Presentational, and deliberately so: the grid is a *drawing*, not the track
 * model. `block_edges` is the model (`docs/topology.md`), and nothing in the
 * backend reads a tile. This lives here anyway because it is the vocabulary
 * the frontend mirrors and, since #70, the closed set the write path
 * validates against — `tile_type` is a bare `text` column, so this array is
 * the only thing standing between a typo and a row that renders as an
 * invisible tile which still occupies its cell.
 *
 * `'empty'` is deliberately absent. The absence of a tile is expressed by
 * DELETE, not by a persisted row claiming to be nothing; accepting it would
 * reintroduce exactly the invisible-but-occupied cell this enum exists to
 * prevent. The legacy `straight-v` and named `curve-*` entries are the
 * opposite call — they are in already-authored grids and must keep
 * round-tripping.
 */
export const TILE_TYPES = [
  'straight-h',
  'straight-v',
  'straight-45',
  'curve',
  'curve-ne',
  'curve-nw',
  'curve-se',
  'curve-sw',
  'point-left',
  'point-right',
  'buffer',
  'platform',
  'crossing',
] as const;

export type TileType = (typeof TILE_TYPES)[number];

/**
 * The tile types that actually depict a point — the ones drawn with a through
 * road and a divergent one, and so the only ones a leg mapping (#73) means
 * anything on.
 *
 * A point on the diagram is usually **two** tiles: the point tile itself, and a
 * `straight-45` companion carrying the divergent road across to the adjacent
 * row. Both are tagged with the same `pointId`, because both depict part of that
 * point — but only the first has legs to map. Anything asking "does this tile
 * need `pointRoads`?" must ask this, not `metadata.pointId !== undefined`.
 */
export const POINT_TILE_TYPES = ['point-left', 'point-right'] as const satisfies readonly TileType[];

export function depictsPoint(tileType: TileType): boolean {
  return (POINT_TILE_TYPES as readonly TileType[]).includes(tileType);
}

/** Rotation is authored in 45° steps (`GridEditor`'s R / Shift+R), so the set is closed. */
export const TILE_ROTATIONS = [0, 45, 90, 135, 180, 225, 270, 315] as const;

export type TileRotation = (typeof TILE_ROTATIONS)[number];

/**
 * The eight edges of a tile, named by compass point in the tile's **own,
 * unrotated** frame.
 *
 * Unrotated is the whole point (#73). `metadata.rotation` is applied at render
 * time, so a leg recorded as `'n'` on a tile later rotated 90° draws to the
 * east without the stored data changing — the mapping describes the drawn
 * shape, and the rotation describes how that shape is placed. Recording the
 * post-rotation edge instead would silently become wrong the moment the tile
 * is rotated.
 */
export const TILE_EDGES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;

export type TileEdge = (typeof TILE_EDGES)[number];

/**
 * The 8-point compass vocabulary block-end labels are generated from (#72).
 *
 * Ordered clockwise from north, which is what makes indexing by bearing
 * possible. Every member satisfies `blockEndLabelSchema`, so generating a
 * label needs no change to the `block_edges` contract.
 */
export const CARDINAL_END_LABELS = [
  'north',
  'northeast',
  'east',
  'southeast',
  'south',
  'southwest',
  'west',
  'northwest',
] as const;

export type CardinalEndLabel = (typeof CARDINAL_END_LABELS)[number];

/**
 * The kinds of entity a tile annotation can place (#74).
 *
 * A **discriminator**, not a convenience: an id alone cannot be resolved back
 * to a table, and the mechanism is deliberately generic — signals (#79) and
 * RFID readers (#39) are the queued consumers. Nothing reading an annotation
 * may assume it is a sensor.
 */
export const ANNOTATION_ENTITY_TYPES = ['sensor'] as const;

export type AnnotationEntityType = (typeof ANNOTATION_ENTITY_TYPES)[number];

/**
 * "An entity of type T with id X sits at this tile."
 *
 * Placement is **presentational**. The drawing is explicitly not to scale
 * (#71), so where a sensor appears on it is a drawing concern, not a railway
 * fact — the railway fact is #77's `offsetMm` from a block end, a different
 * field on a different issue with a different safety posture. A sensor drawn
 * at the wrong cell is a bad picture; nothing routes or brakes on it.
 *
 * `orientation` is cosmetic only: which way a beam points on the diagram. It
 * asserts nothing about detection direction, which the system does not model.
 */
export interface TileAnnotation {
  entityType: AnnotationEntityType;
  entityId: string;
  orientation?: TileRotation;
}

/** Bounded so one tile cannot carry an unbounded list. Several annotations sharing a tile is expected (#74); hundreds is a script. */
export const MAX_TILE_ANNOTATIONS = 4;

/**
 * Which drawn legs of a point tile are joined when a set of points stands in a
 * given set of positions (#73).
 *
 * **Leg-list shaped, keyed by a position tuple** — deliberately, per #83. The
 * obvious design, a `normalLeg` naming one of two legs, forecloses three-way
 * points immediately; keying on a single point's position forecloses slips,
 * which are one piece of track carrying two independently switched mechanisms.
 * `when` is therefore a list, and a tile carries a list of roads.
 *
 * This is **unverifiable authored data**. There is no independent source of
 * truth for which way round a physical point is wired, and it cannot be
 * checked against `block_edges` either — `pointConditions` names a required
 * position with no geometric meaning. The editor's job is to make it easy to
 * see and correct, not to validate it.
 *
 * Nothing in `domain/` reads this. It exists so a mimic can draw the
 * **commanded** road solid and the unset road dimmed; until #25 lands there is
 * no confirmed position to draw at all, and the renderer must keep that
 * distinction available rather than imply confirmation.
 */
export interface TilePointRoad {
  /**
   * Every condition must hold for this road to be the set road. Non-empty;
   * one entry per point mechanism involved. `'unknown'` is excluded for the
   * same reason `PointCondition.requiredPosition` excludes it — you cannot
   * draw the road that uncertainty selects.
   */
  when: Array<{ pointId: PointId; position: 'normal' | 'reverse' }>;
  /** The two tile edges this road joins, in the tile's unrotated frame. */
  legs: [TileEdge, TileEdge];
}

/**
 * How a tile's relationship to the block model should be read (#71).
 *
 * Only the *deliberate* assertion is stored. "Block track" is already carried
 * by `blockId`, and re-stating it would create two ways to say one thing that
 * can disagree; "unclassified" is the absence of both, which is exactly the
 * unfinished state the editor needs to surface as a to-do.
 *
 * A single member today, and an enum rather than a boolean on purpose: #71's
 * parked open question 2 (a named feeder that is not a block, closer to a
 * block-with-no-detection than to decoration) would arrive as another member
 * here, and a `decorative: true` boolean could not grow one.
 */
export const TILE_TRACK_ROLES = ['decorative'] as const;

export type TileTrackRole = (typeof TILE_TRACK_ROLES)[number];

/** The three-way classification `classifyTile` derives. `block` and `unclassified` are never stored. */
export type TileClassification = 'block' | 'decorative' | 'unclassified';

/**
 * The **closed** shape of a tile's `metadata` JSON blob.
 *
 * Closed rather than a passthrough record because every later addition to the
 * drawing lands here, and a schema that silently accepts unknown keys cannot
 * tell an unfinished feature from a typo. New keys are added to this type and
 * its Zod schema together.
 *
 * `blockId` and `pointId` are *drawing* assertions: which block's tint this
 * tile draws in, which point this tile depicts. They are checked to exist in
 * the same layout (#70) but carry no railway authority — an edge's
 * `pointConditions`, not a tile, is what routes are planned against. The same
 * holds for everything added in wave 2: a tile still decides nothing.
 */
export interface GridTileMetadata {
  rotation?: TileRotation;
  blockId?: BlockId;
  pointId?: PointId;
  /** Present only to assert "deliberately not part of any block" (#71). Mutually exclusive with `blockId`. */
  trackRole?: TileTrackRole;
  /** Entities placed at this tile (#74). Order is authoring order and carries no meaning. */
  annotations?: TileAnnotation[];
  /** Which legs each point position joins (#73). Only meaningful on a tile depicting a point. */
  pointRoads?: TilePointRoad[];
}

/**
 * Derives the three-way classification of a tile from its metadata (#71).
 *
 * "Untagged tile" is deliberately **not** an error, and this is the function
 * that makes that statement precise. On Westgate Hollow the entry feeder is
 * plain track the system neither detects nor reserves, and warning on every
 * such cell would light up the whole run — useless. But the opposite failure
 * is real: a tile that should have been tagged and was not is silently
 * invisible to live state. Both cases used to be the same absent key.
 */
export function classifyTile(metadata: GridTileMetadata): TileClassification {
  if (metadata.blockId !== undefined) return 'block';
  if (metadata.trackRole === 'decorative') return 'decorative';
  return 'unclassified';
}

/*
 * `BlockEnd` — a stored, pinnable, hand-editable row naming an opening — was
 * here, and is deleted with its table (#103 PR 7). `BlockEndLabel` above is
 * what remains, and it is a different kind of thing: compiler output, not a
 * record.
 */

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

// ─── Sensor Simulation (see docs/sensor-simulation.md, #65) ───────────────────

/** The three canned malformed payloads (D5) — chosen for three DISTINCT Zod failures. */
export type MalformedVariant = 'bad-enum' | 'missing-field' | 'not-an-object';

/**
 * What `SensorSimulationService.inject` publishes, one member per operator
 * action (D4). Never carries operator free-text: `reading`/`clear` pick a
 * `state`, `malformed` picks a variant BY NAME from a server-side table
 * (D5) — no client ever supplies payload bytes.
 */
export type SimulatedReadingAction =
  | { action: 'reading'; state: 'occupied' | 'clear'; retain: boolean }
  | { action: 'malformed'; variant: MalformedVariant; retain: boolean }
  | { action: 'clear-retained' };

/**
 * The echo `SensorSimulationService.inject` returns — a record of what
 * actually went on the wire, which is what the panel's client-side "last
 * injected" history (D8) displays.
 */
export interface SimulatedInjection {
  sensorId: SensorId;
  sensorName: string | null;
  topic: string;
  action: SimulatedReadingAction['action'];
  payload: unknown;
  retain: boolean;
  publishedAt: Date;
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
  /** A block on the route between the train and its target has no measured length (D4). */
  | { kind: 'unmeasured-track'; blockId: BlockId }
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
