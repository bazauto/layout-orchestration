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
  /** Resets an existing user's password hash. Used by the bootstrap/reset CLI (scripts/bootstrap-admin.ts). */
  updateUserPassword(id: UserId, passwordHash: string): Promise<UserRecord>;
  /**
   * Whether the `users` table has at least one row. Used for first-run
   * bootstrap (services/bootstrapAdmin.ts) to decide whether to auto-create
   * an admin account — checked against the whole table, not a specific
   * username, so an operator who has since renamed or removed the default
   * admin is never silently overridden on the next restart.
   */
  hasAnyUsers(): Promise<boolean>;
  /** Every user, ordered by username ascending — deterministic for the UI and for tests. */
  listUsers(): Promise<UserRecord[]>;
  /** Throws `LastAdminError` if the DB-level trigger aborts the update (see migration 0006). */
  updateUserRole(id: UserId, role: Role): Promise<UserRecord>;
  /**
   * Sessions cascade at the FK level; `AuthService` also calls
   * `deleteSessionsForUser` explicitly (Q2) so the guarantee does not depend
   * on any adapter's FK behaviour. Throws `LastAdminError` if the DB-level
   * trigger aborts the delete.
   */
  deleteUser(id: UserId): Promise<void>;

  createSession(data: Omit<SessionRecord, 'id' | 'createdAt'>): Promise<SessionRecord>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /** Sliding refresh: extends `expiresAt` on the existing session in place. */
  updateSessionExpiry(id: SessionId, expiresAt: Date): Promise<SessionRecord>;
  deleteSession(id: SessionId): Promise<void>;
  /** Deletes every session belonging to a user, e.g. on account removal. */
  deleteSessionsForUser(userId: UserId): Promise<void>;
}

/**
 * Thrown when a write would leave the layout with zero admin accounts (Q1).
 * Declared here, not in `AuthService`, because both layers throw it: the
 * service from its `wouldRemoveLastAdmin` pre-check, `DrizzleAuthRepository`
 * when translating the DB trigger's abort (migration
 * `0006_users_last_admin_guard.sql`). The port is the contract both sides
 * share, so neither imports the other's module for the error type.
 */
export class LastAdminError extends Error {
  constructor() {
    super('Cannot remove the last admin account');
    this.name = 'LastAdminError';
  }
}

/** Thrown when a username is already taken — see `LastAdminError` for why this lives on the port rather than the service. */
export class UsernameTakenError extends Error {
  readonly username: string;

  constructor(username: string) {
    super(`Username '${username}' is already taken`);
    this.name = 'UsernameTakenError';
    this.username = username;
  }
}
