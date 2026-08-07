/**
 * Route reservation HTTP routes (see docs/route-locking.md).
 *
 * Handlers parse, validate, and delegate to `LayoutService` — no business
 * logic here (CLAUDE.md rule 2). Not role-gated beyond requiring *some*
 * authenticated session: granting/driving a route is closer to the
 * un-role-gated WebSocket driving commands (THROTTLE_COMMAND, POINT_COMMAND)
 * than to topology/config authoring, which is what `requireAdmin` is for
 * (see docs/auth.md).
 */

import { FastifyInstance } from 'fastify';
import { LayoutService } from '../../../services/LayoutService';
import { RouteNotFoundError } from '../../../services/ReservationService';
import { describeRejections } from '../../../domain/routeLocking';
import { routeCancelSchema, routeRequestSchema } from '../../../services/validation';

export async function routeRoutes(
  fastify: FastifyInstance,
  layoutService: LayoutService,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>('/api/layouts/:layoutId/routes', async () => {
    return layoutService.listRoutes();
  });

  // 201 on grant; 422 with { error, rejections } on rejection — mirrors the
  // edges route's 422 + violations shape.
  fastify.post<{ Params: { layoutId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/routes',
    async (req, reply) => {
      const parsed = routeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid route request', details: parsed.error.flatten() });
      }

      const outcome = await layoutService.requestRoute(parsed.data);
      if (!outcome.granted) {
        return reply
          .status(422)
          .send({ error: describeRejections(outcome.rejections), rejections: outcome.rejections });
      }
      return reply.status(201).send(outcome.reservation);
    },
  );

  fastify.delete<{ Params: { layoutId: string; routeId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/routes/:routeId',
    async (req, reply) => {
      const parsed = routeCancelSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid cancel payload', details: parsed.error.flatten() });
      }

      try {
        await layoutService.cancelRoute(req.params.routeId, parsed.data.reason ?? 'operator cancel');
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof RouteNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // 200 on resume; 409 with { error } when D8's preconditions aren't met (a
  // remaining block not clear/unknown, or the current block not occupied).
  fastify.post<{ Params: { layoutId: string; routeId: string } }>(
    '/api/layouts/:layoutId/routes/:routeId/resume',
    async (req, reply) => {
      try {
        const result = await layoutService.resumeRoute(req.params.routeId);
        if (!result.resumed) {
          return reply.status(409).send({ error: result.reason });
        }
        return reply.status(200).send(result.reservation);
      } catch (err) {
        if (err instanceof RouteNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
