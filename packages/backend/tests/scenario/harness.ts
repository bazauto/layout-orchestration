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
import { LayoutService, LayoutServiceLogger, LayoutServiceOptions } from '../../src/services/LayoutService';
import { TopologyService, TopologyServiceLogger } from '../../src/services/TopologyService';
import { ReservationService, ReservationServiceLogger } from '../../src/services/ReservationService';
import { SensorSimulationService } from '../../src/services/SensorSimulationService';
import { PointConfirmationService } from '../../src/services/PointConfirmationService';
import { NameBookCache } from '../../src/services/nameBook';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ManualClock } from '../../src/adapters/clock/ManualClock';
import { SimulatedPointController } from '../../src/adapters/simulator/SimulatedPointController';
import {
  BlockRecord,
  CompiledGraphRecord,
  GridTileRecord,
  ILayoutRepository,
  LocoRecord,
  PointRecord,
  SensorRecord,
} from '../../src/ports/ILayoutRepository';
import {
  BlockEdge,
  LayoutEvent,
  PointId,
  RouteHoldKind,
  RouteReservation,
  RouteStatus,
  SimulatedReadingAction,
} from '../../src/domain/types';
import { parseBlockEdgeRow } from '../../src/services/validation';

/**
 * #25 D5/D9: the same defaults `config.points` carries in `index.ts` — a
 * scenario exercising a timeout or a simulated controller response should
 * advance the harness's `ManualClock` by a multiple of these, not invent its
 * own numbers.
 */
export const POINT_CONFIRM_TIMEOUT_MS = 8000;
export const POINT_CONFIRM_SWEEP_MS = 250;
export const POINT_CONFIRM_DELAY_MS = 150;

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
  const compiledGraphs = new Map<string, CompiledGraphRecord>();
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
    // Resolves for the scenario layout and nothing else. It used to answer
    // `null` unconditionally, which was harmless while nothing looked — but
    // `CompileService` checks the layout exists before it reads a drawing, so a
    // blanket `null` turned every scenario compile into a 404.
    getLayout: vi
      .fn()
      .mockImplementation(async (id: string) =>
        id === LAYOUT_ID ? { id: LAYOUT_ID, name: 'Scenario Layout', createdAt: new Date() } : null,
      ),
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

    // ── Compiled graph provenance (#103) ────────────────────────────────────

    getCompiledGraph: vi.fn().mockImplementation(async (layoutId: string) =>
      compiledGraphs.get(layoutId) ?? null,
    ),
    replaceBlockEdges: vi
      .fn()
      .mockImplementation(
        async (
          layoutId: string,
          edges: readonly Omit<BlockEdge, 'id' | 'layoutId'>[],
          fingerprint: string,
          compiledAt: Date,
        ) => {
          // All-or-nothing in the real repository (one transaction). Nothing
          // here can fail part way, so the in-memory version just does both
          // halves — but keeping the *order* honest matters: the old rows go
          // before the new ones arrive.
          for (const [id, row] of [...edgeRows]) {
            if (row.layoutId === layoutId) edgeRows.delete(id);
          }
          for (const edge of edges) {
            const id = randomUUID();
            edgeRows.set(id, {
              id,
              layoutId,
              fromBlockId: edge.fromBlockId,
              fromEnd: edge.fromEnd,
              toBlockId: edge.toBlockId,
              toEnd: edge.toEnd,
              pointConditions: JSON.stringify(edge.pointConditions),
            });
          }
          compiledGraphs.set(layoutId, { layoutId, drawingFingerprint: fingerprint, compiledAt });
          return rowsForLayout(layoutId).map(parseBlockEdgeRow);
        },
      ),

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
            // #7 A7. Dropping this on the way into storage would leave every
            // scenario route with no direction, which automation reads as
            // "never depart" — a silent no-op rather than a failure.
            direction: data.direction,
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
  /**
   * #25: the simulated twin of the ESP point controller, wired to `service`
   * via the in-process `noteCommanded` hook exactly as `index.ts` wires it
   * (D9). Exposed so a scenario can select a failure mode with
   * `setMode`/`setDefaultMode` before commanding a point.
   */
  pointController: SimulatedPointController;
  /** All LayoutEvents emitted by `service`, in order, since harness creation. */
  events: LayoutEvent[];
  /**
   * Wall-clock source used for scenario assertions that need a
   * reference `Date` (e.g. comparing against a reservation's
   * `createdAt`/`updatedAt`). No scenario in this PR depends on
   * *simulated* elapsed time for ROUTE locking — D5 (docs/route-locking.md)
   * explicitly forbids timeout-based release, so there is nothing
   * time-dependent to fast-forward there — but exposing it here, rather
   * than scenario tests calling `new Date()` inline, keeps every timestamp
   * reference in one place should that change. Point confirmation (#25) is
   * genuinely time-dependent and runs on its OWN clock — see `advance`.
   */
  clock(): Date;
  /** Starts the service against the layout the harness was seeded with. */
  start(): Promise<void>;
  /**
   * Advances the harness's `ManualClock` — the one `LayoutService`,
   * `PointConfirmationService`'s sweep, and `pointController` all share
   * (#25 D5/D9) — by `ms`, firing every due timer in order, then flushes two
   * further macrotask hops so a simulated controller's publish and
   * `LayoutService`'s own await chain settle before this resolves (mirrors
   * `tests/integration/point-feedback.test.ts`'s documented double-flush).
   * No real timers anywhere in this harness — this is the only way virtual
   * time moves.
   */
  advance(ms: number): Promise<void>;
  /**
   * Issues a point command through `LayoutService.handlePointCommand` —
   * shorthand for the common case (no `force`). A scenario that needs
   * `force: true` calls `service.handlePointCommand` directly.
   */
  commandPoint(pointId: PointId, position: 'normal' | 'reverse'): Promise<void>;
  /**
   * The `retain` flag on the MOST RECENT publish to `topic`, reading
   * `mqtt.publishLog` — `undefined` if `topic` was never published to.
   * Control topics (`*\/command`, `*\/query`) must never be retained
   * (CLAUDE.md safety rule 4); this is how a scenario checks that on the
   * wire rather than trusting the adapter call site.
   */
  publishedRetained(topic: string): boolean | undefined;
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
 * `options` is passed straight through to `LayoutService`'s constructor
 * (DD8, extended by #25 to the point-confirmation thresholds) — a scenario
 * can use a small `clearAfterValidReadings`/`pointFaultClearAfterConfirmations`
 * rather than several round trips of `sensorReports`/readings.
 */
export function createScenarioHarness(options?: Partial<LayoutServiceOptions>): ScenarioHarness {
  const repo = makeInMemoryRepo();
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const stateManager = new LayoutStateManager(LAYOUT_ID);
  // #54: exercises the whole naming chain end to end, so scenario assertions
  // can check that a book-supplied name reaches a Safe-Stop reason/log line,
  // not just that the id-only degradation path still works (unit-tested).
  const nameBook = new NameBookCache(repo, LAYOUT_ID);
  const reservationService = new ReservationService(repo, stateManager, silentLogger, nameBook);

  // #25: one ManualClock for the whole harness — LayoutService's confirmation
  // sweep, PointConfirmationService's deadline arithmetic, and
  // pointController's response delay all read the SAME virtual clock, wired
  // exactly the way `index.ts` wires one `SystemClock` across the three real
  // equivalents. No real timers anywhere in this file.
  const pointClock = new ManualClock(new Date('2026-01-01T00:00:00.000Z'));
  const pointConfirmations = new PointConfirmationService(stateManager, {
    timeoutMs: POINT_CONFIRM_TIMEOUT_MS,
  });
  // D9: a genuine simulated twin of the ESP point controller — subscribes to
  // `point/+/query` and answers on `pointClock`, never a live MQTT command
  // (the backend has never published `point/*/command` — see the "asymmetry"
  // section of docs/point-feedback.md). `noteCommanded` is wired below as
  // `service`'s `onPointCommanded` hook, exactly as `index.ts` wires it.
  const pointController = new SimulatedPointController(mqtt, pointClock, LAYOUT_ID, silentLogger, {
    confirmDelayMs: POINT_CONFIRM_DELAY_MS,
  });

  const service = new LayoutService(
    dcc,
    mqtt,
    repo,
    stateManager,
    reservationService,
    silentLogger,
    options,
    nameBook,
    undefined, // completeness — INERT_GRAPH_COMPLETENESS default; no scenario here gates `auto` on gap count.
    pointClock,
    pointConfirmations,
    (pointId, position) => pointController.noteCommanded(pointId, position),
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
    pointController,
    events,
    clock: () => new Date(),
    start: async () => {
      // Safe before service.start()/mqtt.connect() — SimulatedMqttAdapter's
      // subscribe is local/synchronous, so this is early enough to catch
      // service.start()'s own startup point/*/query (D2), mirroring
      // index.ts's full-simulator-mode ordering.
      await pointController.start();
      await service.start(LAYOUT_ID);
      // The startup query's DELIVERY to pointController's subscription is a
      // REAL setImmediate (SimulatedMqttAdapter.publish), queued while
      // service.start() ran but not necessarily fired by the time it
      // resolves. One more flush here lets that delivery happen — and so
      // `pointController.scheduleResponse` register its ManualClock timer —
      // WHILE the clock is still at the instant `start()` left it, so the
      // very first `advance()` a scenario calls actually finds and fires it,
      // rather than racing it and silently pushing its due time later.
      await new Promise((r) => setImmediate(r));
    },
    advance: async (ms: number) => {
      await pointClock.advance(ms);
      // Two further macrotask hops for a simulated controller's publish and
      // LayoutService's own await chain to settle — mirrors
      // tests/integration/point-feedback.test.ts's documented advanceAndFlush.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
    commandPoint: (pointId: PointId, position: 'normal' | 'reverse') =>
      service.handlePointCommand({ pointId, position }),
    publishedRetained: (topic: string) => {
      const entries = mqtt.publishLog.filter((entry) => entry.topic === topic);
      return entries.length > 0 ? entries[entries.length - 1].retain : undefined;
    },
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
