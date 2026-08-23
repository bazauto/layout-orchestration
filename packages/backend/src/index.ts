/**
 * Application entry point.
 *
 * Wires together config, adapters, services, and the HTTP/WebSocket server.
 * Adapter selection (real vs. simulated) is driven by the USE_SIMULATOR config flag.
 */

import { config } from './config';
import { LayoutStateManager } from './domain/layoutState';
import { SimulatedDccAdapter } from './adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from './adapters/mqtt/SimulatedMqttAdapter';
import { MqttAdapter } from './adapters/mqtt/MqttAdapter';
import { SystemClock } from './adapters/clock/SystemClock';
import { SimulatedPointController } from './adapters/simulator/SimulatedPointController';
import { openDatabase } from './adapters/db/connection';
import { DrizzleRepository } from './adapters/db/repository';
import { DrizzleAuthRepository } from './adapters/db/authRepository';
import { LayoutService } from './services/LayoutService';
import { TopologyService } from './services/TopologyService';
import { CompileService } from './services/CompileService';
import { IGraphCompletenessView } from './ports/IGraphCompletenessView';
import { ReservationService } from './services/ReservationService';
import { PointConfirmationService } from './services/PointConfirmationService';
import { SensorSimulationService } from './services/SensorSimulationService';
import { NameBookCache } from './services/nameBook';
import { AuthService } from './services/AuthService';
import { bootstrapAdminIfNeeded } from './services/bootstrapAdmin';
import { buildServer } from './transport/http/server';
import { IDccController } from './ports/IDccController';
import { IMqttAdapter } from './ports/IMqttAdapter';

async function main() {
  // One connection, shared between both repositories — see
  // adapters/db/connection.ts for why.
  const db = openDatabase(config.database.path, config.database.migrationsFolder);
  const repo = new DrizzleRepository(db);
  const authRepo = new DrizzleAuthRepository(db);

  // ── Ensure at least one admin account exists ──────────────────────────────────
  // Throws (and main().catch() below exits the process) if the users table
  // is empty and INITIAL_ADMIN_PASSWORD isn't set — there is deliberately no
  // AUTH_ENABLED bypass, so a fresh deployment must be given a way to log in
  // before it can start. See services/bootstrapAdmin.ts.
  await bootstrapAdminIfNeeded(authRepo, config.auth.initialAdminPassword, {
    info: (msg, data) => console.log(msg, data ?? ''),
  });

  // ── Ensure at least a default layout exists ──────────────────────────────────
  let layouts = await repo.listLayouts();
  if (layouts.length === 0) {
    const defaultLayout = await repo.createLayout({
      name: 'Default Layout',
      description: 'Auto-created on first run. Rename via the API.',
    });
    layouts = [defaultLayout];
    console.log(`[Bootstrap] Created default layout: ${defaultLayout.id}`);
  }
  const activeLayoutId = process.env.LAYOUT_ID ?? layouts[0].id;

  // ── Adapter Selection ─────────────────────────────────────────────────────────
  //
  //  Mode              USE_SIMULATOR  DCC_SIMULATOR  DCC              MQTT
  //  ────────────────  ─────────────  ─────────────  ───────────────  ─────────────
  //  Full simulator    true           any            SimulatedDcc     SimulatedMqtt
  //  Hybrid (default   false          true           SimulatedDcc     Real broker
  //    dev workflow)
  //  Full hardware     false          false          Serial DCC EX    Real broker
  //
  let dcc: IDccController;
  let mqtt: IMqttAdapter;

  const adapterLogger = {
    info: (msg: string, data?: Record<string, unknown>) =>
      process.stdout.write(JSON.stringify({ level: 'info', msg, ...data }) + '\n'),
    warn: (msg: string, data?: Record<string, unknown>) =>
      process.stdout.write(JSON.stringify({ level: 'warn', msg, ...data }) + '\n'),
    error: (msg: string, data?: Record<string, unknown>) =>
      process.stdout.write(JSON.stringify({ level: 'error', msg, ...data }) + '\n'),
  };

  if (config.simulator.full) {
    dcc = new SimulatedDccAdapter(adapterLogger);
    mqtt = new SimulatedMqttAdapter();
    console.log('[Bootstrap] Mode: FULL SIMULATOR — no broker or hardware required');
  } else if (config.simulator.dccOnly) {
    dcc = new SimulatedDccAdapter(adapterLogger);
    mqtt = new MqttAdapter(
      {
        url: config.mqtt.url,
        clientId: config.mqtt.clientId,
        username: config.mqtt.username,
        password: config.mqtt.password,
        lwtTopic: `layout/${activeLayoutId}/system/status`,
        lwtPayload: { status: 'offline', mode: 'manual', reason: 'Unexpected disconnect' },
      },
      adapterLogger,
    );
    console.log('[Bootstrap] Mode: HYBRID — real MQTT broker, simulated DCC');
  } else {
    // NOTE the `.js` extension, which is required *here and only here*. Static
    // relative imports across the backend stay extensionless (CommonJS
    // resolution); a dynamic `import()` always carries ESM semantics under
    // moduleResolution Node16, so it needs the emitted file's extension. See
    // CLAUDE.md's Conventions section. This import is lazy on purpose: it keeps
    // `serialport` out of the process entirely in simulator mode.
    const { SerialDccAdapter } = await import('./adapters/dcc/SerialDccAdapter.js');
    dcc = new SerialDccAdapter(
      { path: config.dcc.serialPort, baudRate: config.dcc.baudRate },
      adapterLogger,
    );
    mqtt = new MqttAdapter(
      {
        url: config.mqtt.url,
        clientId: config.mqtt.clientId,
        username: config.mqtt.username,
        password: config.mqtt.password,
        lwtTopic: `layout/${activeLayoutId}/system/status`,
        lwtPayload: { status: 'offline', mode: 'manual', reason: 'Unexpected disconnect' },
      },
      adapterLogger,
    );
    console.log('[Bootstrap] Mode: FULL HARDWARE — real MQTT broker and DCC EX serial');
  }

  // ── Service & Server ──────────────────────────────────────────────────────────
  // ReservationService is constructed before LayoutService and
  // TopologyService, and passed to both — LayoutService calls into it to
  // grant/cancel/suspend/resume routes and react to occupancy changes;
  // TopologyService depends on it only through the read-only IRouteLockView
  // port (D10).
  const stateManager = new LayoutStateManager(activeLayoutId);
  // #54: one cache, bound to the running layout, shared by all three
  // services (and the transport layer below) — see docs/naming.md D4.
  const nameBook = new NameBookCache(repo, activeLayoutId);
  const reservationService = new ReservationService(repo, stateManager, adapterLogger, nameBook);

  // #25: one clock and one PointConfirmationService for the whole process,
  // constructed before LayoutService (which owns the confirmation sweep and
  // ingestion) and before the simulated point controller (which needs the
  // same clock so a test driving both from one ManualClock stays coherent).
  const clock = new SystemClock();
  const pointConfirmations = new PointConfirmationService(stateManager, {
    timeoutMs: config.points.confirmTimeoutMs,
  });

  // #25 D9: a genuine simulated twin of the ESP point controller — ships
  // whenever either simulator mode is active (CLAUDE.md safety rule 5),
  // never against real hardware. Its `noteCommanded` hook is wired below as
  // LayoutService's optional `onPointCommanded` callback, captured by
  // reference so it is safe for the variable to be assigned AFTER
  // LayoutService is constructed (the dccOnly branch below) — nothing
  // commands a point before `layoutService.start()` has resolved.
  //
  // SUBSCRIBE TIMING differs by mode. `SimulatedMqttAdapter.subscribe` is
  // synchronous/local and safe before `connect()`, so in FULL simulator mode
  // the controller subscribes right away — early enough to catch
  // `layoutService.start()`'s own startup `point/*/query` (D2), not only
  // ones sent on a later reconnect. The real `MqttAdapter.subscribe` gives no
  // such guarantee before its client has connected (it would hang awaiting a
  // subscribe callback that never fires), so in HYBRID (dccOnly) mode the
  // controller is constructed and subscribed only once `layoutService.start()`
  // has connected the real broker — the cost is that the very first startup
  // query can race the subscription and go unanswered, which is not a safety
  // concern (D6: the backend stays correct with no answer, and D2 re-issues
  // the same query on the next reconnect).
  let simulatedPointController: SimulatedPointController | undefined;
  if (config.simulator.full) {
    simulatedPointController = new SimulatedPointController(mqtt, clock, activeLayoutId, adapterLogger, {
      confirmDelayMs: config.simulator.pointConfirmDelayMs,
    });
    await simulatedPointController.start();
  }

  // #103: `LayoutService` needs the gap count to gate `auto`, `CompileService`
  // needs `TopologyService` to apply, and `TopologyService` needs
  // `layoutService.reloadTopology` — a three-way cycle broken here, at the one
  // edge that is genuinely late: the gap count is only ever read when an
  // operator changes mode or a reload finishes, both long after construction.
  // The port stays honest about it — before the compiler exists there is
  // nothing to say about completeness, so it says nothing and gates nothing.
  let compileService: CompileService | undefined;
  const completeness: IGraphCompletenessView = {
    gapCount: async (layoutId) => (compileService ? compileService.gapCount(layoutId) : 0),
  };
  const layoutService = new LayoutService(
    dcc,
    mqtt,
    repo,
    stateManager,
    reservationService,
    adapterLogger,
    // #65 R6: narrowed rather than passing `config.sensors` wholesale —
    // structural typing would let `simulationEnabled` compile straight
    // through, which is misleading: LayoutService has no use for the flag.
    {
      clearAfterValidReadings: config.sensors.clearAfterValidReadings,
      pointSweepIntervalMs: config.points.sweepIntervalMs,
      pointFaultClearAfterConfirmations: config.points.faultClearAfterConfirmations,
      sensorFreshnessTimeoutMs: config.sensors.freshnessTimeoutMs,
      sensorTrustSweepMs: config.sensors.trustSweepIntervalMs,
    },
    nameBook,
    completeness,
    clock,
    pointConfirmations,
    // D9: captured by reference — see the comment above `simulatedPointController`.
    (pointId, position) => simulatedPointController?.noteCommanded(pointId, position),
  );
  const topologyService = new TopologyService(
    repo,
    () => layoutService.reloadTopology(),
    adapterLogger,
    reservationService,
    nameBook,
  );
  compileService = new CompileService(repo, topologyService);
  const authService = new AuthService(authRepo, adapterLogger);

  // #65 D2: the flag gates constructing the service at all, not a runtime
  // check inside it — with SENSOR_SIMULATION unset (the default), this
  // process never has the ability to fabricate a reading.
  const sensorSimulation = config.sensors.simulationEnabled
    ? new SensorSimulationService(mqtt, repo, adapterLogger, activeLayoutId, nameBook)
    : undefined;
  if (sensorSimulation) {
    adapterLogger.warn(
      '[Bootstrap] SENSOR SIMULATION ENABLED — this process can fabricate sensor readings',
      { layoutId: activeLayoutId },
    );
  }

  await layoutService.start(activeLayoutId);

  // HYBRID mode's real broker connection is only guaranteed live once
  // layoutService.start() above has resolved — see the comment on
  // `simulatedPointController`'s construction.
  if (config.simulator.dccOnly && !simulatedPointController) {
    simulatedPointController = new SimulatedPointController(mqtt, clock, activeLayoutId, adapterLogger, {
      confirmDelayMs: config.simulator.pointConfirmDelayMs,
    });
    await simulatedPointController.start();
  }

  const server = await buildServer(
    layoutService,
    repo,
    config.log.level,
    topologyService,
    authService,
    {
      cookieName: config.auth.cookieName,
      cookieSecure: config.auth.cookieSecure,
      corsAllowedOrigins: config.cors.allowedOrigins,
    },
    nameBook,
    sensorSimulation,
    // The same instance the `auto` gate reads through, so there is exactly one
    // compiler in the process.
    compileService,
    // #143: set in a deployment, unset in development (Vite serves the SPA).
    config.frontend.distPath,
  );
  await server.listen({ port: config.http.port, host: config.http.host });
  console.log(
    config.frontend.distPath
      ? `[Bootstrap] Serving the operator UI from ${config.frontend.distPath}`
      : '[Bootstrap] FRONTEND_DIST_PATH unset — API only, no operator UI on this port',
  );

  // ── Graceful Shutdown ─────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    console.log(`[Shutdown] Received ${signal}`);
    await server.close();
    await layoutService.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
