/**
 * DrizzleRepository — Route Reservations Integration Test
 *
 * Mirrors repository-edges.test.ts: exercises the route_reservations /
 * route_holds CRUD methods against a real temp-file SQLite database, so
 * `parseReservationRow` actually runs on rows written by SQLite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DrizzleRepository } from '../../src/adapters/db/repository';
import { openDatabase } from '../../src/adapters/db/connection';
import { RouteRowInvalidError } from '../../src/services/validation';
import { RouteReservation } from '../../src/domain/types';

const MIGRATIONS_FOLDER = join(__dirname, '../../migrations');

describe('DrizzleRepository — route reservations', () => {
  let tempDir: string;
  let dbPath: string;
  let repo: DrizzleRepository;
  let layoutId: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'layout-orchestrator-repo-reservations-'));
    dbPath = join(tempDir, `${randomUUID()}.db`);
    repo = new DrizzleRepository(openDatabase(dbPath, MIGRATIONS_FOLDER));

    const layout = await repo.createLayout({ name: 'Test Layout', description: null });
    layoutId = layout.id;
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore — best-effort cleanup, same rationale as repository-edges.test.ts
    }
  });

  /**
   * Builds reservation fixture data. Block/point ids default to a fresh
   * random suffix per call — reservations across different `it()` blocks
   * must not silently collide on `route_holds_exclusive_unq`, since that
   * constraint is exactly what one of these tests exercises deliberately.
   */
  function reservation(overrides: Partial<Omit<RouteReservation, 'createdAt' | 'updatedAt'>> = {}) {
    const suffix = randomUUID().slice(0, 8);
    return {
      id: randomUUID(),
      layoutId,
      locoAddress: 3,
      authority: 'manual' as const,
      status: 'active' as const,
      path: [
        { edgeId: null, blockId: `b1-${suffix}`, entryEnd: null, exitEnd: 'east' },
        { edgeId: `e1-${suffix}`, blockId: `b2-${suffix}`, entryEnd: 'west', exitEnd: null },
      ],
      holds: [
        {
          kind: 'block' as const,
          targetId: `b1-${suffix}`,
          requiredPosition: null,
          releaseAfterIndex: 0,
          released: false,
        },
        {
          kind: 'block' as const,
          targetId: `b2-${suffix}`,
          requiredPosition: null,
          releaseAfterIndex: 1,
          released: false,
        },
        {
          kind: 'point' as const,
          targetId: `p1-${suffix}`,
          requiredPosition: 'normal' as const,
          releaseAfterIndex: 0,
          released: false,
        },
      ],
      confirmedIndex: 0,
      reason: null,
      ...overrides,
    };
  }

  it('round-trips create → get → list → update → markHoldsReleased', async () => {
    const data = reservation();
    const created = await repo.createReservation(data);

    expect(created.id).toBe(data.id);
    expect(created.holds).toHaveLength(3);
    expect(created.createdAt).toBeInstanceOf(Date);

    const fetched = await repo.getReservation(data.id);
    expect(fetched).toEqual(created);

    const listed = await repo.listReservations(layoutId);
    expect(listed.map((r) => r.id)).toContain(data.id);

    const updated = await repo.updateReservation(data.id, { confirmedIndex: 1 });
    expect(updated.confirmedIndex).toBe(1);
    // untouched fields survive a partial update
    expect(updated.status).toBe('active');

    const [firstBlockTargetId, secondBlockTargetId] = data.holds
      .filter((h) => h.kind === 'block')
      .map((h) => h.targetId);

    await repo.markHoldsReleased(data.id, [{ kind: 'block', targetId: firstBlockTargetId }]);
    const afterRelease = await repo.getReservation(data.id);
    const b1Hold = afterRelease!.holds.find((h) => h.kind === 'block' && h.targetId === firstBlockTargetId);
    const b2Hold = afterRelease!.holds.find((h) => h.kind === 'block' && h.targetId === secondBlockTargetId);
    expect(b1Hold?.released).toBe(true);
    expect(b2Hold?.released).toBe(false);
  });

  it('listReservations filters by status when given', async () => {
    const active = reservation({ locoAddress: 10, status: 'active' });
    const cancelled = reservation({ locoAddress: 11, status: 'cancelled' });
    await repo.createReservation(active);
    await repo.createReservation(cancelled);

    const onlyActive = await repo.listReservations(layoutId, ['active']);
    expect(onlyActive.map((r) => r.id)).toContain(active.id);
    expect(onlyActive.map((r) => r.id)).not.toContain(cancelled.id);
  });

  it('getReservation returns null for an id that does not exist', async () => {
    await expect(repo.getReservation('does-not-exist')).resolves.toBeNull();
  });

  it('getReservation throws RouteRowInvalidError for a hand-inserted hold row with an empty target_id', async () => {
    // An empty target_id satisfies the DB's NOT NULL constraint (there is no
    // DB-level length CHECK on target_id, unlike block_edges' from_end/to_end)
    // but fails routeHoldRowSchema's `z.string().min(1)` — this is the
    // app-level Zod check catching something the DB itself would let through.
    const sqlite = new Database(dbPath);
    const routeId = randomUUID();
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO route_reservations (id, layout_id, loco_address, authority, status, path, confirmed_index, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(routeId, layoutId, 42, 'manual', 'active', '[]', 0, null, now, now);
    const holdId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO route_holds (id, route_id, layout_id, kind, target_id, required_position, release_after_index, released)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(holdId, routeId, layoutId, 'block', '', null, 0, 0);

    await expect(repo.getReservation(routeId)).rejects.toThrow(RouteRowInvalidError);

    sqlite.prepare('DELETE FROM route_holds WHERE id = ?').run(holdId);
    sqlite.prepare('DELETE FROM route_reservations WHERE id = ?').run(routeId);
    sqlite.close();
  });

  it('createReservation rolls back the reservation row when a hold insert violates the exclusivity index — zero rows persisted, not a partial write', async () => {
    // Pre-hold a block via a first, valid reservation.
    const first = reservation({ locoAddress: 20 });
    await repo.createReservation(first);

    // A second reservation whose holds re-target the SAME block as `first`
    // while still `released: false` — the DB's route_holds_exclusive_unq
    // must refuse this, and the whole transaction (including the
    // reservation row itself) must roll back.
    const conflicting = reservation({ locoAddress: 21, holds: first.holds });

    await expect(repo.createReservation(conflicting)).rejects.toThrow();

    const afterFailedCreate = await repo.getReservation(conflicting.id);
    expect(afterFailedCreate).toBeNull();

    const holdsForConflicting = (await repo.listReservations(layoutId)).filter(
      (r) => r.id === conflicting.id,
    );
    expect(holdsForConflicting).toHaveLength(0);
  });
});
