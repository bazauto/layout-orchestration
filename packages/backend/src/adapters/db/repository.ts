/**
 * DrizzleRepository
 *
 * SQLite implementation of ILayoutRepository using Drizzle ORM and better-sqlite3.
 * Creates the data directory and database file automatically if they do not exist.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { eq } from 'drizzle-orm';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { randomUUID } from 'crypto';
import {
  ILayoutRepository,
  LayoutRecord,
  LocoRecord,
  BlockRecord,
  PointRecord,
  SensorRecord,
  GridTileRecord,
} from '../../ports/ILayoutRepository';
import {
  layouts,
  locos,
  blocks,
  points,
  sensors,
  gridTiles,
} from './schema';

export class DrizzleRepository implements ILayoutRepository {
  private readonly db: BetterSQLite3Database;

  constructor(dbPath: string, migrationsFolder: string) {
    // Ensure the data directory exists
    mkdirSync(dirname(dbPath), { recursive: true });
    const sqlite = new Database(dbPath);
    // Enable WAL mode for better concurrent read performance
    sqlite.pragma('journal_mode = WAL');
    this.db = drizzle(sqlite);
    // Apply any pending migrations automatically on startup
    migrate(this.db, { migrationsFolder });
  }

  // ─── Layouts ────────────────────────────────────────────────────────────────

  async listLayouts(): Promise<LayoutRecord[]> {
    const rows = this.db.select().from(layouts).all();
    return rows.map(toLayoutRecord);
  }

  async getLayout(id: string): Promise<LayoutRecord | null> {
    const rows = this.db.select().from(layouts).where(eq(layouts.id, id)).all();
    return rows.length > 0 ? toLayoutRecord(rows[0]) : null;
  }

  async createLayout(data: Omit<LayoutRecord, 'id' | 'createdAt'>): Promise<LayoutRecord> {
    const id = randomUUID();
    const now = new Date();
    this.db.insert(layouts).values({ id, ...data, createdAt: now }).run();
    return { id, ...data, createdAt: now };
  }

  async deleteLayout(id: string): Promise<void> {
    this.db.delete(layouts).where(eq(layouts.id, id)).run();
  }

  // ─── Locos ──────────────────────────────────────────────────────────────────

  async listLocos(layoutId: string): Promise<LocoRecord[]> {
    return this.db.select().from(locos).where(eq(locos.layoutId, layoutId)).all();
  }

  async getLoco(id: string): Promise<LocoRecord | null> {
    const rows = this.db.select().from(locos).where(eq(locos.id, id)).all();
    return rows.length > 0 ? rows[0] : null;
  }

  async createLoco(data: Omit<LocoRecord, 'id'>): Promise<LocoRecord> {
    const id = randomUUID();
    const record = { id, ...data };
    this.db.insert(locos).values(record).run();
    return record;
  }

  async updateLoco(
    id: string,
    data: Partial<Omit<LocoRecord, 'id' | 'layoutId'>>,
  ): Promise<LocoRecord> {
    this.db.update(locos).set(data).where(eq(locos.id, id)).run();
    const updated = await this.getLoco(id);
    if (!updated) throw new Error(`Loco ${id} not found after update`);
    return updated;
  }

  async deleteLoco(id: string): Promise<void> {
    this.db.delete(locos).where(eq(locos.id, id)).run();
  }

  // ─── Blocks ─────────────────────────────────────────────────────────────────

  async listBlocks(layoutId: string): Promise<BlockRecord[]> {
    return this.db.select().from(blocks).where(eq(blocks.layoutId, layoutId)).all();
  }

  async createBlock(data: Omit<BlockRecord, 'id'>): Promise<BlockRecord> {
    const id = randomUUID();
    const record = { id, ...data };
    this.db.insert(blocks).values(record).run();
    return record;
  }

  async updateBlock(
    id: string,
    data: Partial<Omit<BlockRecord, 'id' | 'layoutId'>>,
  ): Promise<BlockRecord> {
    this.db.update(blocks).set(data).where(eq(blocks.id, id)).run();
    const rows = this.db.select().from(blocks).where(eq(blocks.id, id)).all();
    if (!rows.length) throw new Error(`Block ${id} not found after update`);
    return rows[0];
  }

  async deleteBlock(id: string): Promise<void> {
    this.db.delete(blocks).where(eq(blocks.id, id)).run();
  }

  // ─── Points ─────────────────────────────────────────────────────────────────

  async listPoints(layoutId: string): Promise<PointRecord[]> {
    return this.db.select().from(points).where(eq(points.layoutId, layoutId)).all();
  }

  async createPoint(data: Omit<PointRecord, 'id'>): Promise<PointRecord> {
    const id = randomUUID();
    const record = { id, ...data };
    this.db.insert(points).values(record).run();
    return record;
  }

  async updatePoint(
    id: string,
    data: Partial<Omit<PointRecord, 'id' | 'layoutId'>>,
  ): Promise<PointRecord> {
    this.db.update(points).set(data).where(eq(points.id, id)).run();
    const rows = this.db.select().from(points).where(eq(points.id, id)).all();
    if (!rows.length) throw new Error(`Point ${id} not found after update`);
    return rows[0];
  }

  async deletePoint(id: string): Promise<void> {
    this.db.delete(points).where(eq(points.id, id)).run();
  }

  // ─── Sensors ────────────────────────────────────────────────────────────────

  async listSensors(layoutId: string): Promise<SensorRecord[]> {
    return this.db.select().from(sensors).where(eq(sensors.layoutId, layoutId)).all() as SensorRecord[];
  }

  async createSensor(data: Omit<SensorRecord, 'id'>): Promise<SensorRecord> {
    const id = randomUUID();
    const record = { id, ...data };
    this.db.insert(sensors).values(record).run();
    return record as SensorRecord;
  }

  async updateSensor(
    id: string,
    data: Partial<Omit<SensorRecord, 'id' | 'layoutId'>>,
  ): Promise<SensorRecord> {
    this.db.update(sensors).set(data).where(eq(sensors.id, id)).run();
    const rows = this.db.select().from(sensors).where(eq(sensors.id, id)).all();
    if (!rows.length) throw new Error(`Sensor ${id} not found after update`);
    return rows[0] as SensorRecord;
  }

  async deleteSensor(id: string): Promise<void> {
    this.db.delete(sensors).where(eq(sensors.id, id)).run();
  }

  // ─── Grid ────────────────────────────────────────────────────────────────────

  async listGridTiles(layoutId: string): Promise<GridTileRecord[]> {
    return this.db.select().from(gridTiles).where(eq(gridTiles.layoutId, layoutId)).all();
  }

  async upsertGridTile(data: Omit<GridTileRecord, 'id'>): Promise<GridTileRecord> {
    // Check for existing tile at this position
    const existing = this.db
      .select()
      .from(gridTiles)
      .where(eq(gridTiles.layoutId, data.layoutId))
      .all()
      .find((t) => t.x === data.x && t.y === data.y);

    if (existing) {
      this.db
        .update(gridTiles)
        .set({ tileType: data.tileType, metadata: data.metadata })
        .where(eq(gridTiles.id, existing.id))
        .run();
      return { ...existing, tileType: data.tileType, metadata: data.metadata };
    }

    const id = randomUUID();
    const record = { id, ...data };
    this.db.insert(gridTiles).values(record).run();
    return record;
  }

  async deleteTile(id: string): Promise<void> {
    this.db.delete(gridTiles).where(eq(gridTiles.id, id)).run();
  }

  async clearGrid(layoutId: string): Promise<void> {
    this.db.delete(gridTiles).where(eq(gridTiles.layoutId, layoutId)).run();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toLayoutRecord(row: {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}): LayoutRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}
