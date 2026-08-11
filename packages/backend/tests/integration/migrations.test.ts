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

  // ── block_ends (#72, see docs/topology.md) ──────────────────────────────────

  describe('block_ends', () => {
    it('exists with a pinned flag defaulting to false', () => {
      const columns = sqlite.prepare('PRAGMA table_info(block_ends)').all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>;

      expect(columns.map((c) => c.name).sort()).toEqual([
        'block_id',
        'id',
        'label',
        'layout_id',
        'pinned',
      ]);
      const pinned = columns.find((c) => c.name === 'pinned');
      // Generated is the default; pinning is a deliberate act, either by an
      // operator or by the adoption pass finding an edge that already
      // references the label.
      expect(pinned?.notnull).toBe(1);
      expect(pinned?.dflt_value).toBe('false');
    });

    it('has NO foreign key from block_edges ends to it, deliberately', () => {
      const fks = sqlite.prepare('PRAGMA foreign_key_list(block_edges)').all() as Array<{
        table: string;
      }>;
      // #72: an FK would make the adoption pass a chicken-and-egg problem, and
      // would change a corrupt row's failure mode from Safe-Stop to
      // write-refused — a regression against #10.
      expect(fks.map((f) => f.table)).not.toContain('block_ends');
    });

    it('refuses two ends of one block sharing a label', async () => {
      const layout = await repo.createLayout({ name: 'Ends Layout', description: null });
      const block = await repo.createBlock({ layoutId: layout.id, name: 'Yard 1' });

      await repo.createBlockEnd({
        layoutId: layout.id,
        blockId: block.id,
        label: 'north',
        pinned: true,
      });

      await expect(
        repo.createBlockEnd({
          layoutId: layout.id,
          blockId: block.id,
          label: 'north',
          pinned: false,
        }),
      ).rejects.toThrow();
    });

    it('replaceGeneratedBlockEnds swaps generated ends and leaves pinned ones untouched', async () => {
      const layout = await repo.createLayout({ name: 'Regen Layout', description: null });
      const block = await repo.createBlock({ layoutId: layout.id, name: 'Platform 2' });

      await repo.createBlockEnd({
        layoutId: layout.id,
        blockId: block.id,
        label: 'yard-3',
        pinned: true,
      });
      await repo.createBlockEnd({
        layoutId: layout.id,
        blockId: block.id,
        label: 'west',
        pinned: false,
      });

      // 'yard-3' is also offered by the generator: skipping it rather than
      // colliding with the unique index is the ordinary case, not an error.
      await repo.replaceGeneratedBlockEnds(layout.id, block.id, ['north', 'yard-3']);

      const ends = await repo.listBlockEnds(layout.id);
      expect(ends.map((e) => `${e.label}:${e.pinned}`).sort()).toEqual([
        'north:false',
        'yard-3:true',
      ]);
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

    function insertHold(routeId: string, overrides: {
      kind?: string;
      targetId?: string;
      released?: number;
    }): void {
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
      expect(() => insertHold(routeB, { kind: 'block', targetId: 'shared-block', released: 0 })).toThrow();
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
  });
});
