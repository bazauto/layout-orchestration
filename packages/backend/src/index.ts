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
import { DrizzleRepository } from './adapters/db/repository';
import { LayoutService } from './services/LayoutService';
import { buildServer } from './transport/http/server';
import { IDccController } from './ports/IDccController';
import { IMqttAdapter } from './ports/IMqttAdapter';

async function main() {
  const repo = new DrizzleRepository(config.database.path, config.database.migrationsFolder);

  // ── Ensure at least a default layout exists ──────────────────────────────────
  let layouts = await repo.listLayouts();
  if (layouts.length === 0) {
    const defaultLayout = await repo.createLayout({
      name: 'Default Layout',
      description: 'Auto-created on first run. Rename via the API.',
    });
    layouts = [defaultLayout];
    // eslint-disable-next-line no-console
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
    const { SerialDccAdapter } = await import('./adapters/dcc/SerialDccAdapter');
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
  const stateManager = new LayoutStateManager(activeLayoutId);
  const layoutService = new LayoutService(dcc, mqtt, repo, stateManager, adapterLogger);
  await layoutService.start(activeLayoutId);

  const server = await buildServer(layoutService, repo, config.log.level);
  await server.listen({ port: config.http.port, host: config.http.host });

  // ── Graceful Shutdown ─────────────────────────────────────────────────────────
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[Shutdown] Received ${signal}`);
    await server.close();
    await layoutService.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[Fatal]', err);
  process.exit(1);
});
