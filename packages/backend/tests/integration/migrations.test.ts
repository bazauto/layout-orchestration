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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
  let repo: DrizzleRepository;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'layout-orchestrator-migrations-'));
    dbPath = join(tempDir, `${randomUUID()}.db`);
    // openDatabase applies all pending migrations before returning.
    const db = openDatabase(dbPath, MIGRATIONS_FOLDER);
    repo = new DrizzleRepository(db);
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

  // ── sensors.in_service (see docs/sensor-fault-recovery.md DD9) ────────────

  describe('sensors.in_service', () => {
    it('exists, is NOT NULL, and defaults to 1 (true)', () => {
      const columns = sqlite.prepare('PRAGMA table_info(sensors)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;
      const inService = columns.find((c) => c.name === 'in_service');
      expect(inService).toBeDefined();
      expect(inService?.notnull).toBe(1);
      expect(inService?.dflt_value).toBe('true');
    });

    it('an existing sensor row reads inService: true through DrizzleRepository', async () => {
      const layout = await repo.createLayout({
        name: 'Sensors Migration Layout',
        description: null,
      });
      const sensor = await repo.createSensor({
        layoutId: layout.id,
        name: 'Detector 1',
        type: 'block_detection',
        blockId: null,
        mqttTopic: `layout/${layout.id}/sensor/detector-1/reading`,
        inService: true,
      });
      expect(sensor.inService).toBe(true);
      const [reloaded] = await repo.listSensors(layout.id);
      expect(reloaded.inService).toBe(true);
    });
  });

  it('creates the block_edges table', () => {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'block_edges'")
      .get();
    expect(row).toBeDefined();
  });

  it('has exactly the seven expected columns, with correct nullability and defaults', () => {
    const columns = sqlite.prepare('PRAGMA table_info(block_edges)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;

    // No `length_mm`: distance is on the block now (D4). An edge is joint-only
    // and joints are treated as zero (D5).
    expect(columns.map((c) => c.name)).toEqual([
      'id',
      'layout_id',
      'from_block_id',
      'from_end',
      'to_block_id',
      'to_end',
      'point_conditions',
    ]);

    const pointConditions = columns.find((c) => c.name === 'point_conditions');
    expect(pointConditions?.notnull).toBe(1);
    expect(pointConditions?.dflt_value).toBe("'[]'");
  });

  it('carries length_mm on blocks, nullable and undefaulted', () => {
    const columns = sqlite.prepare('PRAGMA table_info(blocks)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;

    const lengthMm = columns.find((c) => c.name === 'length_mm');
    expect(lengthMm).toBeDefined();
    // Nullable and undefaulted: NULL is "unmeasured", which refuses a braked
    // run. A default would assert a measurement nobody took.
    expect(lengthMm?.notnull).toBe(0);
    expect(lengthMm?.dflt_value).toBeNull();
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

  // ── block_ends (#72, see docs/topology.md) ──────────────────────────────────

  describe('block_ends is gone (#103 PR 7)', () => {
    it('does not exist after migration', () => {
      const tables = (
        sqlite.prepare("select name from sqlite_master where type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((t) => t.name);

      expect(tables).not.toContain('block_ends');
      // Not a vacuous assertion: the query shape works, and the tables that
      // should survive did.
      expect(tables).toContain('block_edges');
      expect(tables).toContain('compiled_graphs');
    });

    it('leaves block_edges pointing at layouts and blocks, and nothing else', () => {
      // #72's decision outliving the table it was about. There was deliberately
      // no foreign key from `block_edges.from_end`/`to_end` to `block_ends` —
      // an FK would have made the adoption pass a chicken-and-egg problem and
      // changed a corrupt row's failure mode from Safe-Stop to write-refused, a
      // regression against #10. That absence is exactly what makes the drop a
      // clean one: no edge ever pointed here, so none can be orphaned.
      const fks = sqlite.prepare('PRAGMA foreign_key_list(block_edges)').all() as Array<{
        table: string;
      }>;

      expect([...new Set(fks.map((f) => f.table))].sort()).toEqual(['blocks', 'layouts']);
    });
  });

  describe('compiled_graphs', () => {
    it('exists with exactly the three columns, layout_id as the primary key', () => {
      const columns = sqlite.prepare('PRAGMA table_info(compiled_graphs)').all() as Array<{
        name: string;
        notnull: number;
        pk: number;
      }>;

      expect(columns.map((c) => c.name).sort()).toEqual([
        'compiled_at',
        'drawing_fingerprint',
        'layout_id',
      ]);
      // One row per layout, and *no* edge_count or gap_count: both are
      // recomputable from the drawing, and a stored copy would be a second
      // source of truth about the very thing #103 exists to stop having two of.
      expect(columns.find((c) => c.name === 'layout_id')?.pk).toBe(1);
      expect(columns.find((c) => c.name === 'drawing_fingerprint')?.notnull).toBe(1);
      expect(columns.find((c) => c.name === 'compiled_at')?.notnull).toBe(1);
    });

    it('cascades on layout delete, so provenance cannot outlive its layout', () => {
      const fks = sqlite.prepare('PRAGMA foreign_key_list(compiled_graphs)').all() as Array<{
        table: string;
        on_delete: string;
      }>;

      expect(fks).toHaveLength(1);
      expect(fks[0].table).toBe('layouts');
      expect(fks[0].on_delete).toBe('CASCADE');
    });

    it('reads back as null when a layout has never been compiled', async () => {
      const layout = await repo.createLayout({ name: 'Never Compiled', description: null });
      // A missing row, not a NULL column: "never compiled" is a different
      // statement from "compiled from a drawing that has since moved", and the
      // absence of a row is the honest spelling of the first.
      await expect(repo.getCompiledGraph(layout.id)).resolves.toBeNull();
    });

    it('reads a stored fingerprint back through DrizzleRepository', async () => {
      const layout = await repo.createLayout({ name: 'Compiled Layout', description: null });
      const compiledAt = new Date('2026-08-13T10:00:00.000Z');

      // Written raw: nothing in the application writes this table until the
      // apply lands, and a writer with no caller would be an untested path into
      // the record of which drawing the pathfinder's graph came from.
      sqlite
        .prepare(
          'INSERT INTO compiled_graphs (layout_id, drawing_fingerprint, compiled_at) VALUES (?, ?, ?)',
        )
        .run(layout.id, 'abc123', Math.floor(compiledAt.getTime() / 1000));

      const record = await repo.getCompiledGraph(layout.id);
      expect(record?.drawingFingerprint).toBe('abc123');
      expect(record?.compiledAt.toISOString()).toBe(compiledAt.toISOString());
    });
  });

  // ── DB-level topology invariants (block_edges CHECK/UNIQUE constraints) ──────
  //
  // These insert directly against the raw better-sqlite3 handle so they exercise
  // the constraints themselves, independent of any application-layer validation.

  describe('block_edges invariants', () => {
    let edgeCounter = 0;

    // block_edges has FK references to layouts/blocks (enforced both by the
    // driver default and, since #18, by the explicit
    // `sqlite.pragma('foreign_keys = ON')` in openDatabase), so a fixed pool
    // of parent rows is created up front for these constraint-only inserts
    // to reference.
    beforeAll(() => {
      sqlite
        .prepare('INSERT INTO layouts (id, name, created_at) VALUES (?, ?, ?)')
        .run('layout-1', 'Test Layout', Date.now());
      const insertBlock = sqlite.prepare(
        'INSERT INTO blocks (id, layout_id, name) VALUES (?, ?, ?)',
      );
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
    }): void {
      edgeCounter += 1;
      const row = {
        id: `edge-${edgeCounter}`,
        layoutId: 'layout-1',
        fromBlockId: overrides.fromBlockId ?? 'block-a',
        fromEnd: overrides.fromEnd ?? 'east',
        toBlockId: overrides.toBlockId ?? 'block-b',
        toEnd: overrides.toEnd ?? 'west',
      };
      sqlite
        .prepare(
          `INSERT INTO block_edges (id, layout_id, from_block_id, from_end, to_block_id, to_end)
           VALUES (@id, @layoutId, @fromBlockId, @fromEnd, @toBlockId, @toEnd)`,
        )
        .run(row);
    }

    // These four run against the table as **rebuilt** by 0008. Dropping
    // `length_mm` meant recreating `block_edges` from scratch, and a rebuild
    // that silently loses a CHECK or the unique index looks identical to a
    // successful one from the outside — so each surviving invariant is asserted
    // to still bite rather than assumed to have come across.

    it('rejects a self-loop', () => {
      expect(() => insertEdge({ fromBlockId: 'same-block', toBlockId: 'same-block' })).toThrow();
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

  // ── Route reservation invariants (route_reservations/route_holds) ───────────
  //
  // D2 (one route per block/point) and D13 (one active/suspended reservation
  // per loco per layout), enforced at the DB level per #11's posture — see
  // docs/route-locking.md.

  describe('route reservation invariants', () => {
    let routeCounter = 0;

    function insertReservation(overrides: {
      locoAddress?: number;
      status?: string;
      authority?: string;
      confirmedIndex?: number;
    }): string {
      routeCounter += 1;
      const id = `route-${routeCounter}`;
      const now = Date.now();
      sqlite
        .prepare(
          `INSERT INTO route_reservations (id, layout_id, loco_address, authority, status, path, confirmed_index, reason, created_at, updated_at)
           VALUES (@id, @layoutId, @locoAddress, @authority, @status, @path, @confirmedIndex, @reason, @now, @now)`,
        )
        .run({
          id,
          layoutId: 'layout-1',
          locoAddress: overrides.locoAddress ?? 3,
          authority: overrides.authority ?? 'manual',
          status: overrides.status ?? 'active',
          path: '[]',
          confirmedIndex: overrides.confirmedIndex ?? 0,
          reason: null,
          now,
        });
      return id;
    }

    function insertHold(
      routeId: string,
      overrides: {
        kind?: string;
        targetId?: string;
        released?: number;
      },
    ): void {
      sqlite
        .prepare(
          `INSERT INTO route_holds (id, route_id, layout_id, kind, target_id, required_position, release_after_index, released)
           VALUES (@id, @routeId, @layoutId, @kind, @targetId, NULL, 0, @released)`,
        )
        .run({
          id: `hold-${routeId}-${overrides.targetId ?? 'x'}-${overrides.released ?? 0}-${Math.random()}`,
          routeId,
          layoutId: 'layout-1',
          kind: overrides.kind ?? 'block',
          targetId: overrides.targetId ?? 'block-a',
          released: overrides.released ?? 0,
        });
    }

    it('rejects an invalid status', () => {
      expect(() => insertReservation({ status: 'bogus' })).toThrow();
    });

    it('rejects an invalid hold kind', () => {
      const routeId = insertReservation({});
      expect(() => insertHold(routeId, { kind: 'bogus' })).toThrow();
    });

    it('rejects a second active/suspended reservation for the same loco in the same layout', () => {
      insertReservation({ locoAddress: 77, status: 'active' });
      expect(() => insertReservation({ locoAddress: 77, status: 'suspended' })).toThrow();
    });

    it('allows a released reservation to coexist with a later active one for the same loco', () => {
      insertReservation({ locoAddress: 88, status: 'released' });
      expect(() => insertReservation({ locoAddress: 88, status: 'active' })).not.toThrow();
    });

    it('rejects two routes holding the same block while both unreleased', () => {
      const routeA = insertReservation({ locoAddress: 101 });
      const routeB = insertReservation({ locoAddress: 102 });
      insertHold(routeA, { kind: 'block', targetId: 'shared-block', released: 0 });
      expect(() =>
        insertHold(routeB, { kind: 'block', targetId: 'shared-block', released: 0 }),
      ).toThrow();
    });

    it('allows the same block to be held again once the first hold is released', () => {
      const routeA = insertReservation({ locoAddress: 111 });
      const routeB = insertReservation({ locoAddress: 112 });
      insertHold(routeA, { kind: 'block', targetId: 'reusable-block', released: 1 });
      expect(() =>
        insertHold(routeB, { kind: 'block', targetId: 'reusable-block', released: 0 }),
      ).not.toThrow();
    });
  });

  // ── Last-admin guard triggers (Q1, docs/auth.md, issue #53) ────────────────
  //
  // Raw sqlite handle, independent of any application code (AuthService/
  // DrizzleAuthRepository) — this proves the DB half of the guard on its own.
  // Each test gets its OWN fresh temp-file database (via `withFreshDb`, same
  // pattern as repository-auth.test.ts's `hasAnyUsers` isolation) rather than
  // sharing the outer `sqlite` handle: the trigger's condition counts every
  // admin row currently in the whole table, so a "sole admin" scenario must
  // start from a table nothing else has touched.

  describe('users last-admin invariant', () => {
    let userCounter = 0;

    function withFreshDb<T>(fn: (raw: Database.Database) => T): T {
      const dir = mkdtempSync(join(tmpdir(), 'layout-orchestrator-last-admin-'));
      const path = join(dir, `${randomUUID()}.db`);
      openDatabase(path, MIGRATIONS_FOLDER); // applies migrations; drizzle handle unused here
      const raw = new Database(path);
      try {
        return fn(raw);
      } finally {
        raw.close();
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore — OS temp directory, cleaned up eventually regardless
        }
      }
    }

    function insertUser(raw: Database.Database, overrides: { role?: string }): string {
      userCounter += 1;
      const id = `user-${userCounter}`;
      raw
        .prepare(
          `INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, `user-${userCounter}`, 'x', overrides.role ?? 'admin', Date.now());
      return id;
    }

    it('both triggers exist', () => {
      withFreshDb((raw) => {
        const triggers = raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
          .all() as Array<{ name: string }>;
        const names = triggers.map((t) => t.name);
        expect(names).toContain('users_last_admin_no_demote');
        expect(names).toContain('users_last_admin_no_delete');
      });
    });

    it('refuses to demote the sole admin', () => {
      withFreshDb((raw) => {
        const admin = insertUser(raw, { role: 'admin' });
        expect(() =>
          raw.prepare("UPDATE users SET role = 'operator' WHERE id = ?").run(admin),
        ).toThrow();
      });
    });

    it('refuses to delete the sole admin', () => {
      withFreshDb((raw) => {
        const admin = insertUser(raw, { role: 'admin' });
        expect(() => raw.prepare('DELETE FROM users WHERE id = ?').run(admin)).toThrow();
      });
    });

    it('with two admins, demoting one succeeds and demoting the second then throws', () => {
      withFreshDb((raw) => {
        const first = insertUser(raw, { role: 'admin' });
        const second = insertUser(raw, { role: 'admin' });

        expect(() =>
          raw.prepare("UPDATE users SET role = 'operator' WHERE id = ?").run(first),
        ).not.toThrow();
        expect(() =>
          raw.prepare("UPDATE users SET role = 'operator' WHERE id = ?").run(second),
        ).toThrow();
      });
    });

    it('deleting an operator while one admin exists succeeds', () => {
      withFreshDb((raw) => {
        insertUser(raw, { role: 'admin' });
        const operator = insertUser(raw, { role: 'operator' });
        expect(() => raw.prepare('DELETE FROM users WHERE id = ?').run(operator)).not.toThrow();
      });
    });

    it('a password update on the sole admin succeeds (the trigger does not fire on it)', () => {
      withFreshDb((raw) => {
        const admin = insertUser(raw, { role: 'admin' });
        expect(() =>
          raw.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('new-hash', admin),
        ).not.toThrow();
      });
    });

    // ── users.role admits 'monitor' (#63) ─────────────────────────────────
    //
    // `0011_users_monitor_role.sql` widens `users_role_valid` by a table
    // rebuild — the exact class of migration where `DROP TABLE users`
    // silently takes the two last-admin triggers with it unless they are
    // re-created in the same file. These assertions are the ones CLAUDE.md
    // calls for: both triggers survive, they still actually abort, and the
    // CHECK accepts the new value and still rejects junk. Nested in this
    // describe, not a sibling of it, because it reuses `withFreshDb`/
    // `insertUser`, which are scoped here.
    describe('users.role admits monitor (#63)', () => {
      it('both last-admin triggers still exist after the rebuild', () => {
        const triggers = sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
          .all() as Array<{ name: string }>;
        const names = triggers.map((t) => t.name);
        expect(names).toContain('users_last_admin_no_demote');
        expect(names).toContain('users_last_admin_no_delete');
      });

      it('the demote trigger still aborts demoting the sole admin, post-rebuild', () => {
        withFreshDb((raw) => {
          const admin = insertUser(raw, { role: 'admin' });
          expect(() =>
            raw.prepare("UPDATE users SET role = 'monitor' WHERE id = ?").run(admin),
          ).toThrow();
        });
      });

      it('the delete trigger still aborts deleting the sole admin, post-rebuild', () => {
        withFreshDb((raw) => {
          const admin = insertUser(raw, { role: 'admin' });
          raw.prepare("UPDATE users SET role = 'operator' WHERE id = ?");
          expect(() => raw.prepare('DELETE FROM users WHERE id = ?').run(admin)).toThrow();
        });
      });

      it("the CHECK constraint accepts 'monitor' and still rejects a junk role", () => {
        withFreshDb((raw) => {
          insertUser(raw, { role: 'admin' }); // keep the trigger happy; not the row under test
          const monitor = insertUser(raw, { role: 'operator' });
          expect(() =>
            raw.prepare("UPDATE users SET role = 'monitor' WHERE id = ?").run(monitor),
          ).not.toThrow();
          expect(
            (raw.prepare('SELECT role FROM users WHERE id = ?').get(monitor) as { role: string })
              .role,
          ).toBe('monitor');

          expect(() =>
            raw.prepare("UPDATE users SET role = 'superadmin' WHERE id = ?").run(monitor),
          ).toThrow();
        });
      });

      // Copies journal entries with idx <= maxIdx (and their .sql files) into a
      // fresh migrations folder, so `openDatabase` can apply the chain as it
      // stood *before* 0011 — the state a live database was actually in the
      // moment this migration ran. `readMigrationFiles` (drizzle-orm/migrator)
      // reads only the journal and the .sql files it names, never the
      // meta/*_snapshot.json files (those exist for `drizzle-kit generate`'s
      // own diffing, not for applying migrations), so a snapshot-free partial
      // folder is a faithful "database at this point in history", not a stub.
      function copyMigrationsUpTo(destDir: string, maxIdx: number): void {
        mkdirSync(join(destDir, 'meta'), { recursive: true });
        const journal = JSON.parse(
          readFileSync(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
        ) as { entries: Array<{ idx: number; tag: string }> };
        const trimmed = { ...journal, entries: journal.entries.filter((e) => e.idx <= maxIdx) };
        writeFileSync(join(destDir, 'meta/_journal.json'), JSON.stringify(trimmed));
        for (const entry of trimmed.entries) {
          copyFileSync(
            join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
            join(destDir, `${entry.tag}.sql`),
          );
        }
      }

      it('existing rows survive the rebuild with their roles intact', () => {
        const dir = mkdtempSync(join(tmpdir(), 'layout-orchestrator-rebuild-'));
        const dbPath = join(dir, `${randomUUID()}.db`);
        const partialMigrations = join(dir, 'migrations-before-0011');
        copyMigrationsUpTo(partialMigrations, 10); // everything up to 0010, i.e. before this migration existed

        try {
          // Apply only 0000–0010, then insert rows directly — the pre-rebuild
          // state a live database was actually in.
          openDatabase(dbPath, partialMigrations);
          const before = new Database(dbPath);
          const insert = before.prepare(
            'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
          );
          insert.run('rebuild-admin', 'rebuild-admin', 'x', 'admin', Date.now());
          insert.run('rebuild-operator', 'rebuild-operator', 'x', 'operator', Date.now());
          before.close();

          // Now apply the full chain against the SAME file. Drizzle's migrator
          // tracks applied migrations by content hash, so 0000–0010 are
          // skipped and only 0011 (the rebuild) actually runs.
          openDatabase(dbPath, MIGRATIONS_FOLDER);

          const after = new Database(dbPath);
          const rows = after.prepare('SELECT id, role FROM users ORDER BY id').all() as Array<{
            id: string;
            role: string;
          }>;
          after.close();

          expect(rows).toEqual([
            { id: 'rebuild-admin', role: 'admin' },
            { id: 'rebuild-operator', role: 'operator' },
          ]);
        } finally {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // ignore — OS temp directory, cleaned up eventually regardless
          }
        }
      });
    });
  });
});
