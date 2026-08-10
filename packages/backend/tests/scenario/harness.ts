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
import { ReservationService, ReservationServiceLogger } from '../../src/services/ReservationService';
import { SensorSimulationService } from '../../src/services/SensorSimulationService';
import { NameBookCache } from '../../src/services/nameBook';
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
import {
  BlockEdge,
  LayoutEvent,
  RouteHoldKind,
  RouteReservation,
  RouteStatus,
  SimulatedReadingAction,
} from '../../src/domain/types';
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
  /** Test-only. Replaces the sensor set for a layout — needed by `sensorReports`. */
  _setSensors(sensors: SensorRecord[]): void;
  /** Test-only. Replaces the loco roster for a layout — a route grant requires the loco to be known (D13). */
  _setLocos(locos: LocoRecord[]): void;
  /**
   * Test-only. Inserts a row bypassing `parseBlockEdgeRow` — simulates a
   * `block_edges` row written outside the normal API (e.g. by hand, or by
   * data predating stricter validation), which the real DrizzleRepository
   * would only reject when *read* back, not on insert.
   */
  _insertRawEdgeRow(row: RawEdgeRow): void;
}

/** Raw route_reservations/route_holds "row" shape, mirroring RawEdgeRow's role for block_edges. */
interface StoredReservation {
  row: Omit<RouteReservation, 'holds'>;
  holds: Map<string, RouteReservation['holds'][number]>;
}

function makeInMemoryRepo(): InMemoryLayoutRepository {
  let blocks: BlockRecord[] = [];
  let points: PointRecord[] = [];
  let sensors: SensorRecord[] = [];
  let locos: LocoRecord[] = [];
  const edgeRows = new Map<string, RawEdgeRow>();
  const reservations = new Map<string, StoredReservation>();

  function rowsForLayout(layoutId: string): RawEdgeRow[] {
    return [...edgeRows.values()].filter((r) => r.layoutId === layoutId);
  }

  function toReservation(id: string): RouteReservation {
    const entry = reservations.get(id)!;
    return { ...entry.row, holds: [...entry.holds.values()] };
  }

  return {
    listLayouts: vi.fn().mockResolvedValue([]),
    getLayout: vi.fn().mockResolvedValue(null),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),

    listLocos: vi.fn().mockImplementation(async (layoutId: string) =>
      locos.filter((l) => l.layoutId === layoutId),
    ),
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

    listSensors: vi.fn().mockImplementation(async (layoutId: string) =>
      sensors.filter((s) => s.layoutId === layoutId),
    ),
    createSensor: vi.fn().mockImplementation(async (data: Omit<SensorRecord, 'id'>) => {
      const created: SensorRecord = { id: randomUUID(), ...data };
      sensors = [...sensors, created];
      return created;
    }),
    updateSensor: vi
      .fn()
      .mockImplementation(async (id: string, data: Partial<Omit<SensorRecord, 'id' | 'layoutId'>>) => {
        const index = sensors.findIndex((s) => s.id === id);
        if (index === -1) throw new Error(`Sensor ${id} not found after update`);
        const updated = { ...sensors[index], ...data };
        sensors = sensors.map((s, i) => (i === index ? updated : s));
        return updated;
      }),
    deleteSensor: vi.fn().mockImplementation(async (id: string) => {
      sensors = sensors.filter((s) => s.id !== id);
    }),

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

    // ── Route Reservations (see docs/route-locking.md) ──────────────────────

    listReservations: vi.fn().mockImplementation(async (layoutId: string, statuses?: RouteStatus[]) =>
      [...reservations.keys()]
        .map(toReservation)
        .filter((r) => r.layoutId === layoutId && (!statuses || statuses.includes(r.status))),
    ),
    getReservation: vi.fn().mockImplementation(async (id: string) =>
      reservations.has(id) ? toReservation(id) : null,
    ),
    createReservation: vi
      .fn()
      .mockImplementation(async (data: Omit<RouteReservation, 'createdAt' | 'updatedAt'>) => {
        const now = new Date();
        reservations.set(data.id, {
          row: {
            id: data.id,
            layoutId: data.layoutId,
            locoAddress: data.locoAddress,
            authority: data.authority,
            status: data.status,
            path: data.path,
            confirmedIndex: data.confirmedIndex,
            reason: data.reason,
            createdAt: now,
            updatedAt: now,
          },
          holds: new Map(data.holds.map((h) => [`${h.kind}:${h.targetId}`, { ...h }])),
        });
        return toReservation(data.id);
      }),
    updateReservation: vi
      .fn()
      .mockImplementation(
        async (id: string, data: { status?: RouteStatus; confirmedIndex?: number; reason?: string | null }) => {
          const entry = reservations.get(id);
          if (!entry) throw new Error(`Route reservation ${id} not found after update`);
          entry.row = { ...entry.row, ...data, updatedAt: new Date() };
          return toReservation(id);
        },
      ),
    markHoldsReleased: vi
      .fn()
      .mockImplementation(async (routeId: string, holds: Array<{ kind: RouteHoldKind; targetId: string }>) => {
        const entry = reservations.get(routeId);
        if (!entry) return;
        for (const h of holds) {
          const key = `${h.kind}:${h.targetId}`;
          const existing = entry.holds.get(key);
          if (existing) entry.holds.set(key, { ...existing, released: true });
        }
      }),

    _setBlocks(next: BlockRecord[]) {
      blocks = next;
    },
    _setPoints(next: PointRecord[]) {
      points = next;
    },
    _setSensors(next: SensorRecord[]) {
      sensors = next;
    },
    _setLocos(next: LocoRecord[]) {
      locos = next;
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
  reservationService: ReservationService;
  /**
   * #65: constructed unconditionally — the `SENSOR_SIMULATION` flag gate is
   * an `index.ts` concern, not a harness one. Exposed so a scenario can
   * assert directly on it if needed; most scenarios go through `inject`
   * below instead.
   */
  sensorSimulation: SensorSimulationService;
  /** The `INameBook` injected into `service` (and, from step 5, the other two) — exposed so a scenario can assert a rendered name reached a Safe-Stop reason or force a refresh directly. */
  nameBook: NameBookCache;
  /** All LayoutEvents emitted by `service`, in order, since harness creation. */
  events: LayoutEvent[];
  /**
   * Wall-clock source used for scenario assertions that need a
   * reference `Date` (e.g. comparing against a reservation's
   * `createdAt`/`updatedAt`). No scenario in this PR depends on
   * *simulated* elapsed time — D5 explicitly forbids timeout-based
   * release, so there is nothing time-dependent to fast-forward — but
   * exposing it here, rather than scenario tests calling `new Date()`
   * inline, keeps every timestamp reference in one place should that
   * change.
   */
  clock(): Date;
  /** Starts the service against the layout the harness was seeded with. */
  start(): Promise<void>;
  /**
   * Simulates an incoming reading from the named sensor (looked up via
   * `repo.listSensors`) and flushes microtasks so `LayoutService`'s
   * (now-async) sensor handling — including the `onOccupancyChange` call
   * into `ReservationService` — has settled before this resolves.
   * `options.retained` defaults to `false`; pass `true` to exercise the
   * broker reconnect-replay case (see docs/sensor-fault-recovery.md D1/D8).
   */
  sensorReports(
    sensorId: string,
    state: 'occupied' | 'clear',
    options?: { retained?: boolean },
  ): Promise<void>;
  /**
   * Injects through the REAL SensorSimulationService → SimulatedMqttAdapter →
   * LayoutService round trip — the whole point of #65 D1 is that this is the
   * hardware path, so scenarios must not shortcut it with simulateIncoming.
   * Flushes twice: once for the adapter's setImmediate delivery, once for
   * handleSensorReading's own awaits.
   */
  inject(sensorId: string, action: SimulatedReadingAction): Promise<void>;
}

/**
 * Builds a scenario harness with an empty layout (no blocks, points, edges,
 * sensors, or locos) — callers seed state via `repo._setBlocks` /
 * `_setPoints` / `repo._setSensors` / `repo._setLocos` /
 * `repo.createBlockEdge` / `repo._insertRawEdgeRow` before calling `start()`.
 *
 * `options.clearAfterValidReadings` is passed straight through to
 * `LayoutService`'s constructor (DD8) — a scenario can use a small
 * threshold (e.g. 2) rather than three round trips of `sensorReports`.
 */
export function createScenarioHarness(options?: { clearAfterValidReadings?: number }): ScenarioHarness {
  const repo = makeInMemoryRepo();
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const stateManager = new LayoutStateManager(LAYOUT_ID);
  // #54: exercises the whole naming chain end to end, so scenario assertions
  // can check that a book-supplied name reaches a Safe-Stop reason/log line,
  // not just that the id-only degradation path still works (unit-tested).
  const nameBook = new NameBookCache(repo, LAYOUT_ID);
  const reservationService = new ReservationService(repo, stateManager, silentLogger, nameBook);
  const service = new LayoutService(
    dcc,
    mqtt,
    repo,
    stateManager,
    reservationService,
    silentLogger,
    options,
    nameBook,
  );
  const topologyService = new TopologyService(
    repo,
    () => service.reloadTopology(),
    silentLogger,
    reservationService,
    nameBook,
  );
  // #65: unconditional — see the interface field's doc comment. The
  // scenario's LAYOUT_ID is always the layout `service.start` is called
  // against, so this never needs LayoutNotRunningError exercised here.
  const sensorSimulation = new SensorSimulationService(mqtt, repo, silentLogger, LAYOUT_ID, nameBook);

  const events: LayoutEvent[] = [];
  service.on('event', (event: LayoutEvent) => events.push(event));

  return {
    repo,
    mqtt,
    dcc,
    service,
    topologyService,
    reservationService,
    sensorSimulation,
    nameBook,
    events,
    clock: () => new Date(),
    start: () => service.start(LAYOUT_ID),
    inject: async (sensorId: string, action: SimulatedReadingAction) => {
      await sensorSimulation.inject(LAYOUT_ID, sensorId, action, { username: 'scenario-test' });
      // One flush for the adapter's setImmediate delivery back into
      // LayoutService, one for handleSensorReading's own awaits.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    sensorReports: async (
      sensorId: string,
      state: 'occupied' | 'clear',
      readingOptions?: { retained?: boolean },
    ) => {
      const sensors = await repo.listSensors(LAYOUT_ID);
      const sensor = sensors.find((s) => s.id === sensorId);
      if (!sensor) throw new Error(`sensorReports: unknown sensor ${sensorId}`);
      mqtt.simulateIncoming(
        sensor.mqttTopic,
        { state, updatedAt: new Date().toISOString() },
        readingOptions?.retained ?? false,
      );
      // handleSensorReading is fire-and-forget from the MQTT handler's
      // perspective (void-returning callback) — one microtask flush is
      // enough for its internal awaits (all against the in-memory repo
      // above, which resolves immediately) to settle, matching the same
      // `setImmediate` pattern used throughout the unit tests.
      await new Promise((r) => setImmediate(r));
    },
  };
}

// Re-exported for scenario tests that need to construct fixtures matching
// the reservation shape without importing from src/services directly.
export type { ReservationServiceLogger };
