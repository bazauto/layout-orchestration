import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';
import { RecordNotFoundError, TopologyService } from '../../../services/TopologyService';
import { requireAdmin } from '../auth/hook';

export async function blockRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
  topologyService: TopologyService,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/blocks',
    async (req) => {
      return repo.listBlocks(req.params.layoutId);
    },
  );

  // Topology config — admin-only. 'operator' may drive, not edit topology.
  fastify.post<{
    Params: { layoutId: string };
    Body: { name: string };
  }>('/api/layouts/:layoutId/blocks', { preHandler: requireAdmin }, async (req, reply) => {
    const block = await repo.createBlock({
      layoutId: req.params.layoutId,
      name: req.body.name,
    });
    return reply.status(201).send(block);
  });

  fastify.put<{
    Params: { layoutId: string; id: string };
    Body: { name: string };
  }>(
    '/api/layouts/:layoutId/blocks/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const updated = await repo.updateBlock(req.params.id, { name: req.body.name });
      return reply.status(200).send(updated);
    },
  );

  // Deletes the block and every edge that references it, atomically — see
  // TopologyService#deleteBlockWithEdges and ILayoutRepository#deleteBlock.
  fastify.delete<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/blocks/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const result = await topologyService.deleteBlockWithEdges(
          req.params.layoutId,
          req.params.id,
        );
        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof RecordNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
