/**
 * AuthService
 *
 * Login, logout, session validation, and sliding refresh for local
 * username/password authentication. Wraps `domain/auth.ts` (hashing, token
 * generation, expiry math) with persistence via `IAuthRepository`.
 *
 * No Fastify, cookie, or HTTP knowledge lives here — a later tranche's login
 * route is responsible for setting/clearing the session cookie; this service
 * only manages the `sessions` table and hands back an opaque token.
 */

import {
  computeSessionExpiry,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  isSessionExpired,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  normaliseUsername,
  verifyPassword,
} from '../domain/auth';
import { Role, SessionId, UserId, UserView } from '../domain/types';
import { wouldRemoveLastAdmin } from '../domain/users';
import { IAuthRepository, LastAdminError, UsernameTakenError } from '../ports/IAuthRepository';

export interface AuthServiceLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Returned by `login` — the raw token is only ever available at this moment; only its hash is persisted. */
export interface AuthenticatedSession {
  token: string;
  sessionId: SessionId;
  userId: UserId;
  username: string;
  role: Role;
  expiresAt: Date;
}

/** Returned by `validateSession` on success. */
export interface ValidatedSession {
  sessionId: SessionId;
  userId: UserId;
  username: string;
  role: Role;
  expiresAt: Date;
}

/**
 * Thrown by `login` when the username does not exist, has no password
 * credential, or the password is wrong. Deliberately the same error for all
 * three cases — distinguishing them in the response would let a caller
 * enumerate valid usernames.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid username or password');
    this.name = 'InvalidCredentialsError';
  }
}

/** Thrown when a `userId` does not resolve to any account. */
export class UserNotFoundError extends Error {
  constructor(userId: UserId) {
    super(`User ${userId} not found`);
    this.name = 'UserNotFoundError';
  }
}

/**
 * Thrown when an admin attempts to change their own role or delete their own
 * account (see docs/auth.md — handover is "create the second admin, then
 * they demote you"). Self password-change and self password-reset are both
 * still allowed.
 */
export class SelfMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfMutationError';
  }
}

/** Thrown by `changeOwnPassword` when the supplied current password does not verify. */
export class InvalidCurrentPasswordError extends Error {
  constructor() {
    super('Current password is incorrect');
    this.name = 'InvalidCurrentPasswordError';
  }
}

/** Thrown when a new password fails `MIN_PASSWORD_LENGTH`/`MAX_PASSWORD_LENGTH`. */
export class PasswordPolicyError extends Error {
  constructor() {
    super(`Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`);
    this.name = 'PasswordPolicyError';
  }
}

function assertPasswordPolicy(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError();
  }
}

function toUserView(user: { id: UserId; username: string; role: Role; createdAt: Date; passwordHash: string | null }): UserView {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    hasPassword: user.passwordHash !== null,
  };
}

export class AuthService {
  constructor(
    private readonly repo: IAuthRepository,
    private readonly log: AuthServiceLogger,
  ) {}

  /**
   * Verifies credentials and creates a new session. Throws
   * `InvalidCredentialsError` on any failure — see the class doc comment for
   * why the failure reasons are not distinguished.
   */
  async login(username: string, password: string): Promise<AuthenticatedSession> {
    const user = await this.repo.getUserByUsername(username);
    if (!user || !user.passwordHash) {
      // Unknown user, or a WebAuthn-only account with no password
      // credential — same rejection either way.
      this.log.warn('[AuthService] Login rejected', { username });
      throw new InvalidCredentialsError();
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      this.log.warn('[AuthService] Login rejected', { username, userId: user.id });
      throw new InvalidCredentialsError();
    }

    const token = generateSessionToken();
    const session = await this.repo.createSession({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: computeSessionExpiry(),
    });

    this.log.info('[AuthService] Login succeeded', { username, userId: user.id, role: user.role });

    return {
      token,
      sessionId: session.id,
      userId: user.id,
      username: user.username,
      role: user.role,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Deletes the session for `token`, if any. Idempotent — logging out an
   * already-invalid or already-logged-out token is not an error.
   */
  async logout(token: string): Promise<void> {
    const session = await this.repo.getSessionByTokenHash(hashSessionToken(token));
    if (!session) {
      return;
    }
    await this.repo.deleteSession(session.id);
    this.log.info('[AuthService] Logged out', { userId: session.userId, sessionId: session.id });
  }

  /**
   * Validates a session token and, on success, applies sliding refresh —
   * extends `expiresAt` by another full `SESSION_TTL_MS` from now.
   *
   * Returns `null` on any failure (unknown token, expired session, or a user
   * that no longer exists) rather than throwing: an invalid session is an
   * ordinary, expected outcome for a caller (e.g. the auth hook added in a
   * later tranche), not an exceptional one. Every failure path fails closed
   * — an expired or orphaned session is deleted, never silently revived.
   */
  async validateSession(token: string): Promise<ValidatedSession | null> {
    const session = await this.repo.getSessionByTokenHash(hashSessionToken(token));
    if (!session) {
      return null;
    }

    if (isSessionExpired(session.expiresAt)) {
      await this.repo.deleteSession(session.id);
      this.log.info('[AuthService] Session expired', {
        sessionId: session.id,
        userId: session.userId,
      });
      return null;
    }

    const user = await this.repo.getUserById(session.userId);
    if (!user) {
      // Orphaned session (user deleted). Fail closed rather than trusting a
      // cached role/username that no longer has a backing account.
      await this.repo.deleteSession(session.id);
      this.log.warn('[AuthService] Session refers to a deleted user', {
        sessionId: session.id,
        userId: session.userId,
      });
      return null;
    }

    const refreshed = await this.repo.updateSessionExpiry(session.id, computeSessionExpiry());

    return {
      sessionId: refreshed.id,
      userId: user.id,
      username: user.username,
      role: user.role,
      expiresAt: refreshed.expiresAt,
    };
  }

  // ─── User management (issue #53) ───────────────────────────────────────

  /** Every account, admin-only at the transport layer. `passwordHash` never leaves this service. */
  async listUsers(): Promise<UserView[]> {
    const users = await this.repo.listUsers();
    return users.map(toUserView);
  }

  /**
   * Creates a new account. `LastAdminError`/`SelfMutationError` do not apply
   * here — there is no last-admin or self-mutation concern on a create.
   */
  async createUser(
    input: { username: string; password: string; role: Role },
    actor: ValidatedSession,
  ): Promise<UserView> {
    const username = normaliseUsername(input.username);
    assertPasswordPolicy(input.password);

    const existing = await this.repo.getUserByUsername(username);
    if (existing) {
      throw new UsernameTakenError(username);
    }

    const passwordHash = await hashPassword(input.password);
    const created = await this.repo.createUser({ username, passwordHash, role: input.role });

    this.log.info('[AuthService] User created', {
      actorId: actor.userId,
      username: created.username,
      role: created.role,
    });

    return toUserView(created);
  }

  /**
   * Changes a user's role. Refuses self-mutation (409) and a demotion that
   * would leave zero admins (409) — the service-level half of Q1's guard;
   * the DB trigger pair is the other half. Revokes the target's sessions
   * only AFTER the write succeeds, so an aborting trigger leaves them intact
   * (see the ordering note on `deleteUser` below).
   */
  async changeUserRole(userId: UserId, role: Role, actor: ValidatedSession): Promise<UserView> {
    if (userId === actor.userId) {
      throw new SelfMutationError('Cannot change your own role');
    }

    const target = await this.repo.getUserById(userId);
    if (!target) {
      throw new UserNotFoundError(userId);
    }

    const allUsers = await this.repo.listUsers();
    if (wouldRemoveLastAdmin(allUsers, userId, role)) {
      throw new LastAdminError();
    }

    const updated = await this.repo.updateUserRole(userId, role);
    await this.repo.deleteSessionsForUser(userId);

    this.log.info('[AuthService] User role changed', {
      actorId: actor.userId,
      userId,
      role,
    });

    return toUserView(updated);
  }

  /**
   * Deletes a user. Refuses self-mutation (409) and a deletion that would
   * leave zero admins (409). `deleteSessionsForUser` runs after the delete —
   * the FK cascade has usually already removed the sessions, but the
   * explicit call makes the guarantee independent of any adapter's FK
   * behaviour, and keeps it idempotent to call regardless.
   */
  async deleteUser(userId: UserId, actor: ValidatedSession): Promise<void> {
    if (userId === actor.userId) {
      throw new SelfMutationError('Cannot delete your own account');
    }

    const target = await this.repo.getUserById(userId);
    if (!target) {
      throw new UserNotFoundError(userId);
    }

    const allUsers = await this.repo.listUsers();
    if (wouldRemoveLastAdmin(allUsers, userId, null)) {
      throw new LastAdminError();
    }

    await this.repo.deleteUser(userId);
    await this.repo.deleteSessionsForUser(userId);

    this.log.info('[AuthService] User deleted', { actorId: actor.userId, userId });
  }

  /**
   * Admin-set password reset. Verifies nothing about the old credential — an
   * admin session can already do far more damage than this, so gating it on
   * proof of the old password would buy nothing (docs/auth.md). Revokes the
   * target's sessions, same as the CLI reset path.
   */
  async resetUserPassword(userId: UserId, newPassword: string, actor: ValidatedSession): Promise<void> {
    const target = await this.repo.getUserById(userId);
    if (!target) {
      throw new UserNotFoundError(userId);
    }
    assertPasswordPolicy(newPassword);

    const passwordHash = await hashPassword(newPassword);
    await this.repo.updateUserPassword(userId, passwordHash);
    await this.repo.deleteSessionsForUser(userId);

    this.log.info('[AuthService] Password reset by admin', { actorId: actor.userId, userId });
  }

  /**
   * Self-service password change. Requires the current password (Q3) — a
   * hijacked session should not be able to lock the real user out by
   * changing to an unknown password without proving the old one. Revokes
   * EVERY session the user holds, including the caller's — there is no
   * "keep this one" carve-out (Q3).
   */
  async changeOwnPassword(userId: UserId, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.repo.getUserById(userId);
    if (!user) {
      throw new UserNotFoundError(userId);
    }
    if (!user.passwordHash) {
      // A credential-less (future WebAuthn-only) account cannot prove
      // ownership via a password it does not have.
      throw new InvalidCurrentPasswordError();
    }

    const valid = await verifyPassword(user.passwordHash, currentPassword);
    if (!valid) {
      throw new InvalidCurrentPasswordError();
    }

    assertPasswordPolicy(newPassword);

    const passwordHash = await hashPassword(newPassword);
    await this.repo.updateUserPassword(userId, passwordHash);
    await this.repo.deleteSessionsForUser(userId);

    this.log.info('[AuthService] Self-service password change', { userId });
  }
}
