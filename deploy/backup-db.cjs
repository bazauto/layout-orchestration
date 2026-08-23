#!/usr/bin/env node
/**
 * Layout database backup (#143).
 *
 * `VACUUM INTO`, never a file copy. `data/layout.db` runs in WAL mode with a
 * write-ahead log that reaches megabytes, so copying the `.db` alone produces
 * a backup that restores cleanly and is missing the most recent session's
 * work — which has already cost one round of wrong conclusions on this project
 * (CLAUDE.md records it under Open limits). `VACUUM INTO` asks SQLite for a
 * consistent snapshot of the *logical* database, WAL included, and writes it
 * as a single self-contained file.
 *
 * Run by layout-orchestrator-backup.service on a daily timer, and safe to run
 * by hand at any time — it takes a read snapshot and never touches the source.
 *
 * Deliberately plain CommonJS with no build step and no new dependency: it
 * borrows `better-sqlite3` from the backend workspace, which is already
 * installed and is the same SQLite build the backend itself writes with. A
 * `sqlite3` CLI would be a second, differently-versioned SQLite on the box and
 * is not installed there anyway.
 *
 * Configuration comes from the same .env the service reads:
 *   DATABASE_PATH  source database        (default ./data/layout.db)
 *   BACKUP_DIR     destination directory  (default ./backups)
 *   BACKUP_KEEP    snapshots retained     (default 14)
 */

const fs = require('fs');
const path = require('path');

// Resolved *as if from the backend workspace*, not by a hardcoded path: npm
// hoists better-sqlite3 to the root node_modules, so
// packages/backend/node_modules/better-sqlite3 does not exist. `paths` makes
// Node walk up from the workspace the way a require inside it would, which
// finds the dependency whether it is hoisted or nested.
const Database = require(
  require.resolve('better-sqlite3', { paths: [path.join(__dirname, '..', 'packages', 'backend')] }),
);

const dbPath = path.resolve(process.env.DATABASE_PATH || './data/layout.db');
const backupDir = path.resolve(process.env.BACKUP_DIR || './backups');
const keep = Number.parseInt(process.env.BACKUP_KEEP || '14', 10);

if (!Number.isInteger(keep) || keep < 1) {
  console.error(`[Backup] BACKUP_KEEP must be a positive integer, got ${process.env.BACKUP_KEEP}`);
  process.exit(1);
}

/** `layout-20260823T084500Z.db` — sorts lexicographically in time order. */
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const outPath = path.join(backupDir, `layout-${stamp}.db`);

fs.mkdirSync(backupDir, { recursive: true });

// fileMustExist so a mistyped DATABASE_PATH fails loudly. Without it
// better-sqlite3 would create an empty database and this script would
// cheerfully back up nothing, every night, until someone needed a restore.
//
// Opened read-write rather than readonly: the snapshot itself is read-only
// (VACUUM INTO never modifies the source), but a readonly connection to a WAL
// database still has to map the -shm file, which is the one thing that fails
// for reasons unrelated to this backup.
let db;
try {
  db = new Database(dbPath, { fileMustExist: true });
} catch (err) {
  console.error(`[Backup] Cannot open ${dbPath}: ${err.message}`);
  process.exit(1);
}

try {
  // Parameterless: VACUUM INTO takes a literal, not a bound parameter. The
  // path is operator configuration from .env, not anything user-supplied, and
  // a single quote in it would be a syntax error rather than an injection.
  db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
} catch (err) {
  console.error(`[Backup] VACUUM INTO ${outPath} failed: ${err.message}`);
  process.exit(1);
} finally {
  db.close();
}

const written = fs.statSync(outPath).size;
console.log(`[Backup] Wrote ${outPath} (${written} bytes) from ${dbPath}`);

// ── Retention ────────────────────────────────────────────────────────────────
// Only files this script's own naming produces are ever considered, so a
// hand-made copy dropped in the same directory is never deleted by the timer.
const snapshots = fs
  .readdirSync(backupDir)
  .filter((name) => /^layout-\d{8}T\d{6}Z\.db$/.test(name))
  .sort()
  .reverse();

for (const stale of snapshots.slice(keep)) {
  fs.unlinkSync(path.join(backupDir, stale));
  console.log(`[Backup] Pruned ${stale}`);
}

console.log(`[Backup] ${Math.min(snapshots.length, keep)} snapshot(s) retained in ${backupDir}`);
