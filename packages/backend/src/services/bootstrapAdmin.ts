/**
 * bootstrapAdmin
 *
 * First-run admin bootstrap, called once at startup (index.ts). If the
 * `users` table is completely empty, creates a single admin account from
 * `INITIAL_ADMIN_PASSWORD` — and refuses to start if that env var isn't
 * set, because a fresh deployment with zero accounts and no way to log in
 * is a permanent lockout, which is a worse failure than not starting.
 *
 * Deliberately checked against the whole table (`hasAnyUsers`), not a
 * specific username: an operator who has since renamed or deleted the
 * default admin account must never have it silently recreated by a stale
 * `INITIAL_ADMIN_PASSWORD` still sitting in `.env` on the next restart.
 *
 * There is no `AUTH_ENABLED` bypass — this is the only special-casing auth
 * gets, and it only fires once, on a table with no rows at all.
 */

import { hashPassword } from '../domain/auth';
import { IAuthRepository } from '../ports/IAuthRepository';

export const DEFAULT_ADMIN_USERNAME = 'admin';

export interface BootstrapAdminLogger {
  info(msg: string, data?: Record<string, unknown>): void;
}

/** Thrown when the `users` table is empty and no `INITIAL_ADMIN_PASSWORD` was provided to bootstrap it. */
export class BootstrapRequiredError extends Error {
  constructor() {
    super(
      'No users exist yet and INITIAL_ADMIN_PASSWORD is not set. Refusing to ' +
        'start with no way to log in — set INITIAL_ADMIN_PASSWORD in .env and ' +
        'restart, or run `npx tsx scripts/bootstrap-admin.ts <username> <password>`. ' +
        'See docs/auth.md.',
    );
    this.name = 'BootstrapRequiredError';
  }
}

export async function bootstrapAdminIfNeeded(
  authRepo: IAuthRepository,
  initialAdminPassword: string | undefined,
  log: BootstrapAdminLogger,
  adminUsername: string = DEFAULT_ADMIN_USERNAME,
): Promise<void> {
  const hasUsers = await authRepo.hasAnyUsers();
  if (hasUsers) {
    return;
  }

  if (!initialAdminPassword) {
    throw new BootstrapRequiredError();
  }

  const passwordHash = await hashPassword(initialAdminPassword);
  await authRepo.createUser({ username: adminUsername, passwordHash, role: 'admin' });
  log.info('[Bootstrap] Created initial admin account', { username: adminUsername });
}
