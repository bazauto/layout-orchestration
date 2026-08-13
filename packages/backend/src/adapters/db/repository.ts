/**
 * DrizzleRepository
 *
 * SQLite implementation of ILayoutRepository using Drizzle ORM and better-sqlite3.
 * Creates the data directory and database file automatically if they do not exist.
 */

import { and, eq, inArray, or } from 'drizzle-orm';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
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
  BlockEdge,
  BlockEnd,
  RouteHoldKind,
  RouteId,
  RouteReservation,
  RouteStatus,
} from '../../domain/types';
import {
  parseBlockEdgeRow,
  parseBlockEndRow,
  parseReservationRow,
  parseSensorRow,
} from '../../services/validation';
import {
  layouts,
  locos,
  blocks,
  points,
  sensors,
  gridTiles,
  blockEdges,
  blockEnds,
  routeReservations,
  routeHolds,
} from './schema';

export class DrizzleRepository implements ILayoutRepository {
  /**
   * Takes an already-open, already-migrated connection (see
   * `adapters/db/connection.ts#openDatabase`) rather than a `dbPath` —
   * `DrizzleAuthRepository` reads and writes the same file, and two
   * independent connections each running their own migration pass is not a
   * risk worth taking on a database that cannot be reset.
   */
  constructor(private readonly db: BetterSQLite3Database) {}

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

  async deleteBlock(layoutId: string, id: string): Promise<void> {
    // Explicit, atomic edge cleanup — see the doc comment on
    // ILayoutRepository#deleteBlock. Not belt-and-braces: this is what keeps
    // topology correct without relying on FK cascade enforcement being on.
    //
    // Every statement is scoped by layoutId as well as id, so a mismatched
    // layout deletes nothing rather than deleting another layout's block.
    this.db.transaction((tx) => {
      tx.delete(blockEdges)
        .where(
          and(
            eq(blockEdges.layoutId, layoutId),
            or(eq(blockEdges.fromBlockId, id), eq(blockEdges.toBlockId, id)),
          ),
        )
        .run();
      tx.delete(blocks).where(and(eq(blocks.layoutId, layoutId), eq(blocks.id, id))).run();
    });
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

  async deletePoint(layoutId: string, id: string): Promise<void> {
    this.db.delete(points).where(and(eq(points.layoutId, layoutId), eq(points.id, id))).run();
  }

  // ─── Sensors ────────────────────────────────────────────────────────────────

  async listSensors(layoutId: string): Promise<SensorRecord[]> {
    const rows = this.db.select().from(sensors).where(eq(sensors.layoutId, layoutId)).all();
    return rows.map(parseSensorRow);
  }

  async createSensor(data: Omit<SensorRecord, 'id'>): Promise<SensorRecord> {
    const id = randomUUID();
    const record = { id, ...data };
    this.db.insert(sensors).values(record).run();
    return parseSensorRow(record);
  }

  async updateSensor(
    id: string,
    data: Partial<Omit<SensorRecord, 'id' | 'layoutId'>>,
  ): Promise<SensorRecord> {
    this.db.update(sensors).set(data).where(eq(sensors.id, id)).run();
    const rows = this.db.select().from(sensors).where(eq(sensors.id, id)).all();
    if (!rows.length) throw new Error(`Sensor ${id} not found after update`);
    return parseSensorRow(rows[0]);
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

  // ─── Block Edges ────────────────────────────────────────────────────────────

  async listBlockEdges(layoutId: string): Promise<BlockEdge[]> {
    const rows = this.db.select().from(blockEdges).where(eq(blockEdges.layoutId, layoutId)).all();
    return rows.map(parseBlockEdgeRow);
  }

  async getBlockEdge(id: string): Promise<BlockEdge | null> {
    const rows = this.db.select().from(blockEdges).where(eq(blockEdges.id, id)).all();
    return rows.length > 0 ? parseBlockEdgeRow(rows[0]) : null;
  }

  async createBlockEdge(data: Omit<BlockEdge, 'id'>): Promise<BlockEdge> {
    const id = randomUUID();
    this.db
      .insert(blockEdges)
      .values({
        id,
        layoutId: data.layoutId,
        fromBlockId: data.fromBlockId,
        fromEnd: data.fromEnd,
        toBlockId: data.toBlockId,
        toEnd: data.toEnd,
        pointConditions: JSON.stringify(data.pointConditions),
      })
      .run();
    const created = await this.getBlockEdge(id);
    if (!created) throw new Error(`Block edge ${id} not found after create`);
    return created;
  }

  async updateBlockEdge(
    id: string,
    data: Partial<Omit<BlockEdge, 'id' | 'layoutId'>>,
  ): Promise<BlockEdge> {
    const { pointConditions, ...rest } = data;
    this.db
      .update(blockEdges)
      .set({
        ...rest,
        ...(pointConditions !== undefined ? { pointConditions: JSON.stringify(pointConditions) } : {}),
      })
      .where(eq(blockEdges.id, id))
      .run();
    const updated = await this.getBlockEdge(id);
    if (!updated) throw new Error(`Block edge ${id} not found after update`);
    return updated;
  }

  async deleteBlockEdge(id: string): Promise<void> {
    this.db.delete(blockEdges).where(eq(blockEdges.id, id)).run();
  }

  // ─── Block Ends ─────────────────────────────────────────────────────────────

  async listBlockEnds(layoutId: string): Promise<BlockEnd[]> {
    const rows = this.db.select().from(blockEnds).where(eq(blockEnds.layoutId, layoutId)).all();
    return rows.map(parseBlockEndRow);
  }

  async getBlockEnd(id: string): Promise<BlockEnd | null> {
    const rows = this.db.select().from(blockEnds).where(eq(blockEnds.id, id)).all();
    return rows.length > 0 ? parseBlockEndRow(rows[0]) : null;
  }

  async createBlockEnd(data: Omit<BlockEnd, 'id'>): Promise<BlockEnd> {
    const id = randomUUID();
    this.db.insert(blockEnds).values({ id, ...data }).run();
    return { id, ...data };
  }

  async updateBlockEnd(id: string, data: { label?: string; pinned?: boolean }): Promise<BlockEnd> {
    this.db.update(blockEnds).set(data).where(eq(blockEnds.id, id)).run();
    const updated = await this.getBlockEnd(id);
    if (!updated) throw new Error(`Block end ${id} not found after update`);
    return updated;
  }

  async deleteBlockEnd(id: string): Promise<void> {
    this.db.delete(blockEnds).where(eq(blockEnds.id, id)).run();
  }

  /**
   * Swaps this block's generated ends for a new set, in one transaction.
   *
   * Transactional because a regeneration that deleted the old labels and then
   * failed to insert the new ones would leave a block with no ends at all —
   * and a block whose ends have silently vanished looks exactly like a block
   * nobody has authored yet, which is the state #84's to-do list is trying to
   * distinguish.
   *
   * Pinned rows are excluded from the delete AND their labels are excluded
   * from the insert. Skipping the second half would collide with the unique
   * index on `(block_id, label)`: a generated `north` regenerating against a
   * pinned `north` is the ordinary case, not an error.
   */
  async replaceGeneratedBlockEnds(
    layoutId: string,
    blockId: string,
    labels: readonly string[],
  ): Promise<void> {
    this.db.transaction((tx) => {
      const pinnedLabels = new Set(
        tx
          .select()
          .from(blockEnds)
          .where(and(eq(blockEnds.blockId, blockId), eq(blockEnds.pinned, true)))
          .all()
          .map((r) => r.label),
      );

      tx.delete(blockEnds)
        .where(and(eq(blockEnds.blockId, blockId), eq(blockEnds.pinned, false)))
        .run();

      for (const label of new Set(labels)) {
        if (pinnedLabels.has(label)) continue;
        tx.insert(blockEnds)
          .values({ id: randomUUID(), layoutId, blockId, label, pinned: false })
          .run();
      }
    });
  }

  // ─── Route Reservations ─────────────────────────────────────────────────────

  async listReservations(layoutId: string, statuses?: RouteStatus[]): Promise<RouteReservation[]> {
    const whereClause =
      statuses && statuses.length > 0
        ? and(eq(routeReservations.layoutId, layoutId), inArray(routeReservations.status, statuses))
        : eq(routeReservations.layoutId, layoutId);
    const rows = this.db.select().from(routeReservations).where(whereClause).all();
    if (rows.length === 0) return [];

    const holdRows = this.db
      .select()
      .from(routeHolds)
      .where(
        inArray(
          routeHolds.routeId,
          rows.map((r) => r.id),
        ),
      )
      .all();
    const holdsByRoute = new Map<string, typeof holdRows>();
    for (const holdRow of holdRows) {
      const bucket = holdsByRoute.get(holdRow.routeId) ?? [];
      bucket.push(holdRow);
      holdsByRoute.set(holdRow.routeId, bucket);
    }

    return rows.map((row) => parseReservationRow(row, holdsByRoute.get(row.id) ?? []));
  }

  async getReservation(id: string): Promise<RouteReservation | null> {
    const rows = this.db.select().from(routeReservations).where(eq(routeReservations.id, id)).all();
    if (rows.length === 0) return null;
    const holdRows = this.db.select().from(routeHolds).where(eq(routeHolds.routeId, id)).all();
    return parseReservationRow(rows[0], holdRows);
  }

  /**
   * Writes the reservation row and every hold row in ONE transaction — see
   * the atomicity doc comment on `ILayoutRepository#createReservation`. If
   * any hold insert violates `route_holds_exclusive_unq` (D2's exclusivity,
   * enforced at the DB level per #11's posture), better-sqlite3's
   * transaction wrapper rolls back the reservation row too — zero rows
   * persisted, not a partial write.
   */
  async createReservation(
    data: Omit<RouteReservation, 'createdAt' | 'updatedAt'>,
  ): Promise<RouteReservation> {
    const now = new Date();
    this.db.transaction((tx) => {
      tx.insert(routeReservations)
        .values({
          id: data.id,
          layoutId: data.layoutId,
          locoAddress: data.locoAddress,
          authority: data.authority,
          status: data.status,
          path: JSON.stringify(data.path),
          confirmedIndex: data.confirmedIndex,
          reason: data.reason,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      for (const hold of data.holds) {
        tx.insert(routeHolds)
          .values({
            id: randomUUID(),
            routeId: data.id,
            layoutId: data.layoutId,
            kind: hold.kind,
            targetId: hold.targetId,
            requiredPosition: hold.requiredPosition,
            releaseAfterIndex: hold.releaseAfterIndex,
            released: hold.released,
          })
          .run();
      }
    });

    const created = await this.getReservation(data.id);
    if (!created) throw new Error(`Route reservation ${data.id} not found after create`);
    return created;
  }

  async updateReservation(
    id: string,
    data: { status?: RouteStatus; confirmedIndex?: number; reason?: string | null },
  ): Promise<RouteReservation> {
    this.db
      .update(routeReservations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(routeReservations.id, id))
      .run();
    const updated = await this.getReservation(id);
    if (!updated) throw new Error(`Route reservation ${id} not found after update`);
    return updated;
  }

  async markHoldsReleased(
    routeId: RouteId,
    holds: Array<{ kind: RouteHoldKind; targetId: string }>,
  ): Promise<void> {
    this.db.transaction((tx) => {
      for (const hold of holds) {
        tx.update(routeHolds)
          .set({ released: true })
          .where(
            and(
              eq(routeHolds.routeId, routeId),
              eq(routeHolds.kind, hold.kind),
              eq(routeHolds.targetId, hold.targetId),
            ),
          )
          .run();
      }
    });
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
