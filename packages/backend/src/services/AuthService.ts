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
  hashSessionToken,
  isSessionExpired,
  verifyPassword,
} from '../domain/auth';
import { Role, SessionId, UserId } from '../domain/types';
import { IAuthRepository } from '../ports/IAuthRepository';

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
}
