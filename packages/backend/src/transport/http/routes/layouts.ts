import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';

export async function layoutRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
): Promise<void> {
  fastify.get('/api/layouts', async () => {
    return repo.listLayouts();
  });

  fastify.get<{ Params: { id: string } }>('/api/layouts/:id', async (req, reply) => {
    const layout = await repo.getLayout(req.params.id);
    if (!layout) return reply.status(404).send({ error: 'Layout not found' });
    return layout;
  });

  fastify.post<{ Body: { name: string; description?: string } }>(
    '/api/layouts',
    async (req, reply) => {
      const layout = await repo.createLayout({
        name: req.body.name,
        description: req.body.description ?? null,
      });
      return reply.status(201).send(layout);
    },
  );

  fastify.delete<{ Params: { id: string } }>('/api/layouts/:id', async (req, reply) => {
    await repo.deleteLayout(req.params.id);
    return reply.status(204).send();
  });
}
