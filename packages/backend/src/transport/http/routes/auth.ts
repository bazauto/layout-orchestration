import { FastifyInstance } from 'fastify';
import {
  AuthService,
  InvalidCredentialsError,
  InvalidCurrentPasswordError,
} from '../../../services/AuthService';
import { changePasswordSchema, loginSchema } from '../../../services/validation';
import { sessionCookieOptions } from '../auth/cookie';

export async function authRoutes(
  fastify: FastifyInstance,
  authService: AuthService,
  cookieName: string,
  cookieSecure: boolean,
): Promise<void> {
  // Exempt from the global auth hook (see transport/http/auth/hook.ts) —
  // this is the one route that must be reachable before a session exists.
  // Rate-limited separately from the global default: a login endpoint is
  // the one route worth protecting against credential-stuffing/brute-force
  // even on a LAN-only deployment.
  fastify.post<{ Body: unknown }>(
    '/api/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid login payload', details: parsed.error.flatten() });
      }

      try {
        const session = await authService.login(parsed.data.username, parsed.data.password);
        reply.setCookie(cookieName, session.token, sessionCookieOptions(cookieSecure));
        return reply
          .status(200)
          .send({ username: session.username, role: session.role });
      } catch (err) {
        if (err instanceof InvalidCredentialsError) {
          return reply.status(401).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  fastify.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies?.[cookieName];
    if (token) {
      await authService.logout(token);
    }
    reply.clearCookie(cookieName, { path: '/' });
    return reply.status(204).send();
  });

  // Protected by the global onRequest hook — reached only with a valid
  // session, so req.user is always set here.
  fastify.get('/api/auth/me', async (req, reply) => {
    if (!req.user) {
      return reply.status(401).send({ error: 'Authentication required' });
    }
    return { username: req.user.username, role: req.user.role };
  });

  // Self-service password change (Q3, docs/auth.md). Lives here rather than
  // routes/users.ts because it is the only new route that needs cookieName,
  // and it sits beside the login route's rate-limit precedent. No requireAdmin
  // — any authenticated user may change their own password. Rate-limited at
  // login parity: verifying the current password makes this a guessing
  // oracle exactly like login.
  fastify.post<{ Body: unknown }>(
    '/api/auth/change-password',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = changePasswordSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid password payload', details: parsed.error.flatten() });
      }

      try {
        await authService.changeOwnPassword(
          req.user!.userId,
          parsed.data.currentPassword,
          parsed.data.newPassword,
        );
      } catch (err) {
        if (err instanceof InvalidCurrentPasswordError) {
          return reply.status(403).send({ error: err.message });
        }
        throw err;
      }

      // A successful change already revoked every session the user holds
      // (Q3), including this request's — clear the cookie so the browser
      // doesn't keep sending a token the server no longer recognises.
      reply.clearCookie(cookieName, { path: '/' });
      return reply.status(204).send();
    },
  );
}
