/**
 * useUsers
 *
 * Fetches and mutates `/api/users` (issue #53). Admin-only on the backend —
 * this hook is only ever mounted from `UsersTab`, which `ConfigPanel` itself
 * only renders for `role === 'admin'` — but every mutation still surfaces a
 * non-2xx to the caller rather than assuming success, the same posture as
 * `useLayoutConfig`. The last-admin refusal (409) must be visible to the
 * operator, not swallowed.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { mutate, MutationResult } from './useLayoutConfig';
import { Role, UserView } from '../types';

export function useUsers() {
  const [users, setUsers] = useState<UserView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch('/api/users');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUsers((await res.json()) as UserView[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createUser = async (
    username: string,
    password: string,
    role: Role,
  ): Promise<MutationResult<UserView>> => {
    const result = await mutate<UserView>('/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, role }),
    });
    if (result.ok) await reload();
    return result;
  };

  const changeRole = async (id: string, role: Role): Promise<MutationResult<UserView>> => {
    const result = await mutate<UserView>(`/api/users/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role }),
    });
    if (result.ok) await reload();
    return result;
  };

  const deleteUser = async (id: string): Promise<MutationResult<void>> => {
    const result = await mutate<void>(`/api/users/${id}`, { method: 'DELETE' });
    if (result.ok) await reload();
    return result;
  };

  const resetPassword = async (id: string, password: string): Promise<MutationResult<void>> =>
    mutate<void>(`/api/users/${id}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });

  return { users, loading, error, reload, createUser, changeRole, deleteUser, resetPassword };
}
