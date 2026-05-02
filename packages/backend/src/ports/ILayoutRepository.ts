/**
 * Port: ILayoutRepository
 *
 * Defines the contract for persisting and retrieving layout configuration.
 * Implementation: DrizzleRepository (SQLite via Drizzle ORM).
 */

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
  deleteBlock(id: string): Promise<void>;

  // Points
  listPoints(layoutId: string): Promise<PointRecord[]>;
  createPoint(data: Omit<PointRecord, 'id'>): Promise<PointRecord>;
  updatePoint(id: string, data: Partial<Omit<PointRecord, 'id' | 'layoutId'>>): Promise<PointRecord>;
  deletePoint(id: string): Promise<void>;

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
}
