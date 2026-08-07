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
import { openDatabase } from '../../src/adapters/db/connection';

const MIGRATIONS_FOLDER = join(__dirname, '../../migrations');

describe('migrations', () => {
  let tempDir: string;
  let dbPath: string;
  let sqlite: Database.Database;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'layout-orchestrator-migrations-'));
    dbPath = join(tempDir, `${randomUUID()}.db`);
    // openDatabase applies all pending migrations before returning.
    const db = openDatabase(dbPath, MIGRATIONS_FOLDER);
    new DrizzleRepository(db);
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

  // ── DB-level topology invariants (block_edges CHECK/UNIQUE constraints) ──────
  //
  // These insert directly against the raw better-sqlite3 handle so they exercise
  // the constraints themselves, independent of any application-layer validation.

  describe('block_edges invariants', () => {
    let edgeCounter = 0;

    // block_edges has FK references to layouts/blocks (better-sqlite3 enables
    // foreign_keys enforcement by default, independent of the deferred #18
    // pragma work on DrizzleRepository itself), so a fixed pool of parent
    // rows is created up front for these constraint-only inserts to reference.
    beforeAll(() => {
      sqlite
        .prepare('INSERT INTO layouts (id, name, created_at) VALUES (?, ?, ?)')
        .run('layout-1', 'Test Layout', Date.now());
      const insertBlock = sqlite.prepare('INSERT INTO blocks (id, layout_id, name) VALUES (?, ?, ?)');
      for (const blockId of [
        'block-a',
        'block-b',
        'same-block',
        'throat',
        'platform-1',
        'platform-2',
        'x',
        'y',
      ]) {
        insertBlock.run(blockId, 'layout-1', blockId);
      }
    });

    function insertEdge(overrides: {
      fromBlockId?: string;
      fromEnd?: string;
      toBlockId?: string;
      toEnd?: string;
      lengthMm?: number | null;
    }): void {
      edgeCounter += 1;
      const row = {
        id: `edge-${edgeCounter}`,
        layoutId: 'layout-1',
        fromBlockId: overrides.fromBlockId ?? 'block-a',
        fromEnd: overrides.fromEnd ?? 'east',
        toBlockId: overrides.toBlockId ?? 'block-b',
        toEnd: overrides.toEnd ?? 'west',
        lengthMm: overrides.lengthMm === undefined ? null : overrides.lengthMm,
      };
      sqlite
        .prepare(
          `INSERT INTO block_edges (id, layout_id, from_block_id, from_end, to_block_id, to_end, length_mm)
           VALUES (@id, @layoutId, @fromBlockId, @fromEnd, @toBlockId, @toEnd, @lengthMm)`,
        )
        .run(row);
    }

    it('rejects a self-loop', () => {
      expect(() => insertEdge({ fromBlockId: 'same-block', toBlockId: 'same-block' })).toThrow();
    });

    it('rejects length_mm of 0 and -5, but allows NULL', () => {
      expect(() => insertEdge({ lengthMm: 0 })).toThrow();
      expect(() => insertEdge({ lengthMm: -5 })).toThrow();
      expect(() => insertEdge({ lengthMm: null })).not.toThrow();
    });

    it('rejects a blank from_end', () => {
      expect(() => insertEdge({ fromEnd: '   ' })).toThrow();
    });

    it('allows two edges from the SAME (from_block_id, from_end) to DIFFERENT blocks — the design decision this table encodes', () => {
      // A turnout's throw side (throat/east) fans out to two different
      // platforms depending on point position. Both edges are valid; the
      // point_conditions column (not a DB constraint) discriminates them.
      expect(() =>
        insertEdge({ fromBlockId: 'throat', fromEnd: 'east', toBlockId: 'platform-1' }),
      ).not.toThrow();
      expect(() =>
        insertEdge({ fromBlockId: 'throat', fromEnd: 'east', toBlockId: 'platform-2' }),
      ).not.toThrow();
    });

    it('rejects a duplicate full connection tuple', () => {
      insertEdge({ fromBlockId: 'x', fromEnd: 'east', toBlockId: 'y', toEnd: 'west' });
      expect(() =>
        insertEdge({ fromBlockId: 'x', fromEnd: 'east', toBlockId: 'y', toEnd: 'west' }),
      ).toThrow();
    });
  });
});
