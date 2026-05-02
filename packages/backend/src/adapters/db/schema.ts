/**
 * Drizzle ORM schema for the Layout Orchestrator SQLite database.
 *
 * This schema covers the layout configuration (Phase 1/2 MVP).
 * Track topology (block_edges) is intentionally deferred to Phase 2.
 */

import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
