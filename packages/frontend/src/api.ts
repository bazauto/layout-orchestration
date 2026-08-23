/**
 * Shared REST API client helper.
 *
 * The backend now requires an authenticated session (HttpOnly cookie) for
 * every route except /health, POST /api/auth/login, and
 * POST /api/emergency-stop — see docs/auth.md. `apiFetch` wraps `fetch` so
 * every call site gets the same two things without repeating them:
 *
 *  - `credentials: 'include'` — kept even though every request is now
 *    same-origin (see `API_BASE`). It is redundant for a same-origin request
 *    and it is the correct behaviour the moment the SPA is served from
 *    somewhere else again, so removing it would turn a config change into a
 *    silent logged-out failure.
 *  - Centralised 401 handling — any call site's 401 means the session has
 *    expired or was never established, not "this one request failed";
 *    `setUnauthorizedHandler` lets the app react once, in one place
 *    (returning to the login screen), instead of every hook checking for
 *    401 individually.
 */

/**
 * Empty on purpose: every API path resolves against the page's own origin.
 *
 * This was the literal string `http://localhost:3000` until #143, which is
 * correct only when the browser is on the same machine as the backend.
 * Served from the bench box, it sent every request to port 3000 of *the
 * operator's* machine — the UI loaded and then talked to nothing.
 *
 * Origin-relative is right in all three deployments without a build-time
 * variable: in production the backend serves the built SPA itself
 * (`FRONTEND_DIST_PATH`), so the page origin *is* the API origin; under
 * `npm run dev:frontend` Vite proxies /api and /ws to :3000
 * (`vite.config.ts`); and Playwright drives that same dev server. A
 * hardcoded host here can only ever be right for one of the three.
 */
export const API_BASE = '';

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
