import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';
import { INameBook } from '../../../ports/INameBook';
import { requireAdmin } from '../auth/hook';

export async function locoRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
  nameBook: INameBook,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/locos',
    async (req) => {
      return repo.listLocos(req.params.layoutId);
    },
  );

  // Roster config (editing which locos exist) is admin-only. Driving an
  // existing loco (THROTTLE_COMMAND/FUNCTION_COMMAND over WebSocket) is not
  // gated by role — 'operator' may drive.
  fastify.post<{
    Params: { layoutId: string };
    Body: {
      name: string;
      address: number;
      type?: string;
      maxSpeed?: number;
      brakingFactor?: number;
    };
  }>('/api/layouts/:layoutId/locos', { preHandler: requireAdmin }, async (req, reply) => {
    const loco = await repo.createLoco({
      layoutId: req.params.layoutId,
      name: req.body.name,
      address: req.body.address,
      type: req.body.type ?? 'unknown',
      maxSpeed: req.body.maxSpeed ?? 126,
      brakingFactor: req.body.brakingFactor ?? 0.5,
    });
    // D5: refresh after the write so the new loco's name is available to
    // the next operator-facing string that renders it.
    await nameBook.refresh(req.params.layoutId);
    return reply.status(201).send(loco);
  });

  fastify.put<{
    Params: { layoutId: string; id: string };
    Body: { name?: string; address?: number; type?: string; maxSpeed?: number; brakingFactor?: number };
  }>(
    '/api/layouts/:layoutId/locos/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const updated = await repo.updateLoco(req.params.id, req.body);
      await nameBook.refresh(req.params.layoutId);
      return reply.status(200).send(updated);
    },
  );

  fastify.delete<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/locos/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      await repo.deleteLoco(req.params.id);
      await nameBook.refresh(req.params.layoutId);
      return reply.status(204).send();
    },
  );
}
