import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';

export async function pointRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
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

  fastify.delete<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/points/:id',
    async (req, reply) => {
      await repo.deletePoint(req.params.id);
      return reply.status(204).send();
    },
  );
}
