/**
 * Application configuration loaded from environment variables.
 * Copy .env.example to .env and customise for your setup.
 */

import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

// Resolve .env relative to this file so it is found regardless of cwd.
// src/ → packages/backend/ → packages/ → workspace root
loadEnv({ path: resolve(__dirname, '../../../.env') });

export const config = {
  http: {
    port: parseInt(process.env.HTTP_PORT ?? '3000', 10),
    host: process.env.HTTP_HOST ?? '0.0.0.0',
  },
  mqtt: {
    url: process.env.MQTT_URL ?? 'mqtt://localhost:1883',
    clientId: process.env.MQTT_CLIENT_ID ?? 'layout-orchestrator',
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
  },
  dcc: {
    serialPort: process.env.DCC_SERIAL_PORT ?? '/dev/ttyUSB0',
    baudRate: parseInt(process.env.DCC_BAUD_RATE ?? '115200', 10),
  },
  database: {
    path: process.env.DATABASE_PATH ?? './data/layout.db',
    migrationsFolder: process.env.MIGRATIONS_PATH ?? './migrations',
  },
  auth: {
    /**
     * Required to bootstrap the first admin account on an empty `users`
     * table (see `scripts/bootstrap-admin.ts`). Not read anywhere else —
     * there is deliberately no `AUTH_ENABLED` bypass flag.
     */
    initialAdminPassword: process.env.INITIAL_ADMIN_PASSWORD,
    cookieName: 'layout_session',
    /**
     * Config-driven, not hardcoded off: this stack runs over plain HTTP
     * today, so the cookie cannot be `Secure` yet (the browser would refuse
     * to send it and every session would silently fail to authenticate).
     * Once TLS lands, set COOKIE_SECURE=true — see docs/auth.md.
     */
    cookieSecure: process.env.COOKIE_SECURE === 'true',
  },
  frontend: {
    /**
     * #143: absolute or cwd-relative path to the built SPA
     * (`packages/frontend/dist`). When set, the backend serves it from `/` on
     * the same port as the API, which is what makes a deployment one process,
     * one port and one systemd unit — and what makes every browser request
     * same-origin, so the session cookie and the `/ws` upgrade need no CORS
     * consideration at all.
     *
     * Unset in development and in every test: `npm run dev:frontend` serves
     * the SPA from Vite and proxies /api and /ws here. Serving a stale `dist/`
     * underneath a running dev server is a confusing failure, so this is
     * opt-in rather than "serve it if the directory happens to exist".
     */
    distPath: process.env.FRONTEND_DIST_PATH,
  },
  cors: {
    /**
     * Explicit allowlist, not `origin: true` — see docs/auth.md. Comma-
     * separated so an operator can add an `https://` origin as TLS comes
     * online without a code change.
     */
    allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  },
  simulator: {
    /** Both DCC and MQTT are simulated — no hardware or broker required. */
    full: process.env.USE_SIMULATOR === 'true',
    /** Only DCC is simulated — connects to a real MQTT broker. */
    dccOnly: process.env.DCC_SIMULATOR === 'true',
    /**
     * #25 D9: how long (ms), on the process's real clock, `SimulatedPointController`
     * waits before publishing a `point/{id}/reading` in response to a
     * `point/{id}/query` or an in-process `noteCommanded` — the simulated
     * twin of a servo's physical travel time. Default 150ms is comfortably
     * inside D5's 8000ms confirmation timeout.
     */
    pointConfirmDelayMs: parseInt(process.env.POINT_SIM_CONFIRM_DELAY_MS ?? '150', 10),
  },
  points: {
    /**
     * D5 (docs/point-feedback.md): how long (ms) a point configured
     * `positionFeedback: "required"` may go unconfirmed after a command
     * before it faults.
     */
    confirmTimeoutMs: parseInt(process.env.POINT_CONFIRM_TIMEOUT_MS ?? '8000', 10),
    /** D5: how often (ms) the confirmation sweep evaluates the timeout predicate. */
    sweepIntervalMs: parseInt(process.env.POINT_CONFIRM_SWEEP_MS ?? '250', 10),
    /**
     * D4: consecutive confirming readings a latched `PointFault` needs before
     * an operator may acknowledge it. Layout-wide, not per-point — the
     * point-side twin of `sensors.clearAfterValidReadings`.
     */
    faultClearAfterConfirmations: parseInt(process.env.POINT_FAULT_CLEAR_CONFIRMATIONS ?? '1', 10),
  },
  sensors: {
    /**
     * D1 (docs/sensor-fault-recovery.md): consecutive valid, non-retained
     * readings a faulted sensor must publish before an operator may
     * acknowledge (clear) the fault.
     */
    clearAfterValidReadings: parseInt(process.env.SENSOR_FAULT_CLEAR_READINGS ?? '3', 10),
    /**
     * D11 (docs/sensor-trust.md): how long (ms) a sensor may go without a
     * LIVE reading before it is untrusted and every block it reports degrades
     * to `unknown`. Default 90 s = 3 x the contract's 30 s re-assert
     * interval, which absorbs two consecutive lost messages.
     *
     * Lowering it below twice the firmware interval flaps blocks to `unknown`
     * on ordinary packet loss.
     */
    freshnessTimeoutMs: parseInt(process.env.SENSOR_FRESHNESS_TIMEOUT_MS ?? '90000', 10),
    /**
     * D8/D11: how often (ms) the trust sweep re-evaluates freshness. Expiry
     * has no triggering message — that is the entire point of it — so a lazy
     * predicate would leave a block that went stale at 02:00 still reported
     * `clear` until something unrelated happened to ask.
     *
     * Its own timer, never folded into the heartbeat: that would make the
     * heartbeat interval load-bearing for a safety deadline.
     */
    trustSweepIntervalMs: parseInt(process.env.SENSOR_TRUST_SWEEP_MS ?? '5000', 10),
    /**
     * #65: bench-testing tool. When true the process can FABRICATE sensor
     * readings — it can make the orchestrator believe a block is clear while
     * a train stands in it. Off by default; never enabled on a live layout.
     * Gates constructing SensorSimulationService at all (D2), not a runtime
     * check.
     */
    simulationEnabled: process.env.SENSOR_SIMULATION === 'true',
  },
  log: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
} as const;
