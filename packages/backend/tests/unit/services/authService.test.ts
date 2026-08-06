import { describe, it, expect, vi } from 'vitest';
import { AuthService, InvalidCredentialsError } from '../../../src/services/AuthService';
import { hashPassword, hashSessionToken } from '../../../src/domain/auth';
import { IAuthRepository, SessionRecord, UserRecord } from '../../../src/ports/IAuthRepository';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function user(overrides: Partial<UserRecord> = {}): UserRecord {
  return {
    id: 'u1',
    username: 'operator1',
    passwordHash: null,
    role: 'operator',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** In-memory fake — realistic enough to exercise AuthService without a real DB. */
function makeRepo(initialUsers: UserRecord[] = []): IAuthRepository {
  const users = new Map(initialUsers.map((u) => [u.id, u]));
  const usersByName = new Map(initialUsers.map((u) => [u.username, u]));
  const sessions = new Map<string, SessionRecord>();

  return {
    getUserByUsername: vi.fn(async (username: string) => usersByName.get(username) ?? null),
    getUserById: vi.fn(async (id: string) => users.get(id) ?? null),
    createUser: vi.fn(async (data) => {
      const created: UserRecord = { id: `u-${users.size + 1}`, createdAt: new Date(), ...data };
      users.set(created.id, created);
      usersByName.set(created.username, created);
      return created;
    }),
    updateUserPassword: vi.fn(async (id: string, passwordHash: string) => {
      const existing = users.get(id);
      if (!existing) throw new Error(`User ${id} not found`);
      const updated = { ...existing, passwordHash };
      users.set(id, updated);
      usersByName.set(updated.username, updated);
      return updated;
    }),
    hasAnyUsers: vi.fn(async () => users.size > 0),
    createSession: vi.fn(async (data) => {
      const created: SessionRecord = { id: `s-${sessions.size + 1}`, createdAt: new Date(), ...data };
      sessions.set(created.id, created);
      return created;
    }),
    getSessionByTokenHash: vi.fn(async (tokenHash: string) => {
      for (const s of sessions.values()) {
        if (s.tokenHash === tokenHash) return s;
      }
      return null;
    }),
    updateSessionExpiry: vi.fn(async (id: string, expiresAt: Date) => {
      const existing = sessions.get(id);
      if (!existing) throw new Error(`Session ${id} not found`);
      const updated = { ...existing, expiresAt };
      sessions.set(id, updated);
      return updated;
    }),
    deleteSession: vi.fn(async (id: string) => {
      sessions.delete(id);
    }),
    deleteSessionsForUser: vi.fn(async (userId: string) => {
      for (const [id, s] of sessions) {
        if (s.userId === userId) sessions.delete(id);
      }
    }),
  };
}

describe('AuthService — login', () => {
  it('the correct password logs in and returns a session carrying the role', async () => {
    const passwordHash = await hashPassword('correct-password');
    const repo = makeRepo([user({ id: 'u1', username: 'alice', passwordHash, role: 'admin' })]);
    const service = new AuthService(repo, silentLogger);

    const result = await service.login('alice', 'correct-password');

    expect(result.userId).toBe('u1');
    expect(result.username).toBe('alice');
    expect(result.role).toBe('admin');
    expect(result.token.length).toBeGreaterThan(0);
    expect(repo.createSession).toHaveBeenCalledTimes(1);
  });

  it('the wrong password fails', async () => {
    const passwordHash = await hashPassword('correct-password');
    const repo = makeRepo([user({ id: 'u1', username: 'alice', passwordHash })]);
    const service = new AuthService(repo, silentLogger);

    await expect(service.login('alice', 'wrong-password')).rejects.toThrow(
      InvalidCredentialsError,
    );
    expect(repo.createSession).not.toHaveBeenCalled();
  });

  it('an unknown username fails with the same error as a wrong password', async () => {
    const repo = makeRepo([]);
    const service = new AuthService(repo, silentLogger);

    await expect(service.login('nobody', 'anything')).rejects.toThrow(InvalidCredentialsError);
  });

  it('a user with no password credential (e.g. WebAuthn-only) fails login rather than throwing internally', async () => {
    const repo = makeRepo([user({ id: 'u1', username: 'alice', passwordHash: null })]);
    const service = new AuthService(repo, silentLogger);

    await expect(service.login('alice', 'anything')).rejects.toThrow(InvalidCredentialsError);
  });
});

describe('AuthService — validateSession', () => {
  it('validates a live session and returns the carried role', async () => {
    const repo = makeRepo([user({ id: 'u1', username: 'alice', role: 'admin' })]);
    const token = 'a-real-token';
    await repo.createSession({
      userId: 'u1',
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });
    const service = new AuthService(repo, silentLogger);

    const validated = await service.validateSession(token);

    expect(validated).not.toBeNull();
    expect(validated?.userId).toBe('u1');
    expect(validated?.role).toBe('admin');
  });

  it('returns null for an unknown token', async () => {
    const repo = makeRepo([]);
    const service = new AuthService(repo, silentLogger);

    await expect(service.validateSession('no-such-token')).resolves.toBeNull();
  });

  it('rejects and deletes an expired session', async () => {
    const repo = makeRepo([user({ id: 'u1' })]);
    const token = 'expired-token';
    const created = await repo.createSession({
      userId: 'u1',
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() - 1000),
    });

    const service = new AuthService(repo, silentLogger);
    const validated = await service.validateSession(token);

    expect(validated).toBeNull();
    expect(repo.deleteSession).toHaveBeenCalledWith(created.id);
  });

  it('fails closed for a session whose user no longer exists', async () => {
    const repo = makeRepo([]);
    const token = 'orphaned-token';
    const created = await repo.createSession({
      userId: 'deleted-user',
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    const service = new AuthService(repo, silentLogger);
    const validated = await service.validateSession(token);

    expect(validated).toBeNull();
    expect(repo.deleteSession).toHaveBeenCalledWith(created.id);
  });

  it('sliding refresh extends expiresAt on every validated use', async () => {
    const repo = makeRepo([user({ id: 'u1' })]);
    const token = 'sliding-token';
    const created = await repo.createSession({
      userId: 'u1',
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 1000), // about to expire
    });

    const service = new AuthService(repo, silentLogger);
    const validated = await service.validateSession(token);

    expect(validated).not.toBeNull();
    expect(validated!.expiresAt.getTime()).toBeGreaterThan(created.expiresAt.getTime());
    expect(repo.updateSessionExpiry).toHaveBeenCalledWith(created.id, expect.any(Date));
  });
});

describe('AuthService — logout', () => {
  it('deletes the session for a valid token', async () => {
    const repo = makeRepo([user({ id: 'u1' })]);
    const token = 'logout-me';
    const created = await repo.createSession({
      userId: 'u1',
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    const service = new AuthService(repo, silentLogger);
    await service.logout(token);

    expect(repo.deleteSession).toHaveBeenCalledWith(created.id);
    await expect(service.validateSession(token)).resolves.toBeNull();
  });

  it('is idempotent for an already-invalid token', async () => {
    const repo = makeRepo([]);
    const service = new AuthService(repo, silentLogger);

    await expect(service.logout('never-existed')).resolves.toBeUndefined();
    expect(repo.deleteSession).not.toHaveBeenCalled();
  });
});
