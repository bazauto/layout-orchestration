/**
 * Scenario test harness.
 *
 * Wires `SimulatedMqttAdapter` and `SimulatedDccAdapter` into a real
 * `LayoutService` and `TopologyService`, backed by a real (in-memory)
 * `ILayoutRepository` implementation — so scenario tests exercise the
 * actual domain and service layers end to end, per `.claude/skills/scenario`.
 *
 * No real timers or network are involved: everything here runs synchronously
 * or via microtasks, so scenarios execute in milliseconds.
 */

import { vi } from 'vitest';
import { randomUUID } from 'crypto';
import { LayoutService, LayoutServiceLogger } from '../../src/services/LayoutService';
import { TopologyService, TopologyServiceLogger } from '../../src/services/TopologyService';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import {
  BlockRecord,
  GridTileRecord,
  ILayoutRepository,
  LocoRecord,
  PointRecord,
  SensorRecord,
} from '../../src/ports/ILayoutRepository';
import { BlockEdge, LayoutEvent } from '../../src/domain/types';
import { parseBlockEdgeRow } from '../../src/services/validation';

export const LAYOUT_ID = 'scenario-layout';

const silentLogger: LayoutServiceLogger & TopologyServiceLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** Raw block_edges "row" shape, as it would come back from SQLite — before parseBlockEdgeRow validates it. */
interface RawEdgeRow {
  id: string;
  layoutId: string;
  fromBlockId: string;
  fromEnd: unknown;
  toBlockId: string;
  toEnd: unknown;
  pointConditions: string;
  lengthMm: number | null;
}

export interface InMemoryLayoutRepository extends ILayoutRepository {
  /** Test-only. Replaces the block set for a layout. */
  _setBlocks(blocks: BlockRecord[]): void;
  /** Test-only. Replaces the point set for a layout. */
  _setPoints(points: PointRecord[]): void;
  /**
   * Test-only. Inserts a row bypassing `parseBlockEdgeRow` — simulates a
   * `block_edges` row written outside the normal API (e.g. by hand, or by
   * data predating stricter validation), which the real DrizzleRepository
   * would only reject when *read* back, not on insert.
   */
  _insertRawEdgeRow(row: RawEdgeRow): void;
}

function makeInMemoryRepo(): InMemoryLayoutRepository {
  let blocks: BlockRecord[] = [];
  let points: PointRecord[] = [];
  const edgeRows = new Map<string, RawEdgeRow>();

  function rowsForLayout(layoutId: string): RawEdgeRow[] {
    return [...edgeRows.values()].filter((r) => r.layoutId === layoutId);
  }

  return {
    listLayouts: vi.fn().mockResolvedValue([]),
    getLayout: vi.fn().mockResolvedValue(null),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),

    listLocos: vi.fn().mockResolvedValue([] as LocoRecord[]),
    getLoco: vi.fn().mockResolvedValue(null),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),

    listBlocks: vi.fn().mockImplementation(async (layoutId: string) =>
      blocks.filter((b) => b.layoutId === layoutId),
    ),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn().mockImplementation(async (id: string) => {
      blocks = blocks.filter((b) => b.id !== id);
      for (const [edgeId, row] of edgeRows) {
        if (row.fromBlockId === id || row.toBlockId === id) edgeRows.delete(edgeId);
      }
    }),

    listPoints: vi.fn().mockImplementation(async (layoutId: string) =>
      points.filter((p) => p.layoutId === layoutId),
    ),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn().mockImplementation(async (id: string) => {
      points = points.filter((p) => p.id !== id);
    }),

    listSensors: vi.fn().mockResolvedValue([] as SensorRecord[]),
    createSensor: vi.fn(),
    updateSensor: vi.fn(),
    deleteSensor: vi.fn(),

    listGridTiles: vi.fn().mockResolvedValue([] as GridTileRecord[]),
    upsertGridTile: vi.fn(),
    deleteTile: vi.fn(),
    clearGrid: vi.fn(),

    listBlockEdges: vi.fn().mockImplementation(async (layoutId: string) =>
      rowsForLayout(layoutId).map(parseBlockEdgeRow),
    ),
    getBlockEdge: vi.fn().mockImplementation(async (id: string) => {
      const row = edgeRows.get(id);
      return row ? parseBlockEdgeRow(row) : null;
    }),
    createBlockEdge: vi.fn().mockImplementation(async (data: Omit<BlockEdge, 'id'>) => {
      const id = randomUUID();
      const row: RawEdgeRow = {
        id,
        layoutId: data.layoutId,
        fromBlockId: data.fromBlockId,
        fromEnd: data.fromEnd,
        toBlockId: data.toBlockId,
        toEnd: data.toEnd,
        pointConditions: JSON.stringify(data.pointConditions),
        lengthMm: data.lengthMm,
      };
      edgeRows.set(id, row);
      return parseBlockEdgeRow(row);
    }),
    updateBlockEdge: vi
      .fn()
      .mockImplementation(async (id: string, data: Partial<Omit<BlockEdge, 'id' | 'layoutId'>>) => {
        const existing = edgeRows.get(id);
        if (!existing) throw new Error(`Edge ${id} not found`);
        const merged: RawEdgeRow = {
          ...existing,
          ...data,
          pointConditions:
            data.pointConditions !== undefined
              ? JSON.stringify(data.pointConditions)
              : existing.pointConditions,
        };
        edgeRows.set(id, merged);
        return parseBlockEdgeRow(merged);
      }),
    deleteBlockEdge: vi.fn().mockImplementation(async (id: string) => {
      edgeRows.delete(id);
    }),

    _setBlocks(next: BlockRecord[]) {
      blocks = next;
    },
    _setPoints(next: PointRecord[]) {
      points = next;
    },
    _insertRawEdgeRow(row: RawEdgeRow) {
      edgeRows.set(row.id, row);
    },
  };
}

export interface ScenarioHarness {
  repo: InMemoryLayoutRepository;
  mqtt: SimulatedMqttAdapter;
  dcc: SimulatedDccAdapter;
  service: LayoutService;
  topologyService: TopologyService;
  /** All LayoutEvents emitted by `service`, in order, since harness creation. */
  events: LayoutEvent[];
  /** Starts the service against the layout the harness was seeded with. */
  start(): Promise<void>;
}

/**
 * Builds a scenario harness with an empty layout (no blocks, points, edges,
 * or sensors) — callers seed state via `repo._setBlocks` / `_setPoints` /
 * `repo.createBlockEdge` / `repo._insertRawEdgeRow` before calling `start()`.
 */
export function createScenarioHarness(): ScenarioHarness {
  const repo = makeInMemoryRepo();
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const stateManager = new LayoutStateManager(LAYOUT_ID);
  const service = new LayoutService(dcc, mqtt, repo, stateManager, silentLogger);
  const topologyService = new TopologyService(
    repo,
    () => service.reloadTopology(),
    silentLogger,
  );

  const events: LayoutEvent[] = [];
  service.on('event', (event: LayoutEvent) => events.push(event));

  return {
    repo,
    mqtt,
    dcc,
    service,
    topologyService,
    events,
    start: () => service.start(LAYOUT_ID),
  };
}
