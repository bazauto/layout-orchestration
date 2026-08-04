/**
 * Migration Integration Test
 *
 * Route/repository integration tests stub `ILayoutRepository`, so `migrate()`
 * never actually runs in CI. This test constructs a real `DrizzleRepository`
 * against a temp-file database — its constructor applies migrations
 * (repository.ts:43) — then inspects the resulting schema directly with
 * better-sqlite3 to confirm `block_edges` landed correctly.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DrizzleRepository } from '../../src/adapters/db/repository';

const MIGRATIONS_FOLDER = join(__dirname, '../../migrations');

describe('migrations', () => {
  let tempDir: string;
  let dbPath: string;
  let sqlite: Database.Database;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'layout-orchestrator-migrations-'));
    dbPath = join(tempDir, `${randomUUID()}.db`);
    // Constructing the repository applies all pending migrations.
    new DrizzleRepository(dbPath, MIGRATIONS_FOLDER);
    sqlite = new Database(dbPath);
  });

  afterAll(() => {
    sqlite.close();
    // DrizzleRepository does not expose a close() method, so its underlying
    // better-sqlite3 handle on dbPath stays open for the life of the process.
    // On Windows this can make the directory briefly un-removable; cleanup is
    // best-effort and must not fail the test run.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore — OS temp directory, cleaned up eventually regardless
    }
  });

  it('creates the block_edges table', () => {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'block_edges'")
      .get();
    expect(row).toBeDefined();
  });

  it('has exactly the eight expected columns, with correct nullability and defaults', () => {
    const columns = sqlite.prepare('PRAGMA table_info(block_edges)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;

    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'layout_id',
      'from_block_id',
      'from_end',
      'to_block_id',
      'to_end',
      'point_conditions',
      'length_mm',
    ]);

    const lengthMm = columns.find((c) => c.name === 'length_mm');
    expect(lengthMm?.notnull).toBe(0);

    const pointConditions = columns.find((c) => c.name === 'point_conditions');
    expect(pointConditions?.notnull).toBe(1);
    expect(pointConditions?.dflt_value).toBe("'[]'");
  });

  it('cascades on delete from blocks for both from_block_id and to_block_id', () => {
    const foreignKeys = sqlite.prepare('PRAGMA foreign_key_list(block_edges)').all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;

    const fromBlockFk = foreignKeys.find((fk) => fk.from === 'from_block_id');
    const toBlockFk = foreignKeys.find((fk) => fk.from === 'to_block_id');

    expect(fromBlockFk?.table).toBe('blocks');
    expect(fromBlockFk?.on_delete).toBe('CASCADE');
    expect(toBlockFk?.table).toBe('blocks');
    expect(toBlockFk?.on_delete).toBe('CASCADE');
  });
});
