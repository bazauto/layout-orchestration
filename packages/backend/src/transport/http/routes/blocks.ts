import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';
import { RecordNotFoundError, TopologyService } from '../../../services/TopologyService';
import { blockCreateSchema, blockUpdateSchema } from '../../../services/validation';
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
  // The `Body: unknown` + `safeParse` pairing is the point: a Fastify `Body`
  // generic is erased at compile time and validates nothing at runtime
  // (CLAUDE.md safety rule 3), so the Zod schema is the only real gate.
  fastify.post<{ Params: { layoutId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/blocks',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = blockCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid block payload', details: parsed.error.flatten() });
      }

      const block = await repo.createBlock({
        layoutId: req.params.layoutId,
        name: parsed.data.name,
      });
      return reply.status(201).send(block);
    },
  );

  fastify.put<{ Params: { layoutId: string; id: string }; Body: unknown }>(
    '/api/layouts/:layoutId/blocks/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = blockUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid block payload', details: parsed.error.flatten() });
      }

      const updated = await repo.updateBlock(req.params.id, parsed.data);
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
