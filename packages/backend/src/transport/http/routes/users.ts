import { FastifyInstance } from 'fastify';
import {
  AuthService,
  PasswordPolicyError,
  SelfMutationError,
  UserNotFoundError,
} from '../../../services/AuthService';
import { LastAdminError, UsernameTakenError } from '../../../ports/IAuthRepository';
import {
  passwordResetSchema,
  userCreateSchema,
  userRoleUpdateSchema,
} from '../../../services/validation';
import { requireAdmin } from '../auth/hook';

/**
 * `/api/users` — account management (issue #53). Every route here is
 * `requireAdmin` (Q4): an operator may not enumerate accounts, and its own
 * identity is already available from `GET /api/auth/me`. Self-service
 * password change (`POST /api/auth/change-password`) is deliberately NOT
 * here — it lives in `routes/auth.ts` beside the rate-limit precedent, and
 * carries no admin guard.
 */
export async function userRoutes(fastify: FastifyInstance, authService: AuthService): Promise<void> {
  fastify.get('/api/users', { preHandler: requireAdmin }, async () => {
    return authService.listUsers();
  });

  fastify.post<{ Body: unknown }>(
    '/api/users',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = userCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid user payload', details: parsed.error.flatten() });
      }

      try {
        const created = await authService.createUser(parsed.data, req.user!);
        return reply.status(201).send(created);
      } catch (err) {
        if (err instanceof PasswordPolicyError) {
          return reply.status(400).send({ error: err.message });
        }
        if (err instanceof UsernameTakenError) {
          return reply.status(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  fastify.patch<{ Params: { id: string }; Body: unknown }>(
    '/api/users/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = userRoleUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid user payload', details: parsed.error.flatten() });
      }

      try {
        const updated = await authService.changeUserRole(req.params.id, parsed.data.role, req.user!);
        return reply.status(200).send(updated);
      } catch (err) {
        if (err instanceof UserNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        if (err instanceof SelfMutationError || err instanceof LastAdminError) {
          return reply.status(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/users/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        await authService.deleteUser(req.params.id, req.user!);
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof UserNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        if (err instanceof SelfMutationError || err instanceof LastAdminError) {
          return reply.status(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: unknown }>(
    '/api/users/:id/password',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = passwordResetSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid password payload', details: parsed.error.flatten() });
      }

      try {
        await authService.resetUserPassword(req.params.id, parsed.data.password, req.user!);
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof UserNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        if (err instanceof PasswordPolicyError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
