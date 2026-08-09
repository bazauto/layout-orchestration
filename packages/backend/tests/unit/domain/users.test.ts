import { describe, it, expect } from 'vitest';
import { wouldRemoveLastAdmin } from '../../../src/domain/users';
import { Role, UserId } from '../../../src/domain/types';

function u(id: UserId, role: Role) {
  return { id, role };
}

describe('wouldRemoveLastAdmin', () => {
  it('demoting the sole admin is true', () => {
    const users = [u('a1', 'admin'), u('o1', 'operator')];
    expect(wouldRemoveLastAdmin(users, 'a1', 'operator')).toBe(true);
  });

  it('demoting one of two admins is false', () => {
    const users = [u('a1', 'admin'), u('a2', 'admin')];
    expect(wouldRemoveLastAdmin(users, 'a1', 'operator')).toBe(false);
  });

  it('deleting the sole admin is true', () => {
    const users = [u('a1', 'admin'), u('o1', 'operator')];
    expect(wouldRemoveLastAdmin(users, 'a1', null)).toBe(true);
  });

  it('deleting an operator when one admin exists is false', () => {
    const users = [u('a1', 'admin'), u('o1', 'operator')];
    expect(wouldRemoveLastAdmin(users, 'o1', null)).toBe(false);
  });

  it('promoting an operator to admin is false', () => {
    const users = [u('a1', 'admin'), u('o1', 'operator')];
    expect(wouldRemoveLastAdmin(users, 'o1', 'admin')).toBe(false);
  });

  it('an unknown targetId is false', () => {
    const users = [u('a1', 'admin')];
    expect(wouldRemoveLastAdmin(users, 'nobody', null)).toBe(false);
  });
});
