/**
 * useAuth
 *
 * Session state for the local username/password login (see docs/auth.md).
 * On mount, checks for an existing session via GET /api/auth/me (the
 * session cookie, if any, is sent automatically). Registers itself as the
 * app-wide 401 handler (see api.ts) so any other hook's request failing
 * with 401 — an expired or invalid session — flips the app back to
 * 'unauthenticated' too, not just a direct call to `login`/`logout`.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch, setUnauthorizedHandler } from '../api';
import { Role } from '../types';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthUser {
  username: string;
  role: Role;
}

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  const markLoggedOut = useCallback(() => {
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(markLoggedOut);
    return () => setUnauthorizedHandler(null);
  }, [markLoggedOut]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/auth/me')
      .then(async (res) => {
        if (cancelled) return;
        if (res.ok) {
          setUser((await res.json()) as AuthUser);
          setStatus('authenticated');
        } else {
          setStatus('unauthenticated');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('unauthenticated');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}) as { error?: string });
        setError(body.error ?? `Login failed (HTTP ${res.status})`);
        return false;
      }
      setUser((await res.json()) as AuthUser);
      setStatus('authenticated');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    markLoggedOut();
  }, [markLoggedOut]);

  return { status, user, error, login, logout };
}
