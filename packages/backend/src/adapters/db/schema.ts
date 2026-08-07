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

export const blocks = sqliteTable('blocks', {
  id: text('id').primaryKey(),
  layoutId: text('layout_id')
    .notNull()
    .references(() => layouts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
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
    /** Physical length in mm. NULL = unmeasured; unsafe for automated braking. */
    lengthMm: integer('length_mm'),
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
      'block_edges_length_positive',
      sql`${table.lengthMm} IS NULL OR ${table.lengthMm} > 0`,
    ),
    check(
      'block_edges_ends_non_empty',
      sql`length(trim(${table.fromEnd})) > 0 AND length(trim(${table.toEnd})) > 0`,
    ),
  ],
);

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
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    /** argon2id encoded hash (algorithm, params, salt, and digest all embedded). NULL = no password credential set. */
    passwordHash: text('password_hash'),
    /** 'admin' may edit topology and config; 'operator' may drive. */
    role: text('role').notNull().default('operator'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [
    uniqueIndex('users_username_unq').on(table.username),
    check('users_role_valid', sql`${table.role} IN ('admin', 'operator')`),
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
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type RouteReservationRow = typeof routeReservations.$inferSelect;
export type NewRouteReservationRow = typeof routeReservations.$inferInsert;
export type RouteHoldRow = typeof routeHolds.$inferSelect;
export type NewRouteHoldRow = typeof routeHolds.$inferInsert;
