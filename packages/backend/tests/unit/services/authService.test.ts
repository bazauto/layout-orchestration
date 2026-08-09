import { describe, it, expect, vi } from 'vitest';
import {
  AuthService,
  InvalidCredentialsError,
  InvalidCurrentPasswordError,
  PasswordPolicyError,
  SelfMutationError,
  UserNotFoundError,
  ValidatedSession,
} from '../../../src/services/AuthService';
import { hashPassword, hashSessionToken } from '../../../src/domain/auth';
import {
  IAuthRepository,
  LastAdminError,
  SessionRecord,
  UsernameTakenError,
  UserRecord,
} from '../../../src/ports/IAuthRepository';

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
    listUsers: vi.fn(async () => [...users.values()].sort((a, b) => a.username.localeCompare(b.username))),
    updateUserRole: vi.fn(async (id: string, role: UserRecord['role']) => {
      const existing = users.get(id);
      if (!existing) throw new Error(`User ${id} not found`);
      const updated = { ...existing, role };
      users.set(id, updated);
      usersByName.set(updated.username, updated);
      return updated;
    }),
    deleteUser: vi.fn(async (id: string) => {
      const existing = users.get(id);
      users.delete(id);
      if (existing) usersByName.delete(existing.username);
    }),
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

function actorFor(user: UserRecord): ValidatedSession {
  return {
    sessionId: `session-for-${user.id}`,
    userId: user.id,
    username: user.username,
    role: user.role,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
  };
}

describe('AuthService — user management (issue #53)', () => {
  it('createUser hashes the password and never stores/returns it', async () => {
    const admin = user({ id: 'admin-1', username: 'admin', role: 'admin' });
    const repo = makeRepo([admin]);
    const service = new AuthService(repo, silentLogger);

    const created = await service.createUser(
      { username: 'newop', password: 'a-good-password', role: 'operator' },
      actorFor(admin),
    );

    expect(created.username).toBe('newop');
    expect(created.role).toBe('operator');
    expect(created.hasPassword).toBe(true);
    expect((created as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it('creating a duplicate username throws UsernameTakenError, and the repo createUser was never called', async () => {
    const admin = user({ id: 'admin-1', username: 'admin', role: 'admin' });
    const existing = user({ id: 'u2', username: 'taken', role: 'operator' });
    const repo = makeRepo([admin, existing]);
    const service = new AuthService(repo, silentLogger);

    await expect(
      service.createUser({ username: 'taken', password: 'a-good-password', role: 'operator' }, actorFor(admin)),
    ).rejects.toThrow(UsernameTakenError);
    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it('creating with a 7-character password throws PasswordPolicyError', async () => {
    const admin = user({ id: 'admin-1', username: 'admin', role: 'admin' });
    const repo = makeRepo([admin]);
    const service = new AuthService(repo, silentLogger);

    await expect(
      service.createUser({ username: 'shortpw', password: '1234567', role: 'operator' }, actorFor(admin)),
    ).rejects.toThrow(PasswordPolicyError);
  });

  it('demoting the sole admin throws LastAdminError, and updateUserRole was never called', async () => {
    const admin = user({ id: 'admin-1', username: 'admin', role: 'admin' });
    const other = user({ id: 'other', username: 'other', role: 'operator' });
    const repo = makeRepo([admin, other]);
    const service = new AuthService(repo, silentLogger);

    await expect(service.changeUserRole('admin-1', 'operator', actorFor(other))).rejects.toThrow(
      LastAdminError,
    );
    expect(repo.updateUserRole).not.toHaveBeenCalled();
  });

  it('deleting the sole admin throws LastAdminError, and deleteUser was never called', async () => {
    const admin = user({ id: 'admin-1', username: 'admin', role: 'admin' });
    const other = user({ id: 'other', username: 'other', role: 'operator' });
    const repo = makeRepo([admin, other]);
    const service = new AuthService(repo, silentLogger);

    await expect(service.deleteUser('admin-1', actorFor(other))).rejects.toThrow(LastAdminError);
    expect(repo.deleteUser).not.toHaveBeenCalled();
  });

  it('demoting oneself throws SelfMutationError even with two admins present', async () => {
    const admin1 = user({ id: 'admin-1', username: 'admin1', role: 'admin' });
    const admin2 = user({ id: 'admin-2', username: 'admin2', role: 'admin' });
    const repo = makeRepo([admin1, admin2]);
    const service = new AuthService(repo, silentLogger);

    await expect(service.changeUserRole('admin-1', 'operator', actorFor(admin1))).rejects.toThrow(
      SelfMutationError,
    );
  });

  it('deleting oneself throws SelfMutationError even with two admins present', async () => {
    const admin1 = user({ id: 'admin-1', username: 'admin1', role: 'admin' });
    const admin2 = user({ id: 'admin-2', username: 'admin2', role: 'admin' });
    const repo = makeRepo([admin1, admin2]);
    const service = new AuthService(repo, silentLogger);

    await expect(service.deleteUser('admin-1', actorFor(admin1))).rejects.toThrow(SelfMutationError);
  });

  it('changeUserRole on an unknown user throws UserNotFoundError', async () => {
    const admin = user({ id: 'admin-1', username: 'admin', role: 'admin' });
    const repo = makeRepo([admin]);
    const service = new AuthService(repo, silentLogger);

    await expect(service.changeUserRole('nobody', 'operator', actorFor(admin))).rejects.toThrow(
      UserNotFoundError,
    );
  });

  it('a successful role change revokes the target session — a subsequent validateSession returns null', async () => {
    const admin = user({ id: 'admin-1', username: 'admin', role: 'admin' });
    const admin2 = user({ id: 'admin-2', username: 'admin2', role: 'admin' });
    const repo = makeRepo([admin, admin2]);
    const service = new AuthService(repo, silentLogger);

    const token = 'admin2-token';
    await repo.createSession({
      userId: 'admin-2',
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    await service.changeUserRole('admin-2', 'operator', actorFor(admin));

    expect(repo.deleteSessionsForUser).toHaveBeenCalledWith('admin-2');
    await expect(service.validateSession(token)).resolves.toBeNull();
  });

  it('a successful delete revokes the target session', async () => {
    const admin = user({ id: 'admin-1', username: 'admin', role: 'admin' });
    const operator = user({ id: 'op-1', username: 'op1', role: 'operator' });
    const repo = makeRepo([admin, operator]);
    const service = new AuthService(repo, silentLogger);

    const token = 'op-token';
    await repo.createSession({
      userId: 'op-1',
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    await service.deleteUser('op-1', actorFor(admin));

    expect(repo.deleteSessionsForUser).toHaveBeenCalledWith('op-1');
    await expect(service.validateSession(token)).resolves.toBeNull();
  });

  it('a successful admin reset revokes the target session', async () => {
    const admin = user({ id: 'admin-1', username: 'admin', role: 'admin' });
    const operator = user({ id: 'op-1', username: 'op1', role: 'operator', passwordHash: await hashPassword('old-password') });
    const repo = makeRepo([admin, operator]);
    const service = new AuthService(repo, silentLogger);

    const token = 'op-token';
    await repo.createSession({
      userId: 'op-1',
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    await service.resetUserPassword('op-1', 'a-new-password', actorFor(admin));

    expect(repo.deleteSessionsForUser).toHaveBeenCalledWith('op-1');
    await expect(service.validateSession(token)).resolves.toBeNull();
  });

  it('changeOwnPassword with the wrong current password throws InvalidCurrentPasswordError, stored hash unchanged', async () => {
    const passwordHash = await hashPassword('correct-password');
    const operator = user({ id: 'op-1', username: 'op1', role: 'operator', passwordHash });
    const repo = makeRepo([operator]);
    const service = new AuthService(repo, silentLogger);

    await expect(
      service.changeOwnPassword('op-1', 'wrong-password', 'a-new-password'),
    ).rejects.toThrow(InvalidCurrentPasswordError);
    expect(repo.updateUserPassword).not.toHaveBeenCalled();
  });

  it('changeOwnPassword on a passwordHash: null user throws InvalidCurrentPasswordError', async () => {
    const operator = user({ id: 'op-1', username: 'op1', role: 'operator', passwordHash: null });
    const repo = makeRepo([operator]);
    const service = new AuthService(repo, silentLogger);

    await expect(
      service.changeOwnPassword('op-1', 'anything', 'a-new-password'),
    ).rejects.toThrow(InvalidCurrentPasswordError);
  });

  it('a successful changeOwnPassword revokes the caller own session', async () => {
    const passwordHash = await hashPassword('correct-password');
    const operator = user({ id: 'op-1', username: 'op1', role: 'operator', passwordHash });
    const repo = makeRepo([operator]);
    const service = new AuthService(repo, silentLogger);

    const token = 'own-token';
    await repo.createSession({
      userId: 'op-1',
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    await service.changeOwnPassword('op-1', 'correct-password', 'a-new-password');

    expect(repo.deleteSessionsForUser).toHaveBeenCalledWith('op-1');
    await expect(service.validateSession(token)).resolves.toBeNull();
  });

  it('listUsers output contains no passwordHash key', async () => {
    const admin = user({ id: 'admin-1', username: 'admin', role: 'admin', passwordHash: 'x' });
    const repo = makeRepo([admin]);
    const service = new AuthService(repo, silentLogger);

    const list = await service.listUsers();

    for (const u of list) {
      expect((u as Record<string, unknown>).passwordHash).toBeUndefined();
    }
  });
});
