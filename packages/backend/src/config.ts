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
