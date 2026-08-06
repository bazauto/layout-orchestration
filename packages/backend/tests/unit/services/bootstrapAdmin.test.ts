import { describe, it, expect, vi } from 'vitest';
import {
  bootstrapAdminIfNeeded,
  BootstrapRequiredError,
  DEFAULT_ADMIN_USERNAME,
} from '../../../src/services/bootstrapAdmin';
import { IAuthRepository, UserRecord } from '../../../src/ports/IAuthRepository';

const silentLogger = { info: vi.fn() };

function makeRepo(overrides: Partial<IAuthRepository> = {}): IAuthRepository {
  return {
    getUserByUsername: vi.fn().mockResolvedValue(null),
    getUserById: vi.fn().mockResolvedValue(null),
    createUser: vi.fn().mockImplementation(
      async (data): Promise<UserRecord> => ({ id: 'new-user', createdAt: new Date(), ...data }),
    ),
    updateUserPassword: vi.fn(),
    hasAnyUsers: vi.fn().mockResolvedValue(false),
    createSession: vi.fn(),
    getSessionByTokenHash: vi.fn(),
    updateSessionExpiry: vi.fn(),
    deleteSession: vi.fn(),
    deleteSessionsForUser: vi.fn(),
    ...overrides,
  };
}

describe('bootstrapAdminIfNeeded', () => {
  it('does nothing when the users table already has at least one row', async () => {
    const repo = makeRepo({ hasAnyUsers: vi.fn().mockResolvedValue(true) });

    await bootstrapAdminIfNeeded(repo, 'some-password', silentLogger);

    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it('throws BootstrapRequiredError when the table is empty and no password is provided', async () => {
    const repo = makeRepo({ hasAnyUsers: vi.fn().mockResolvedValue(false) });

    await expect(bootstrapAdminIfNeeded(repo, undefined, silentLogger)).rejects.toThrow(
      BootstrapRequiredError,
    );
    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it('creates a single admin account with the default username when the table is empty and a password is provided', async () => {
    const repo = makeRepo({ hasAnyUsers: vi.fn().mockResolvedValue(false) });

    await bootstrapAdminIfNeeded(repo, 'a-strong-password', silentLogger);

    expect(repo.createUser).toHaveBeenCalledTimes(1);
    const call = vi.mocked(repo.createUser).mock.calls[0][0];
    expect(call.username).toBe(DEFAULT_ADMIN_USERNAME);
    expect(call.role).toBe('admin');
    // The stored value must be an argon2id hash, never the plaintext password.
    expect(call.passwordHash).toMatch(/^\$argon2id\$/);
    expect(call.passwordHash).not.toBe('a-strong-password');
  });

  it('accepts a custom admin username', async () => {
    const repo = makeRepo({ hasAnyUsers: vi.fn().mockResolvedValue(false) });

    await bootstrapAdminIfNeeded(repo, 'a-strong-password', silentLogger, 'custom-admin');

    expect(vi.mocked(repo.createUser).mock.calls[0][0].username).toBe('custom-admin');
  });
});
