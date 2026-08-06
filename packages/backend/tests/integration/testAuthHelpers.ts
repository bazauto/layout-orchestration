/**
 * Shared test-only auth fixtures.
 *
 * Per the plan on issue #20, integration tests log in for real via Fastify
 * `inject()` rather than any test-only bypass — there is deliberately no
 * `AUTH_ENABLED` flag. This module provides a small in-memory
 * `IAuthRepository` (real argon2id hashes via `hashPassword`, so the login
 * route's `verifyPassword` call is exercised for real) plus a helper that
 * logs in and returns a `Cookie` header value for subsequent requests.
 */

import { FastifyInstance, InjectOptions } from 'fastify';
import { AuthService, AuthServiceLogger } from '../../src/services/AuthService';
import { hashPassword } from '../../src/domain/auth';
import { IAuthRepository, SessionRecord, UserRecord } from '../../src/ports/IAuthRepository';
import { AuthTransportConfig } from '../../src/transport/http/server';

export const TEST_ADMIN_USERNAME = 'test-admin';
export const TEST_ADMIN_PASSWORD = 'correct-horse-battery-staple';
export const TEST_OPERATOR_USERNAME = 'test-operator';
export const TEST_OPERATOR_PASSWORD = 'battery-staple-correct-horse';

export const TEST_AUTH_CONFIG: AuthTransportConfig = {
  cookieName: 'layout_session',
  cookieSecure: false,
  corsAllowedOrigins: ['http://localhost:5173'],
};

const silentAuthLogger: AuthServiceLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** In-memory IAuthRepository seeded with one admin and one operator account. */
function makeTestAuthRepo(): IAuthRepository {
  const users = new Map<string, UserRecord>();
  const sessions = new Map<string, SessionRecord>();
  let nextUserId = 1;
  let nextSessionId = 1;

  return {
    getUserByUsername: async (username) =>
      [...users.values()].find((u) => u.username === username) ?? null,
    getUserById: async (id) => users.get(id) ?? null,
    createUser: async (data) => {
      const created: UserRecord = { id: `test-user-${nextUserId++}`, createdAt: new Date(), ...data };
      users.set(created.id, created);
      return created;
    },
    updateUserPassword: async (id, passwordHash) => {
      const existing = users.get(id);
      if (!existing) throw new Error(`Test user ${id} not found`);
      const updated = { ...existing, passwordHash };
      users.set(id, updated);
      return updated;
    },
    hasAnyUsers: async () => users.size > 0,
    createSession: async (data) => {
      const created: SessionRecord = {
        id: `test-session-${nextSessionId++}`,
        createdAt: new Date(),
        ...data,
      };
      sessions.set(created.id, created);
      return created;
    },
    getSessionByTokenHash: async (tokenHash) =>
      [...sessions.values()].find((s) => s.tokenHash === tokenHash) ?? null,
    updateSessionExpiry: async (id, expiresAt) => {
      const existing = sessions.get(id);
      if (!existing) throw new Error(`Test session ${id} not found`);
      const updated = { ...existing, expiresAt };
      sessions.set(id, updated);
      return updated;
    },
    deleteSession: async (id) => {
      sessions.delete(id);
    },
    deleteSessionsForUser: async (userId) => {
      for (const [id, session] of sessions) {
        if (session.userId === userId) sessions.delete(id);
      }
    },
  };
}

/** Builds an AuthService backed by the in-memory repo, seeded with an admin and an operator account. */
export async function makeTestAuthService(): Promise<AuthService> {
  const repo = makeTestAuthRepo();
  await repo.createUser({
    username: TEST_ADMIN_USERNAME,
    passwordHash: await hashPassword(TEST_ADMIN_PASSWORD),
    role: 'admin',
  });
  await repo.createUser({
    username: TEST_OPERATOR_USERNAME,
    passwordHash: await hashPassword(TEST_OPERATOR_PASSWORD),
    role: 'operator',
  });
  return new AuthService(repo, silentAuthLogger);
}

/** Logs in via the real route and returns the `Cookie` header value ("name=value"). */
export async function loginCookie(
  app: FastifyInstance,
  username: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Test login failed: ${res.statusCode} ${res.body}`);
  }
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('Login response did not set a cookie');
  return raw.split(';')[0];
}

/**
 * Logs `app` in as the seeded test admin and monkey-patches `app.inject` so
 * every subsequent call in the test — unchanged — carries the session
 * cookie automatically. Existing `app.inject({...})` call sites therefore
 * need no per-call edits; only this one line at server-build time.
 */
export async function authenticateAsAdmin(app: FastifyInstance): Promise<void> {
  const cookie = await loginCookie(app, TEST_ADMIN_USERNAME, TEST_ADMIN_PASSWORD);
  patchInjectWithCookie(app, cookie);
}

export async function authenticateAsOperator(app: FastifyInstance): Promise<void> {
  const cookie = await loginCookie(app, TEST_OPERATOR_USERNAME, TEST_OPERATOR_PASSWORD);
  patchInjectWithCookie(app, cookie);
}

// Keyed on the *true* unpatched inject, captured once per app — so calling
// authenticateAsAdmin/authenticateAsOperator more than once on the same app
// (e.g. to switch roles mid-test) always re-wraps the pristine original
// rather than nesting wrappers, which would let an earlier cookie silently
// win over a later one.
const originalInjectByApp = new WeakMap<FastifyInstance, FastifyInstance['inject']>();

function patchInjectWithCookie(app: FastifyInstance, cookie: string): void {
  if (!originalInjectByApp.has(app)) {
    originalInjectByApp.set(app, app.inject.bind(app));
  }
  const originalInject = originalInjectByApp.get(app)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app as any).inject = (opts: InjectOptions | string) => {
    const options: InjectOptions = typeof opts === 'string' ? { url: opts } : opts;
    return originalInject({ ...options, headers: { ...(options.headers ?? {}), cookie } });
  };
}
