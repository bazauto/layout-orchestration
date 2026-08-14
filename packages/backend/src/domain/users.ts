/**
 * Last-admin predicate (Q1, docs/auth.md). Pure — imports only `./types`,
 * same posture as `domain/occupancy.ts` and `domain/routeLocking.ts`.
 *
 * This is the SERVICE half of the last-admin guard. It runs ahead of the
 * write to give a clean `LastAdminError` refusal in the common case; the
 * DB-level trigger pair in migration `0006_users_last_admin_guard.sql` closes
 * the interleave between this check and the write (#11's posture on route
 * exclusivity — both layers, not one).
 */

import { Role, UserId } from './types';

/**
 * Whether demoting or deleting `targetId` would leave the layout with zero
 * admin accounts. `nextRole === null` means deletion, not "no role" — there
 * is no such thing as a userless role change.
 *
 * The check is `nextRole !== 'admin'`, not `nextRole === 'operator'`, so it
 * needs no change when a third role is added: demoting the sole admin to
 * `monitor` (#63) is refused by the exact same rule that refuses demoting to
 * `operator`.
 */
export function wouldRemoveLastAdmin(
  users: ReadonlyArray<{ id: UserId; role: Role }>,
  targetId: UserId,
  nextRole: Role | null,
): boolean {
  const target = users.find((u) => u.id === targetId);
  if (!target || target.role !== 'admin') {
    // Not an admin today (or unknown) — demoting/deleting it cannot remove
    // an admin that wasn't there.
    return false;
  }
  if (nextRole === 'admin') {
    // Promoting an admin to admin is a no-op, never a removal.
    return false;
  }

  const remainingAdmins = users.filter((u) => u.role === 'admin' && u.id !== targetId).length;
  return remainingAdmins === 0;
}
