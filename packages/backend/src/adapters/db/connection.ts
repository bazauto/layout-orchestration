/**
 * Shared SQLite connection.
 *
 * `DrizzleRepository` and `DrizzleAuthRepository` both read and write the
 * same `layout.db` file. Each independently opening its own better-sqlite3
 * connection and independently calling `migrate()` on startup worked while
 * there was only one repository — two connections to one file, each running
 * its own migration pass, is the kind of thing that works until it doesn't.
 *
 * `openDatabase` is the sole place a connection is opened and migrated.
 * Call it once at startup (`index.ts`) and hand the returned handle to both
 * repositories, so there is exactly one better-sqlite3 connection and
 * exactly one migration run per process.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

export function openDatabase(dbPath: string, migrationsFolder: string): BetterSQLite3Database {
  // Ensure the data directory exists
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  // Enable WAL mode for better concurrent read performance
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite);
  // Apply any pending migrations automatically on startup
  migrate(db, { migrationsFolder });
  return db;
}
