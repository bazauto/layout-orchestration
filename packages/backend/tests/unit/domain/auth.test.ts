import { describe, it, expect } from 'vitest';
import {
  computeSessionExpiry,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  isSessionExpired,
  normaliseUsername,
  SESSION_TTL_MS,
  verifyPassword,
} from '../../../src/domain/auth';

describe('hashPassword / verifyPassword', () => {
  it('produces an argon2id-encoded hash', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('the correct password verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
  });

  it('the wrong password fails', async () => {
    const hash = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
  });

  it('two hashes of the same password differ (random salt per hash)', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
  });

  it('a malformed hash string fails closed rather than throwing', async () => {
    await expect(verifyPassword('not-a-real-hash', 'anything')).resolves.toBe(false);
  });
});

describe('generateSessionToken', () => {
  it('generates a non-empty, URL-safe token', () => {
    const token = generateSessionToken();
    expect(token.length).toBeGreaterThan(0);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates a different token on every call', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
  });
});

describe('hashSessionToken', () => {
  it('is deterministic for the same token', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it('produces a 64-character hex digest (SHA-256)', () => {
    expect(hashSessionToken('some-token')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different tokens hash differently', () => {
    expect(hashSessionToken('token-a')).not.toBe(hashSessionToken('token-b'));
  });
});

describe('computeSessionExpiry / isSessionExpired', () => {
  it('computes an expiry SESSION_TTL_MS after the given time', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const expiry = computeSessionExpiry(now);
    expect(expiry.getTime() - now.getTime()).toBe(SESSION_TTL_MS);
  });

  it('a session expiring in the future is not expired', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const future = new Date(now.getTime() + 1000);
    expect(isSessionExpired(future, now)).toBe(false);
  });

  it('a session whose expiry has passed is expired', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const past = new Date(now.getTime() - 1000);
    expect(isSessionExpired(past, now)).toBe(true);
  });

  it('a session expiring exactly now is treated as expired (boundary is inclusive)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(isSessionExpired(now, now)).toBe(true);
  });
});

describe('normaliseUsername', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normaliseUsername('  alice  ')).toBe('alice');
  });

  it('preserves case', () => {
    expect(normaliseUsername('Alice')).toBe('Alice');
  });

  it('leaves an already-clean name alone', () => {
    expect(normaliseUsername('alice')).toBe('alice');
  });
});
