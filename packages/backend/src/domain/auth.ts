/**
 * Pure password hashing/verification and session-token logic for local
 * authentication. No imports from transport, adapters, or db — this module
 * has no knowledge of Fastify, HTTP, cookies, or SQLite; `AuthService` wraps
 * it with persistence.
 *
 * Password hashing uses argon2id via `@node-rs/argon2` (napi-rs prebuilt
 * native bindings, including win32-x64-msvc) rather than the `argon2`
 * package, so installing this workspace never requires a node-gyp/C++ build
 * toolchain. Its defaults (`m=19456` KiB, `t=2`, `p=1`, algorithm argon2id)
 * already meet the OWASP minimum recommendation, so they are used as-is
 * rather than overridden.
 */

import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { createHash, randomBytes } from 'crypto';

// ─── Passwords ──────────────────────────────────────────────────────────────

/**
 * Hashes a plaintext password with argon2id. The returned string embeds the
 * algorithm, parameters, and salt alongside the digest — nothing else needs
 * to be stored to later verify it.
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password);
}

/**
 * Verifies a plaintext password against a stored argon2id hash.
 * A malformed/foreign hash string makes the underlying library throw rather
 * than return false; that is treated identically to a mismatch here — a
 * hashing error must never be mistaken for a successful login (fail-safe).
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password);
  } catch {
    return false;
  }
}

// ─── Session Tokens ─────────────────────────────────────────────────────────

/** Bytes of entropy in a generated session token (256 bits). */
const SESSION_TOKEN_BYTES = 32;

/** Generates a new opaque, cryptographically random session token. */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

/**
 * Hashes a session token for storage and lookup. SHA-256 is sufficient here
 * — unlike a password, a session token already carries 256 bits of entropy,
 * so this hash exists only to keep a database read (backup, dump, accidental
 * log line) from directly yielding a usable session, not to resist offline
 * brute force of low-entropy input the way argon2id does for passwords.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ─── Password Policy ────────────────────────────────────────────────────────

/**
 * Shared by `AuthService` (create/reset/self-service change) and
 * `scripts/bootstrap-admin.ts`, so the CLI and the HTTP schema enforce one
 * rule rather than two that could drift apart.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Applies to NEW passwords only (create/reset/change) — `loginSchema` is
 * deliberately untouched by this cap. Capping login input could lock out an
 * account whose password predates the cap.
 */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Normalises a username for storage/comparison. Trim only — case is
 * preserved and compared exactly, so `Paul` and `paul` remain distinct
 * accounts. See docs/auth.md for why a case-insensitive unique index was
 * rejected (a table rebuild on a live layout DB, for a two-user household).
 */
export function normaliseUsername(raw: string): string {
  return raw.trim();
}

// ─── Sliding Expiry ─────────────────────────────────────────────────────────

/** Session lifetime: 30 days, refreshed on every validated use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Computes the expiry timestamp for a new or refreshed session, `SESSION_TTL_MS` from `now`. */
export function computeSessionExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

/** Whether a session is expired at `now` — i.e. `now` has reached or passed `expiresAt`. */
export function isSessionExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= expiresAt.getTime();
}
