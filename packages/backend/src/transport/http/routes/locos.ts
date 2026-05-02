import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';

export async function locoRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/locos',
    async (req) => {
      return repo.listLocos(req.params.layoutId);
    },
  );

  fastify.post<{
    Params: { layoutId: string };
    Body: {
      name: string;
      address: number;
      type?: string;
      maxSpeed?: number;
      brakingFactor?: number;
    };
  }>('/api/layouts/:layoutId/locos', async (req, reply) => {
    const loco = await repo.createLoco({
      layoutId: req.params.layoutId,
      name: req.body.name,
      address: req.body.address,
      type: req.body.type ?? 'unknown',
      maxSpeed: req.body.maxSpeed ?? 126,
      brakingFactor: req.body.brakingFactor ?? 0.5,
    });
    return reply.status(201).send(loco);
  });

  fastify.put<{
    Params: { layoutId: string; id: string };
    Body: { name?: string; address?: number; type?: string; maxSpeed?: number; brakingFactor?: number };
  }>('/api/layouts/:layoutId/locos/:id', async (req, reply) => {
    const updated = await repo.updateLoco(req.params.id, req.body);
    return reply.status(200).send(updated);
  });

  fastify.delete<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/locos/:id',
    async (req, reply) => {
      await repo.deleteLoco(req.params.id);
      return reply.status(204).send();
    },
  );
}
