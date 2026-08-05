import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';
import {
  RecordNotFoundError,
  TopologyRejectedError,
  TopologyService,
} from '../../../services/TopologyService';

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

  fastify.post<{
    Params: { layoutId: string };
    Body: { name: string; dccAddress: number; blockId?: string };
  }>('/api/layouts/:layoutId/points', async (req, reply) => {
    const point = await repo.createPoint({
      layoutId: req.params.layoutId,
      name: req.body.name,
      dccAddress: req.body.dccAddress,
      blockId: req.body.blockId ?? null,
    });
    return reply.status(201).send(point);
  });

  // Refuses to delete a point still referenced by an edge's pointConditions
  // — see TopologyService#deletePointIfUnreferenced.
  fastify.delete<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/points/:id',
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
