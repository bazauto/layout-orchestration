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
  },
  log: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
} as const;
