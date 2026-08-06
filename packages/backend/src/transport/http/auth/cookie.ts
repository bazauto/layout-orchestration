/**
 * Shared session-cookie serialize options.
 *
 * `HttpOnly` + `SameSite=Lax` are fixed, not configurable — see docs/auth.md
 * for why a cookie was chosen over a Bearer token (the browser `WebSocket`
 * constructor cannot set headers, but a cookie is sent automatically on the
 * upgrade request). `secure` is the one config-driven part: it must stay
 * `false` until TLS is in place, or the browser silently refuses to send
 * the cookie at all and every request looks unauthenticated.
 */

import { SESSION_TTL_MS } from '../../../domain/auth';

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
}

export function sessionCookieOptions(secure: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
