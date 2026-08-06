/**
 * DrizzleAuthRepository Integration Test
 *
 * Exercises the users/sessions CRUD methods against a real temp-file SQLite
 * database (migrations applied via the DrizzleAuthRepository constructor, as
 * in migrations.test.ts and repository-edges.test.ts), rather than a stubbed
 * repo — so `parseUserRow`/`parseSessionRow` actually run on rows written by
 * SQLite, not hand-constructed fixtures.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DrizzleAuthRepository } from '../../src/adapters/db/authRepository';
import { openDatabase } from '../../src/adapters/db/connection';

const MIGRATIONS_FOLDER = join(__dirname, '../../migrations');

describe('DrizzleAuthRepository', () => {
  let tempDir: string;
  let dbPath: string;
  let repo: DrizzleAuthRepository;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'layout-orchestrator-repo-auth-'));
    dbPath = join(tempDir, `${randomUUID()}.db`);
    repo = new DrizzleAuthRepository(openDatabase(dbPath, MIGRATIONS_FOLDER));
  });

  afterAll(() => {
    // DrizzleAuthRepository does not expose a close() method — best-effort
    // cleanup only, same rationale as repository-edges.test.ts.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('round-trips a user create → getById → getByUsername', async () => {
    const created = await repo.createUser({
      username: 'alice',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$salt$digest',
      role: 'admin',
    });

    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeInstanceOf(Date);

    const byId = await repo.getUserById(created.id);
    expect(byId).toEqual(created);

    const byUsername = await repo.getUserByUsername('alice');
    expect(byUsername).toEqual(created);
  });

  it('returns null for an unknown user', async () => {
    await expect(repo.getUserById('no-such-id')).resolves.toBeNull();
    await expect(repo.getUserByUsername('no-such-username')).resolves.toBeNull();
  });

  it('a duplicate username is rejected by the DB-level unique index', async () => {
    await repo.createUser({ username: 'bob', passwordHash: 'x', role: 'operator' });
    await expect(
      repo.createUser({ username: 'bob', passwordHash: 'y', role: 'operator' }),
    ).rejects.toThrow();
  });

  it('an invalid role is rejected by the DB-level check constraint', async () => {
    await expect(
      repo.createUser({
        username: 'carol',
        passwordHash: 'x',
        // @ts-expect-error — deliberately invalid to exercise the DB check constraint
        role: 'superadmin',
      }),
    ).rejects.toThrow();
  });

  it('a NULL passwordHash round-trips (reserved for a future WebAuthn-only account)', async () => {
    const created = await repo.createUser({ username: 'dave', passwordHash: null, role: 'operator' });
    expect(created.passwordHash).toBeNull();
    const fetched = await repo.getUserById(created.id);
    expect(fetched?.passwordHash).toBeNull();
  });

  it('round-trips create → getByTokenHash → updateSessionExpiry → delete', async () => {
    const user = await repo.createUser({ username: 'erin', passwordHash: 'x', role: 'operator' });
    // Rounded to the second: `expiresAt`/`createdAt` use Drizzle's 'timestamp'
    // mode, which stores unix seconds (same as every other timestamp column
    // in this schema — see `layouts.createdAt`), so sub-second precision on
    // the input does not round-trip.
    const expiresAt = new Date(Math.floor((Date.now() + 1000 * 60 * 60 * 24 * 30) / 1000) * 1000);

    const created = await repo.createSession({
      userId: user.id,
      tokenHash: 'a'.repeat(64),
      expiresAt,
    });

    expect(created.id).toBeTruthy();
    expect(created.expiresAt.getTime()).toBe(expiresAt.getTime());

    const fetched = await repo.getSessionByTokenHash('a'.repeat(64));
    expect(fetched).toEqual(created);

    const newExpiry = new Date(expiresAt.getTime() + 1000); // whole seconds already, safe to add exactly 1000ms
    const refreshed = await repo.updateSessionExpiry(created.id, newExpiry);
    expect(refreshed.expiresAt.getTime()).toBe(newExpiry.getTime());
    // Untouched fields survive the update.
    expect(refreshed.userId).toBe(user.id);

    await repo.deleteSession(created.id);
    await expect(repo.getSessionByTokenHash('a'.repeat(64))).resolves.toBeNull();
  });

  it('deleting a user cascades to their sessions', async () => {
    const user = await repo.createUser({ username: 'frank', passwordHash: 'x', role: 'operator' });
    await repo.createSession({ userId: user.id, tokenHash: 'b'.repeat(64), expiresAt: new Date(Date.now() + 1000) });

    // No direct deleteUser on the port yet (out of scope for this tranche) —
    // exercise the FK cascade directly to prove the schema-level guarantee
    // that AuthService's "orphaned session" fail-closed path depends on.
    const sqlite = new Database(dbPath);
    sqlite.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    sqlite.close();

    await expect(repo.getSessionByTokenHash('b'.repeat(64))).resolves.toBeNull();
  });

  it('deleteSessionsForUser removes every session for that user only', async () => {
    const user = await repo.createUser({ username: 'grace', passwordHash: 'x', role: 'operator' });
    const other = await repo.createUser({ username: 'heidi', passwordHash: 'x', role: 'operator' });

    await repo.createSession({ userId: user.id, tokenHash: 'c'.repeat(64), expiresAt: new Date(Date.now() + 1000) });
    await repo.createSession({ userId: user.id, tokenHash: 'd'.repeat(64), expiresAt: new Date(Date.now() + 1000) });
    await repo.createSession({ userId: other.id, tokenHash: 'e'.repeat(64), expiresAt: new Date(Date.now() + 1000) });

    await repo.deleteSessionsForUser(user.id);

    await expect(repo.getSessionByTokenHash('c'.repeat(64))).resolves.toBeNull();
    await expect(repo.getSessionByTokenHash('d'.repeat(64))).resolves.toBeNull();
    await expect(repo.getSessionByTokenHash('e'.repeat(64))).resolves.not.toBeNull();
  });

  it('listing rows via a hand-inserted row with an invalid role throws rather than coercing', async () => {
    const sqlite = new Database(dbPath);
    const badId = randomUUID();
    // Bypasses the DB check constraint intentionally is not possible (SQLite
    // enforces it), so this proves the constraint itself rejects bad data
    // before parseUserRow would ever need to.
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(badId, 'bad-role-user', 'x', 'superadmin', Date.now()),
    ).toThrow();
    sqlite.close();
  });
});
