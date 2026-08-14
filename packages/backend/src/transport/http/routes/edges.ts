import { FastifyInstance } from 'fastify';
import {
  TopologyService,
  TopologyRejectedError,
  EdgeNotFoundError,
  EdgeLimitExceededError,
  LockedByRouteError,
} from '../../../services/TopologyService';
import { edgeCreateSchema, edgeUpdateSchema } from '../../../services/validation';
import { requireAdmin } from '../auth/hook';

export async function edgeRoutes(
  fastify: FastifyInstance,
  topologyService: TopologyService,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/edges',
    async (req) => {
      return topologyService.listEdges(req.params.layoutId);
    },
  );

  // Topology config — admin-only. 'operator' writing an edge is refused.
  fastify.post<{ Params: { layoutId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/edges',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = edgeCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid edge payload', details: parsed.error.flatten() });
      }

      try {
        const created = await topologyService.createEdge(req.params.layoutId, parsed.data);
        return reply.status(201).send(created);
      } catch (err) {
        if (err instanceof EdgeLimitExceededError) {
          return reply
            .status(409)
            .send({ error: err.message, limit: err.limit, current: err.current });
        }
        if (err instanceof TopologyRejectedError) {
          return reply.status(422).send({ error: err.message, violations: err.violations });
        }
        throw err;
      }
    },
  );

  fastify.put<{ Params: { layoutId: string; id: string }; Body: unknown }>(
    '/api/layouts/:layoutId/edges/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = edgeUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid edge payload', details: parsed.error.flatten() });
      }

      try {
        const updated = await topologyService.updateEdge(
          req.params.layoutId,
          req.params.id,
          parsed.data,
        );
        return reply.status(200).send(updated);
      } catch (err) {
        if (err instanceof EdgeNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        if (err instanceof LockedByRouteError) {
          return reply.status(409).send({ error: err.message, routeId: err.routeId });
        }
        if (err instanceof TopologyRejectedError) {
          return reply.status(422).send({ error: err.message, violations: err.violations });
        }
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/edges/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        await topologyService.deleteEdge(req.params.layoutId, req.params.id);
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof EdgeNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        if (err instanceof LockedByRouteError) {
          return reply.status(409).send({ error: err.message, routeId: err.routeId });
        }
        throw err;
      }
    },
  );
}
