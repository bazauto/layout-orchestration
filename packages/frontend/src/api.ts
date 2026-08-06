/**
 * Shared REST API client helper.
 *
 * The backend now requires an authenticated session (HttpOnly cookie) for
 * every route except /health, POST /api/auth/login, and
 * POST /api/emergency-stop — see docs/auth.md. `apiFetch` wraps `fetch` so
 * every call site gets the same two things without repeating them:
 *
 *  - `credentials: 'include'` — the frontend dev server and the backend run
 *    on different ports, so they are different origins. `fetch`'s default
 *    credentials mode ('same-origin') would silently drop the session
 *    cookie on every request.
 *  - Centralised 401 handling — any call site's 401 means the session has
 *    expired or was never established, not "this one request failed";
 *    `setUnauthorizedHandler` lets the app react once, in one place
 *    (returning to the login screen), instead of every hook checking for
 *    401 individually.
 */

export const API_BASE = 'http://localhost:3000';

let unauthorizedHandler: (() => void) | null = null;

/** Registered once, by useAuth, so every apiFetch 401 flips the app back to "logged out". */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, { ...init, credentials: 'include' });
  if (res.status === 401) {
    unauthorizedHandler?.();
  }
  return res;
}
