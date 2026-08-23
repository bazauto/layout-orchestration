/**
 * Global authentication enforcement.
 *
 * A single `onRequest` hook, registered once on the root Fastify instance
 * (see server.ts), so it runs for every route registered afterward —
 * including the `/ws` upgrade. `onRequest` runs before `@fastify/websocket`
 * completes the protocol switch, so rejecting here sends a normal 401 HTTP
 * response and the upgrade never happens; no separate check is needed in
 * transport/websocket/index.ts.
 *
 * Auth is enforced ONLY at this edge — never mid-connection on a live
 * WebSocket. Once a socket is open, nothing tears it down for an auth
 * reason while a train might be moving.
 *
 * Exemptions, and why each exists:
 *  - GET  /health              — liveness/monitoring, carries no layout data.
 *  - POST /api/auth/login      — must be reachable before a session exists.
 *  - POST /api/emergency-stop  — deliberately unauthenticated. It can only
 *    move the system in the fail-safe direction; requiring a login before
 *    someone can halt a runaway is the wrong trade. See docs/auth.md.
 *    Every other control path (throttle, points, functions, mode changes)
 *    requires auth.
 *  - Whatever `isPublicPath` accepts — the built SPA's own files, when a
 *    deployment is serving them from this process (#143). Supplied by
 *    server.ts rather than listed here because the paths are a fact about
 *    Vite's build output, not about authentication. It is a predicate and not
 *    a prefix so that it stays deny-by-default: registering the static plugin
 *    does not, on its own, make anything public.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AuthService, ValidatedSession } from '../../../services/AuthService';
import { sessionCookieOptions } from './cookie';

declare module 'fastify' {
  interface FastifyRequest {
    user?: ValidatedSession;
  }
}

const EXEMPT_PATHS = new Set(['/health', '/api/auth/login', '/api/emergency-stop']);

export interface AuthHookLogger {
  warn(msg: string, data?: Record<string, unknown>): void;
}

export function registerAuthHook(
  fastify: FastifyInstance,
  authService: AuthService,
  cookieName: string,
  cookieSecure: boolean,
  isPublicPath: (path: string) => boolean = () => false,
): void {
  fastify.decorateRequest('user', undefined);

  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Path only — a query string on an exempt path (there isn't one today)
    // must not accidentally fall through the exemption check.
    const path = request.url.split('?')[0];
    if (EXEMPT_PATHS.has(path) || isPublicPath(path)) {
      return;
    }

    const token = request.cookies?.[cookieName];
    if (!token) {
      return reply.status(401).send({ error: 'Authentication required' });
    }

    const session = await authService.validateSession(token);
    if (!session) {
      reply.clearCookie(cookieName, { path: '/' });
      return reply.status(401).send({ error: 'Authentication required' });
    }

    request.user = session;

    // Sliding expiry: validateSession() has just refreshed the server-side
    // session's expiry. Reissue the cookie with a fresh Max-Age so the
    // browser-side expiry tracks it too — otherwise the cookie would still
    // expire 30 days after login regardless of continued use.
    reply.setCookie(cookieName, token, sessionCookieOptions(cookieSecure));
  });
}

/**
 * Route preHandler: rejects any request whose session role is not 'admin'.
 * Applied to every write route under topology/config (blocks, points,
 * sensors, locos, layouts, grid tiles, edges) — 'operator' may drive, only
 * 'admin' may edit topology and config.
 *
 * The onRequest hook above always runs first and already rejects an
 * unauthenticated request, so `request.user` is only missing here if this
 * guard were mistakenly applied to an exempt route.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.user?.role !== 'admin') {
    await reply.status(403).send({ error: 'Admin role required' });
  }
}
