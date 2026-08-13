/**
 * Port: ILayoutRepository
 *
 * Defines the contract for persisting and retrieving layout configuration.
 * Implementation: DrizzleRepository (SQLite via Drizzle ORM).
 */

import {
  BlockEdge,
  BlockEnd,
  RouteHoldKind,
  RouteId,
  RouteReservation,
  RouteStatus,
} from '../domain/types';

export interface LayoutRecord {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
}

export interface LocoRecord {
  id: string;
  layoutId: string;
  name: string;
  address: number;
  type: string;
  /** Maximum speed step (0–126). Useful for scaling throttle in the UI. */
  maxSpeed: number;
  /**
   * Braking factor (0.0–1.0). Used by the automation engine to calculate
   * stopping distances. 1.0 = stops immediately; lower values = longer braking.
   */
  brakingFactor: number;
}

export interface BlockRecord {
  id: string;
  layoutId: string;
  name: string;
  /**
   * Physical length in millimetres. `null` means unmeasured, which **refuses** a
   * braked run rather than guessing (`docs/braking.md` B4). Length is on the
   * block, not the edge (D4, `docs/track-graph-compilation.md`).
   */
  lengthMm: number | null;
}

export interface PointRecord {
  id: string;
  layoutId: string;
  name: string;
  /** DCC accessory address used to command this point via the DCC controller. */
  dccAddress: number;
  /** Block this point belongs to. */
  blockId: string | null;
}

export interface SensorRecord {
  id: string;
  layoutId: string;
  name: string;
  type: 'block_detection' | 'ir_position';
  /** The block whose occupancy this sensor reports. */
  blockId: string | null;
  /** The MQTT topic this sensor publishes its reading to. */
  mqttTopic: string;
  /** Whether the system trusts this sensor at all (see docs/sensor-fault-recovery.md D1/D3). */
  inService: boolean;
}

export interface GridTileRecord {
  id: string;
  layoutId: string;
  x: number;
  y: number;
  tileType: string;
  /** JSON blob for tile-specific metadata (e.g., linked point ID, linked block ID). */
  metadata: string;
}

/** One row of `compiled_graphs`: which drawing the live graph came from, and when (#103, D10). */
export interface CompiledGraphRecord {
  layoutId: string;
  drawingFingerprint: string;
  compiledAt: Date;
}

export interface ILayoutRepository {
  // Layouts
  listLayouts(): Promise<LayoutRecord[]>;
  getLayout(id: string): Promise<LayoutRecord | null>;
  createLayout(data: Omit<LayoutRecord, 'id' | 'createdAt'>): Promise<LayoutRecord>;
  deleteLayout(id: string): Promise<void>;

  // Locos
  listLocos(layoutId: string): Promise<LocoRecord[]>;
  getLoco(id: string): Promise<LocoRecord | null>;
  createLoco(data: Omit<LocoRecord, 'id'>): Promise<LocoRecord>;
  updateLoco(id: string, data: Partial<Omit<LocoRecord, 'id' | 'layoutId'>>): Promise<LocoRecord>;
  deleteLoco(id: string): Promise<void>;

  // Blocks
  listBlocks(layoutId: string): Promise<BlockRecord[]>;
  createBlock(data: Omit<BlockRecord, 'id'>): Promise<BlockRecord>;
  updateBlock(id: string, data: Partial<Omit<BlockRecord, 'id' | 'layoutId'>>): Promise<BlockRecord>;
  /**
   * Deletes a block. Implementations MUST also delete every `block_edges`
   * row that references this block as either `fromBlockId` or `toBlockId`,
   * atomically with the block delete — a dangling edge left behind by a
   * non-atomic delete is exactly the kind of corrupt topology that forces a
   * Safe-Stop on the next load.
   *
   * Scoped by `layoutId`: implementations MUST NOT delete a block belonging to
   * a different layout, even when the id is valid. The id alone is not
   * authority to delete.
   */
  deleteBlock(layoutId: string, id: string): Promise<void>;

  // Points
  listPoints(layoutId: string): Promise<PointRecord[]>;
  createPoint(data: Omit<PointRecord, 'id'>): Promise<PointRecord>;
  updatePoint(id: string, data: Partial<Omit<PointRecord, 'id' | 'layoutId'>>): Promise<PointRecord>;
  /** Scoped by `layoutId` for the same reason as {@link deleteBlock}. */
  deletePoint(layoutId: string, id: string): Promise<void>;

  // Sensors
  listSensors(layoutId: string): Promise<SensorRecord[]>;
  createSensor(data: Omit<SensorRecord, 'id'>): Promise<SensorRecord>;
  updateSensor(id: string, data: Partial<Omit<SensorRecord, 'id' | 'layoutId'>>): Promise<SensorRecord>;
  deleteSensor(id: string): Promise<void>;

  // Grid
  listGridTiles(layoutId: string): Promise<GridTileRecord[]>;
  upsertGridTile(data: Omit<GridTileRecord, 'id'>): Promise<GridTileRecord>;
  deleteTile(id: string): Promise<void>;
  clearGrid(layoutId: string): Promise<void>;

  // Block Edges
  listBlockEdges(layoutId: string): Promise<BlockEdge[]>;
  getBlockEdge(id: string): Promise<BlockEdge | null>;
  createBlockEdge(data: Omit<BlockEdge, 'id'>): Promise<BlockEdge>;
  updateBlockEdge(id: string, data: Partial<Omit<BlockEdge, 'id' | 'layoutId'>>): Promise<BlockEdge>;
  deleteBlockEdge(id: string): Promise<void>;

  // Block Ends (see docs/topology.md, #72)
  listBlockEnds(layoutId: string): Promise<BlockEnd[]>;
  getBlockEnd(id: string): Promise<BlockEnd | null>;
  createBlockEnd(data: Omit<BlockEnd, 'id'>): Promise<BlockEnd>;
  updateBlockEnd(id: string, data: { label?: string; pinned?: boolean }): Promise<BlockEnd>;
  deleteBlockEnd(id: string): Promise<void>;
  /**
   * Replaces every **unpinned** end of `blockId` with `labels`, atomically.
   *
   * One method rather than a delete loop plus an insert loop because that is
   * what regeneration is: a pinned end must survive it untouched, and a
   * half-applied regeneration would leave a block briefly holding neither the
   * old generated ends nor the new ones. Implementations MUST NOT touch a row
   * with `pinned = true`, and MUST skip a label a pinned row already holds —
   * the unique index on `(block_id, label)` is the backstop, not the plan.
   */
  replaceGeneratedBlockEnds(
    layoutId: string,
    blockId: string,
    labels: readonly string[],
  ): Promise<void>;

  // Compiled graph provenance (see docs/track-graph-compilation.md D10, #103)
  /**
   * The drawing the layout's current `block_edges` were compiled from, or
   * `null` if the graph has never been compiled.
   *
   * `null` and "a fingerprint that no longer matches the drawing" are different
   * answers and both are ordinary: the first says the graph is unbuilt, the
   * second that it is behind the drawing. Neither is an error — staleness is a
   * warning, never a gate (D10).
   */
  getCompiledGraph(layoutId: string): Promise<CompiledGraphRecord | null>;
  /**
   * Replaces this layout's **entire** `block_edges` set and records the drawing
   * it was compiled from, in ONE transaction (#103, D9/D10).
   *
   * A partially applied graph is precisely the write-then-discover failure the
   * apply path exists to prevent: implementations MUST NOT leave the old edges
   * deleted and the new ones uninserted, and MUST NOT record the fingerprint of
   * a graph that did not store. If any insert fails — the unique index on
   * `(layout_id, from_block_id, from_end, to_block_id, to_end)` is the likely
   * one — the layout must be left exactly as it was found, still describing the
   * railway the pathfinder has been planning on.
   *
   * Same atomicity contract `createReservation` documents, and load-bearing for
   * the same reason: the alternative is a graph that half-describes a railway
   * and a Safe-Stop on the next reload caused by an authoring action.
   */
  replaceBlockEdges(
    layoutId: string,
    edges: readonly Omit<BlockEdge, 'id' | 'layoutId'>[],
    fingerprint: string,
    compiledAt: Date,
  ): Promise<BlockEdge[]>;

  // Route Reservations (see docs/route-locking.md)
  listReservations(layoutId: string, statuses?: RouteStatus[]): Promise<RouteReservation[]>;
  getReservation(id: string): Promise<RouteReservation | null>;
  /**
   * Writes the reservation row and every one of its hold rows in ONE
   * transaction. A reservation with a partial hold set (some holds
   * persisted, some not) is exactly the corruption D3's atomicity
   * requirement exists to prevent — implementations MUST NOT leave a
   * reservation row with a subset of its holds committed. Matches the
   * atomicity contract `deleteBlock` documents for its own transaction.
   */
  createReservation(data: Omit<RouteReservation, 'createdAt' | 'updatedAt'>): Promise<RouteReservation>;
  updateReservation(
    id: string,
    data: { status?: RouteStatus; confirmedIndex?: number; reason?: string | null },
  ): Promise<RouteReservation>;
  /** Marks the named holds of `routeId` as released (D5/D6/D8 release paths). Never deletes — see the `route_holds.released` column comment in `schema.ts`. */
  markHoldsReleased(
    routeId: RouteId,
    holds: Array<{ kind: RouteHoldKind; targetId: string }>,
  ): Promise<void>;
}
