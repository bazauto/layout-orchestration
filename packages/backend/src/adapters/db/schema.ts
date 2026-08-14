/**
 * Drizzle ORM schema for the Layout Orchestrator SQLite database.
 *
 * This schema covers the layout configuration (Phase 1/2 MVP).
 * Track topology now lives in `block_edges` below.
 */

import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ─── Layouts ──────────────────────────────────────────────────────────────────

export const layouts = sqliteTable('layouts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

// ─── Locos ────────────────────────────────────────────────────────────────────

export const locos = sqliteTable('locos', {
  id: text('id').primaryKey(),
  layoutId: text('layout_id')
    .notNull()
    .references(() => layouts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** DCC address (1–9999) */
  address: integer('address').notNull(),
  type: text('type').notNull().default('unknown'),
  /** Maximum DCC speed step (0–126) */
  maxSpeed: integer('max_speed').notNull().default(126),
  /** Braking factor 0.0–1.0. Used by automation engine for stopping distance calculations. */
  brakingFactor: real('braking_factor').notNull().default(0.5),
});

// ─── Blocks ───────────────────────────────────────────────────────────────────

/**
 * A detected section of track.
 *
 * **Blocks carry the distance, not edges** (D4, docs/track-graph-compilation.md).
 * The edge convention this replaced did not decompose: a run from block c to
 * block t covers `t-c` joints and `t-c-1` block lengths over `t-c` edges, so
 * every edge would have to mean "joint + destination block" *except the last*,
 * which must be joint only because the braking target is the entry boundary of
 * the final step. An edge cannot know whether it is the last one, and the
 * natural reading overshoots by the destination block's own length — the
 * direction that causes an overrun (#105).
 *
 * A block is also an authored row the compiler never touches, so nothing
 * operator-owned lives on a compiled object and there is no measurement to
 * carry across a recompile.
 */
export const blocks = sqliteTable('blocks', {
  id: text('id').primaryKey(),
  layoutId: text('layout_id')
    .notNull()
    .references(() => layouts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /**
   * Physical length in mm. NULL = unmeasured, which **refuses** an automated
   * braked run (`unmeasured-track`, docs/braking.md B4). Deliberately not
   * defaulted: a default would assert a measurement nobody took.
   *
   * **Deliberately no CHECK constraint**, following DD9's call on
   * `sensors.in_service`. A CHECK on an existing SQLite table forces a table
   * rebuild, and `blocks` is the most-referenced table here — five foreign keys
   * point at it, three of them `ON DELETE CASCADE`. A rebuild means
   * `DROP TABLE blocks`, and drizzle-kit's generated rebuild re-enables
   * `foreign_keys` before that statement, which on the live layout would
   * cascade away every grid tile, block end and edge.
   *
   * The payoff would be small. `blockCreateSchema` already enforces
   * `.int().positive()` on every write path, and the failure direction of a bad
   * value here is safe: a zero or negative length shortens the computed
   * distance, so the braking model refuses or brakes early rather than
   * overrunning.
   */
  lengthMm: integer('length_mm'),
});

// ─── Points ───────────────────────────────────────────────────────────────────

export const points = sqliteTable('points', {
  id: text('id').primaryKey(),
  layoutId: text('layout_id')
    .notNull()
    .references(() => layouts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** DCC accessory address used to switch this point */
  dccAddress: integer('dcc_address').notNull(),
  blockId: text('block_id').references(() => blocks.id, { onDelete: 'set null' }),
});

// ─── Sensors ──────────────────────────────────────────────────────────────────

export const sensors = sqliteTable('sensors', {
  id: text('id').primaryKey(),
  layoutId: text('layout_id')
    .notNull()
    .references(() => layouts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** 'block_detection' | 'ir_position' */
  type: text('type').notNull(),
  blockId: text('block_id').references(() => blocks.id, { onDelete: 'set null' }),
  /** The full MQTT topic this sensor publishes its reading to */
  mqttTopic: text('mqtt_topic').notNull(),
  /**
   * Out-of-service means the system stops trusting this sensor entirely
   * (D3, docs/sensor-fault-recovery.md): its payloads are never subscribed
   * to, it contributes nothing to its block's derived occupancy, and any
   * fault latched against it is cleared. Defaults to `true` — every sensor
   * in the live DB is trusted today, and defaulting new/existing rows to
   * `false` would turn every block `unknown` and refuse every route on
   * deploy. Deliberately no CHECK constraint (DD9) — a CHECK on an existing
   * SQLite table forces a table-rebuild migration on a live layout, and the
   * payoff (a boolean column) is small; see docs/sensor-fault-recovery.md.
   */
  inService: integer('in_service', { mode: 'boolean' }).notNull().default(true),
});

// ─── Block Edges (track graph) ────────────────────────────────────────────────

/**
 * Directed connection between two blocks. A bidirectional physical connection
 * is two rows. Authored explicitly — deliberately independent of grid_tiles.
 *
 * `(from_block_id, from_end)` is deliberately NOT unique: a turnout, three-way
 * point, or slip gives a single block-end several outgoing edges, one per
 * point setting, discriminated at runtime by `point_conditions`. What IS
 * unique is the full connection tuple below — two edges may not describe the
 * exact same physical connection twice.
 *
 * **An edge carries no length.** The joint of undetected trackwork between two
 * detected sections is treated as zero (D5, docs/track-graph-compilation.md) —
 * not because the physics says zero, but because on this railway the error is
 * small and always in the safe direction (it underestimates available distance,
 * so it brakes early), and it buys the invariant that nothing an operator owns
 * lives on an edge. Distance is on `blocks.length_mm`; see #105 for why the
 * edge convention could not decompose. A nullable `joint_length_mm` defaulting
 * to zero is additive and can be introduced later without redesigning anything.
 */
export const blockEdges = sqliteTable(
  'block_edges',
  {
    id: text('id').primaryKey(),
    layoutId: text('layout_id').notNull().references(() => layouts.id, { onDelete: 'cascade' }),
    fromBlockId: text('from_block_id').notNull().references(() => blocks.id, { onDelete: 'cascade' }),
    /** Named end of from_block_id this edge leaves by. */
    fromEnd: text('from_end').notNull(),
    toBlockId: text('to_block_id').notNull().references(() => blocks.id, { onDelete: 'cascade' }),
    /** Named end of to_block_id this edge arrives at. */
    toEnd: text('to_end').notNull(),
    /**
     * JSON array of { pointId, requiredPosition }. All must hold for the edge
     * to be traversable. '[]' = plain track. Not FK-enforced: a dangling
     * pointId makes the edge permanently non-traversable, which fails closed.
     */
    pointConditions: text('point_conditions').notNull().default('[]'),
  },
  (table) => [
    index('block_edges_layout_idx').on(table.layoutId),
    index('block_edges_from_block_idx').on(table.fromBlockId),
    index('block_edges_to_block_idx').on(table.toBlockId),
    uniqueIndex('block_edges_connection_unq').on(
      table.layoutId,
      table.fromBlockId,
      table.fromEnd,
      table.toBlockId,
      table.toEnd,
    ),
    check('block_edges_not_self_loop', sql`${table.fromBlockId} <> ${table.toBlockId}`),
    check(
      'block_edges_ends_non_empty',
      sql`length(trim(${table.fromEnd})) > 0 AND length(trim(${table.toEnd})) > 0`,
    ),
  ],
);

// ─── Block Ends (see docs/topology.md, #72) ───────────────────────────────────

/*
 * `block_ends` was here (#72) and is dropped in `0010_drop_block_ends.sql`.
 *
 * It stored a named opening of a block: the referent of
 * `block_edges.from_end`/`to_end`, with `pinned` distinguishing an authored
 * label from a generated one. The label is now derived from the drawing on
 * every compile and referenced by nothing between compiles
 * (`docs/track-graph-compilation.md` D8), so there is nothing to store.
 *
 * **The absence of a foreign key from `block_edges` was the load-bearing part**,
 * and it is why this drop is a clean one rather than a migration. #72 refused
 * that FK for three reasons — the model tolerated an end label with no other
 * referent, a malformed label was DB corruption handled by Safe-Stop rather
 * than by referential integrity, and the adoption pass would have deadlocked
 * against its own constraint. The consequence is that `block_edges` never
 * pointed at this table at all, so removing it cannot orphan a row.
 *
 * `migrations.test.ts` still asserts `block_edges` has foreign keys to
 * `layouts` and `blocks` and to nothing else, which is that decision outliving
 * the table it was about.
 */

// ─── Route Reservations (see docs/route-locking.md) ───────────────────────────

/**
 * The authoritative record of a granted route (D1, D3). `path` is the
 * ordered `RoutePathStep[]` as JSON — read back and Zod-validated the same
 * way `block_edges.point_conditions` is (`parseReservationRow`), never
 * trusted as-is. `confirmed_index` is the last path index the train has
 * been confirmed in; `reason` carries the Safe-Stop/restart-recovery/cancel
 * reason and is NULL only while `active`.
 */
export const routeReservations = sqliteTable(
  'route_reservations',
  {
    id: text('id').primaryKey(),
    layoutId: text('layout_id').notNull().references(() => layouts.id, { onDelete: 'cascade' }),
    locoAddress: integer('loco_address').notNull(),
    authority: text('authority').notNull(),
    status: text('status').notNull(),
    path: text('path').notNull(),
    confirmedIndex: integer('confirmed_index').notNull(),
    reason: text('reason'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    index('route_reservations_layout_idx').on(table.layoutId),
    index('route_reservations_layout_status_idx').on(table.layoutId, table.status),
    check(
      'route_reservations_status_valid',
      sql`${table.status} IN ('active', 'suspended', 'released', 'cancelled')`,
    ),
    check('route_reservations_authority_valid', sql`${table.authority} IN ('manual', 'auto')`),
    check(
      'route_reservations_loco_address_range',
      sql`${table.locoAddress} BETWEEN 1 AND 9999`,
    ),
    check('route_reservations_confirmed_index_non_negative', sql`${table.confirmedIndex} >= 0`),
    // D2 (one route per loco) and D13 (at most one active/suspended
    // reservation per loco per layout) enforced at the DB level, not just
    // the domain — a domain-layer bug must not be able to double-book a
    // loco across two reservations, matching #11's posture on block_edges.
    // Partial: only rows still holding (active/suspended) are constrained,
    // so a released/cancelled history for the same loco is unrestricted.
    uniqueIndex('route_reservations_one_per_loco_unq')
      .on(table.layoutId, table.locoAddress)
      .where(sql`${table.status} IN ('active', 'suspended')`),
  ],
);

/**
 * One exclusive hold (block, point, or edge) belonging to a `route_reservations`
 * row (D1, D2). `released` marks a hold spent rather than deleting it — an
 * audit trail of what a route held, and the partial unique index below still
 * excludes it from the "currently held" exclusivity check once true.
 */
export const routeHolds = sqliteTable(
  'route_holds',
  {
    id: text('id').primaryKey(),
    routeId: text('route_id')
      .notNull()
      .references(() => routeReservations.id, { onDelete: 'cascade' }),
    layoutId: text('layout_id').notNull().references(() => layouts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    targetId: text('target_id').notNull(),
    requiredPosition: text('required_position'),
    releaseAfterIndex: integer('release_after_index').notNull(),
    released: integer('released', { mode: 'boolean' }).notNull().default(false),
  },
  (table) => [
    index('route_holds_route_idx').on(table.routeId),
    check('route_holds_kind_valid', sql`${table.kind} IN ('block', 'point', 'edge')`),
    check(
      'route_holds_required_position_valid',
      sql`${table.requiredPosition} IS NULL OR ${table.requiredPosition} IN ('normal', 'reverse')`,
    ),
    // D2's exclusivity, at the DB level: no two currently-held (released = 0)
    // rows may target the same (layout, kind, target) — the same block or
    // point cannot be held by two routes at once, regardless of what the
    // domain layer computed. Deliberately not unique on `route_id` as well —
    // that would defeat the point of the constraint.
    uniqueIndex('route_holds_exclusive_unq')
      .on(table.layoutId, table.kind, table.targetId)
      .where(sql`${table.released} = 0`),
  ],
);

// ─── Users ────────────────────────────────────────────────────────────────────

/**
 * Local operator accounts (see docs/auth.md once the auth PR lands in full).
 *
 * `passwordHash` is nullable rather than required: today there is exactly one
 * credential type (argon2id password), but the schema must not foreclose
 * adding WebAuthn credentials later. A future WebAuthn credential belongs in
 * its own `webauthn_credentials` table keyed on `user_id`, not as a column
 * here — a NULL `passwordHash` is what makes a WebAuthn-only account (no
 * password at all) representable without a fake placeholder hash.
 *
 * NOT VISIBLE HERE: migration `0006_users_last_admin_guard.sql` attaches two
 * triggers, `users_last_admin_no_demote` (`BEFORE UPDATE OF role`) and
 * `users_last_admin_no_delete` (`BEFORE DELETE`), that abort a write which
 * would leave the layout with zero admin accounts (Q1, docs/auth.md).
 * Drizzle has no trigger DSL, so this is the one migration in the repo that
 * lands without a corresponding `schema.ts` change — deliberately generated
 * with `drizzle-kit generate --custom` rather than `db:generate`. This
 * comment exists so the schema file still tells the truth about what the
 * table enforces. Removing the triggers means a new migration with
 * `DROP TRIGGER`, never editing `0006_users_last_admin_guard.sql` in place.
 *
 * ALSO NOT VISIBLE FROM A DIFF ALONE: the `users_role_valid` CHECK below was
 * widened to admit `'monitor'` (#63) by a table-rebuild migration
 * (`0011_users_monitor_role.sql`), since SQLite cannot alter a CHECK
 * constraint in place. A Drizzle rebuild does
 * `CREATE __new_users; INSERT…; DROP TABLE users; ALTER TABLE __new_users
 * RENAME TO users` — and `DROP TABLE` drops every trigger attached to the
 * table along with it. That migration therefore ends with the same two
 * `CREATE TRIGGER` statements as `0006`, verbatim, appended by hand after
 * `drizzle-kit generate` produced the rebuild — the one other case, besides
 * `0006` itself, where this table's migration carries SQL `db:generate`
 * could not have produced on its own.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    /** argon2id encoded hash (algorithm, params, salt, and digest all embedded). NULL = no password credential set. */
    passwordHash: text('password_hash'),
    /** 'admin' may edit topology and config; 'operator' may drive; 'monitor' (#63) may only watch. */
    role: text('role').notNull().default('operator'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    uniqueIndex('users_username_unq').on(table.username),
    check('users_role_valid', sql`${table.role} IN ('admin', 'operator', 'monitor')`),
    check('users_username_non_empty', sql`length(trim(${table.username})) > 0`),
  ],
);

// ─── Sessions ─────────────────────────────────────────────────────────────────

/**
 * Server-side session store — opaque tokens, not JWTs, so a backend restart
 * never invalidates a live session. Sliding expiry (30 days), refreshed on
 * every validated use by `AuthService`.
 *
 * `tokenHash` stores a SHA-256 digest of the session token, never the token
 * itself — the same posture as password hashing: a DB read (backup, dump,
 * accidental log line) must not directly yield a usable session.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 hex digest of the opaque session token. */
    tokenHash: text('token_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    /** Sliding expiry — refreshed on every validated use. */
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_unq').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

// ─── Compiled Graphs (see docs/track-graph-compilation.md D10, #103) ──────────

/**
 * The provenance of the graph currently in `block_edges`: which drawing it was
 * compiled from, and when.
 *
 * One row per layout, and a *missing* row is the honest spelling of "never
 * compiled" — not a NULL every reader must remember to check. `block_edges`
 * being empty is a different statement from the graph being unbuilt.
 *
 * `drawing_fingerprint` is `drawingFingerprint()`'s SHA-256 over exactly what
 * the compiler's walk reads (D10, D-G). It does three jobs at once: `apply`
 * carries the fingerprint that was *reviewed* and is refused if the drawing has
 * moved since, so review-then-apply cannot become check-then-use; a live
 * fingerprint differing from the drawing's says the graph is behind the
 * drawing, which is a warning and never a gate; and a matching one makes
 * re-applying provably a no-op.
 *
 * Deliberately no `edge_count` and no `gap_count`. Both are recomputable from
 * the drawing, and a stored copy would be a second source of truth about the
 * very thing #103 exists to stop having two of.
 */
export const compiledGraphs = sqliteTable('compiled_graphs', {
  layoutId: text('layout_id')
    .primaryKey()
    .references(() => layouts.id, { onDelete: 'cascade' }),
  drawingFingerprint: text('drawing_fingerprint').notNull(),
  compiledAt: integer('compiled_at', { mode: 'timestamp' }).notNull(),
});

// ─── Grid Tiles ───────────────────────────────────────────────────────────────

export const gridTiles = sqliteTable('grid_tiles', {
  id: text('id').primaryKey(),
  layoutId: text('layout_id')
    .notNull()
    .references(() => layouts.id, { onDelete: 'cascade' }),
  x: integer('x').notNull(),
  y: integer('y').notNull(),
  tileType: text('tile_type').notNull(),
  /** JSON blob for tile-specific metadata */
  metadata: text('metadata').notNull().default('{}'),
});

// ─── Inferred Types ───────────────────────────────────────────────────────────

export type Layout = typeof layouts.$inferSelect;
export type NewLayout = typeof layouts.$inferInsert;
export type Loco = typeof locos.$inferSelect;
export type NewLoco = typeof locos.$inferInsert;
export type Block = typeof blocks.$inferSelect;
export type NewBlock = typeof blocks.$inferInsert;
export type Point = typeof points.$inferSelect;
export type NewPoint = typeof points.$inferInsert;
export type Sensor = typeof sensors.$inferSelect;
export type NewSensor = typeof sensors.$inferInsert;
export type GridTile = typeof gridTiles.$inferSelect;
export type NewGridTile = typeof gridTiles.$inferInsert;
export type BlockEdgeRow = typeof blockEdges.$inferSelect;
export type NewBlockEdgeRow = typeof blockEdges.$inferInsert;
export type CompiledGraphRow = typeof compiledGraphs.$inferSelect;
export type NewCompiledGraphRow = typeof compiledGraphs.$inferInsert;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type RouteReservationRow = typeof routeReservations.$inferSelect;
export type NewRouteReservationRow = typeof routeReservations.$inferInsert;
export type RouteHoldRow = typeof routeHolds.$inferSelect;
export type NewRouteHoldRow = typeof routeHolds.$inferInsert;
