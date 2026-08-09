/**
 * Bootstrap / reset admin CLI.
 *
 * Creates the named account as an admin if it doesn't exist yet, or resets
 * its password (and revokes its existing sessions) if it does. This is the
 * "CLI reset command" from the issue #20 plan: physical/shell access to
 * this machine already implies access to track power, so a local recovery
 * path here is not a new hole — see docs/auth.md.
 *
 * The last-admin guard triggers (migration `0006_users_last_admin_guard.sql`,
 * issue #53) do not obstruct this script: it only ever inserts a new row or
 * updates `password_hash` on an existing one — it never sets `role` on an
 * update and never deletes — and neither of those is what either trigger
 * guards against.
 *
 * Usage (from packages/backend):
 *   npx tsx scripts/bootstrap-admin.ts <username> <password>
 */

import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(__dirname, '../../../.env') });

import { openDatabase } from '../src/adapters/db/connection';
import { DrizzleAuthRepository } from '../src/adapters/db/authRepository';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/domain/auth';

async function main() {
  const [, , username, password] = process.argv;

  if (!username || !password) {
    console.error('Usage: npx tsx scripts/bootstrap-admin.ts <username> <password>');
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  const dbPath = process.env.DATABASE_PATH ?? './data/layout.db';
  const migrationsFolder = process.env.MIGRATIONS_PATH ?? './migrations';
  const db = openDatabase(dbPath, migrationsFolder);
  const authRepo = new DrizzleAuthRepository(db);

  const passwordHash = await hashPassword(password);
  const existing = await authRepo.getUserByUsername(username);

  if (existing) {
    await authRepo.updateUserPassword(existing.id, passwordHash);
    // A password reset invalidates any session that might exist under the
    // old credential — e.g. if the reset is happening because the old
    // password was compromised.
    await authRepo.deleteSessionsForUser(existing.id);
    console.log(`[Bootstrap] Reset password for existing user: ${username} (role: ${existing.role})`);
  } else {
    const created = await authRepo.createUser({ username, passwordHash, role: 'admin' });
    console.log(`[Bootstrap] Created admin account: ${username} (${created.id})`);
  }
}

main().catch((err) => {
  console.error('[Bootstrap] Fatal:', err);
  process.exit(1);
});
