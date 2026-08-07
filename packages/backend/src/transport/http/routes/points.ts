import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';
import {
  RecordNotFoundError,
  TopologyRejectedError,
  TopologyService,
} from '../../../services/TopologyService';
import { pointUpdateSchema } from '../../../services/validation';
import { requireAdmin } from '../auth/hook';

export async function pointRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
  topologyService: TopologyService,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/points',
    async (req) => {
      return repo.listPoints(req.params.layoutId);
    },
  );

  // Defining a point (its DCC address, block assignment) is topology
  // config — admin-only. Throwing an existing point (POINT_COMMAND over
  // WebSocket) is driving, not gated by role.
  fastify.post<{
    Params: { layoutId: string };
    Body: { name: string; dccAddress: number; blockId?: string };
  }>('/api/layouts/:layoutId/points', { preHandler: requireAdmin }, async (req, reply) => {
    const point = await repo.createPoint({
      layoutId: req.params.layoutId,
      name: req.body.name,
      dccAddress: req.body.dccAddress,
      blockId: req.body.blockId ?? null,
    });
    return reply.status(201).send(point);
  });

  // Same admin-only posture as create. Delegates to
  // TopologyService#updatePoint for the layoutId ownership check — see its
  // doc comment for why this does not need a topology revalidation pass the
  // way an edge write does.
  fastify.put<{ Params: { layoutId: string; id: string }; Body: unknown }>(
    '/api/layouts/:layoutId/points/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = pointUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid point payload', details: parsed.error.flatten() });
      }

      try {
        const updated = await topologyService.updatePoint(
          req.params.layoutId,
          req.params.id,
          parsed.data,
        );
        return reply.status(200).send(updated);
      } catch (err) {
        if (err instanceof RecordNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // Refuses to delete a point still referenced by an edge's pointConditions
  // — see TopologyService#deletePointIfUnreferenced.
  fastify.delete<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/points/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        await topologyService.deletePointIfUnreferenced(req.params.layoutId, req.params.id);
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof RecordNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        if (err instanceof TopologyRejectedError) {
          return reply.status(422).send({ error: err.message, violations: err.violations });
        }
        throw err;
      }
    },
  );
}
