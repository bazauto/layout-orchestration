import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';

export async function blockRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/blocks',
    async (req) => {
      return repo.listBlocks(req.params.layoutId);
    },
  );

  fastify.post<{
    Params: { layoutId: string };
    Body: { name: string };
  }>('/api/layouts/:layoutId/blocks', async (req, reply) => {
    const block = await repo.createBlock({
      layoutId: req.params.layoutId,
      name: req.body.name,
    });
    return reply.status(201).send(block);
  });

  fastify.put<{
    Params: { layoutId: string; id: string };
    Body: { name: string };
  }>('/api/layouts/:layoutId/blocks/:id', async (req, reply) => {
    const updated = await repo.updateBlock(req.params.id, { name: req.body.name });
    return reply.status(200).send(updated);
  });

  fastify.delete<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/blocks/:id',
    async (req, reply) => {
      await repo.deleteBlock(req.params.id);
      return reply.status(204).send();
    },
  );
}
