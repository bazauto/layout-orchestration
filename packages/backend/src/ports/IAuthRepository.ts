/**
 * Port: IAuthRepository
 *
 * Defines the contract for persisting and retrieving local operator accounts
 * and their sessions. Implementation: DrizzleAuthRepository (SQLite via
 * Drizzle ORM), mirroring ILayoutRepository/DrizzleRepository.
 */

import { Role, SessionId, UserId } from '../domain/types';

export interface UserRecord {
  id: UserId;
  username: string;
  /** argon2id encoded hash. NULL = no password credential set (reserved for a future WebAuthn-only account — see schema.ts). */
  passwordHash: string | null;
  role: Role;
  createdAt: Date;
}

export interface SessionRecord {
  id: SessionId;
  userId: UserId;
  /** SHA-256 hex digest of the opaque session token. Never the raw token. */
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface IAuthRepository {
  getUserByUsername(username: string): Promise<UserRecord | null>;
  getUserById(id: UserId): Promise<UserRecord | null>;
  createUser(data: Omit<UserRecord, 'id' | 'createdAt'>): Promise<UserRecord>;

  createSession(data: Omit<SessionRecord, 'id' | 'createdAt'>): Promise<SessionRecord>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /** Sliding refresh: extends `expiresAt` on the existing session in place. */
  updateSessionExpiry(id: SessionId, expiresAt: Date): Promise<SessionRecord>;
  deleteSession(id: SessionId): Promise<void>;
  /** Deletes every session belonging to a user, e.g. on account removal. */
  deleteSessionsForUser(userId: UserId): Promise<void>;
}
