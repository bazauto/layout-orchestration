/**
 * DrizzleAuthRepository
 *
 * SQLite implementation of IAuthRepository using Drizzle ORM and
 * better-sqlite3, mirroring DrizzleRepository. Every read goes through
 * `parseUserRow`/`parseSessionRow` — full-row Zod validation, not just
 * selected fields — matching the `parseBlockEdgeRow` precedent.
 */

import { eq } from 'drizzle-orm';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { randomUUID } from 'crypto';
import { IAuthRepository, SessionRecord, UserRecord } from '../../ports/IAuthRepository';
import { SessionId, UserId } from '../../domain/types';
import { parseSessionRow, parseUserRow } from '../../services/validation';
import { sessions, users } from './schema';

export class DrizzleAuthRepository implements IAuthRepository {
  /**
   * Takes an already-open, already-migrated connection (see
   * `adapters/db/connection.ts#openDatabase`) — shared with
   * `DrizzleRepository` rather than opened independently. See the doc
   * comment on `DrizzleRepository`'s constructor for why.
   */
  constructor(private readonly db: BetterSQLite3Database) {}

  // ─── Users ──────────────────────────────────────────────────────────────────

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const rows = this.db.select().from(users).where(eq(users.username, username)).all();
    return rows.length > 0 ? parseUserRow(rows[0]) : null;
  }

  async getUserById(id: UserId): Promise<UserRecord | null> {
    const rows = this.db.select().from(users).where(eq(users.id, id)).all();
    return rows.length > 0 ? parseUserRow(rows[0]) : null;
  }

  async createUser(data: Omit<UserRecord, 'id' | 'createdAt'>): Promise<UserRecord> {
    const id = randomUUID();
    const createdAt = new Date();
    this.db
      .insert(users)
      .values({
        id,
        username: data.username,
        passwordHash: data.passwordHash,
        role: data.role,
        createdAt,
      })
      .run();
    const created = await this.getUserById(id);
    if (!created) throw new Error(`User ${id} not found after create`);
    return created;
  }

  async updateUserPassword(id: UserId, passwordHash: string): Promise<UserRecord> {
    this.db.update(users).set({ passwordHash }).where(eq(users.id, id)).run();
    const updated = await this.getUserById(id);
    if (!updated) throw new Error(`User ${id} not found after password update`);
    return updated;
  }

  async hasAnyUsers(): Promise<boolean> {
    const rows = this.db.select({ id: users.id }).from(users).limit(1).all();
    return rows.length > 0;
  }

  // ─── Sessions ───────────────────────────────────────────────────────────────

  async createSession(data: Omit<SessionRecord, 'id' | 'createdAt'>): Promise<SessionRecord> {
    const id = randomUUID();
    const createdAt = new Date();
    this.db
      .insert(sessions)
      .values({
        id,
        userId: data.userId,
        tokenHash: data.tokenHash,
        createdAt,
        expiresAt: data.expiresAt,
      })
      .run();
    const created = await this.getSessionByTokenHash(data.tokenHash);
    if (!created) throw new Error(`Session ${id} not found after create`);
    return created;
  }

  async getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const rows = this.db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash)).all();
    return rows.length > 0 ? parseSessionRow(rows[0]) : null;
  }

  async updateSessionExpiry(id: SessionId, expiresAt: Date): Promise<SessionRecord> {
    this.db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id)).run();
    const rows = this.db.select().from(sessions).where(eq(sessions.id, id)).all();
    if (!rows.length) throw new Error(`Session ${id} not found after update`);
    return parseSessionRow(rows[0]);
  }

  async deleteSession(id: SessionId): Promise<void> {
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
  }

  async deleteSessionsForUser(userId: UserId): Promise<void> {
    this.db.delete(sessions).where(eq(sessions.userId, userId)).run();
  }
}
