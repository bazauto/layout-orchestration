import { FastifyInstance, FastifyReply } from 'fastify';
import {
  BlockEndBlockNotFoundError,
  BlockEndLabelTakenError,
  BlockEndNotFoundError,
  BlockEndReferencedError,
  BlockEndService,
} from '../../../services/BlockEndService';
import { LayoutNotFoundError } from '../../../services/GridService';
import { blockEndCreateSchema, blockEndUpdateSchema } from '../../../services/validation';
import { requireAdmin } from '../auth/hook';

/**
 * Block end routes (#72).
 *
 * Parse, validate, delegate — no decision here (CLAUDE.md safety rule 2). The
 * `Body: unknown` + `safeParse` pairing matches every other config route: a
 * Fastify `Body` generic is erased at compile time and validates nothing at
 * runtime, so the Zod schema is the only real gate.
 *
 * Every rejection is a 4xx. A block end is a *name*; nothing routes on one, so
 * nothing here can reach `SystemHealth`.
 *
 * Writes are admin-only, matching the rest of the topology surface. The read
 * is not: an operator seeing which end of a block is which is the same class
 * of information as seeing the diagram.
 */
export async function blockEndRoutes(
  fastify: FastifyInstance,
  service: BlockEndService,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/block-ends',
    async (req, reply) => {
      try {
        return await service.list(req.params.layoutId);
      } catch (err) {
        return mapBlockEndError(err, reply);
      }
    },
  );

  // Regeneration is a deliberate act, not a side effect of drawing (#72).
  // Redrawing a corner of the layout must never silently rename an end
  // underneath the edges referencing it, so this is a route an operator
  // presses rather than a hook on the grid write path.
  fastify.post<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/block-ends/generate',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        return await service.generate(req.params.layoutId);
      } catch (err) {
        return mapBlockEndError(err, reply);
      }
    },
  );

  fastify.post<{ Params: { layoutId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/block-ends',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = blockEndCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid block end payload', details: parsed.error.flatten() });
      }

      try {
        const end = await service.create(
          req.params.layoutId,
          parsed.data.blockId,
          parsed.data.label,
        );
        return reply.status(201).send(end);
      } catch (err) {
        return mapBlockEndError(err, reply);
      }
    },
  );

  fastify.put<{ Params: { layoutId: string; endId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/block-ends/:endId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = blockEndUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid block end payload', details: parsed.error.flatten() });
      }

      try {
        return await service.rename(req.params.layoutId, req.params.endId, parsed.data.label);
      } catch (err) {
        return mapBlockEndError(err, reply);
      }
    },
  );

  fastify.delete<{ Params: { layoutId: string; endId: string } }>(
    '/api/layouts/:layoutId/block-ends/:endId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        await service.remove(req.params.layoutId, req.params.endId);
        return reply.status(204).send();
      } catch (err) {
        return mapBlockEndError(err, reply);
      }
    },
  );
}

/**
 * Maps a `BlockEndService` rejection to its status code.
 *
 * **409 for a referenced end** is the one worth stating. It is not a
 * validation failure — the request was perfectly well-formed. It is a refusal
 * to rewrite the track graph as a side effect of a naming action: an end label
 * is the only link between an edge and a block end, so renaming one silently
 * re-points every edge using it. The operator edits the edges, or keeps the
 * name.
 */
function mapBlockEndError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof LayoutNotFoundError || err instanceof BlockEndNotFoundError) {
    return reply.status(404).send({ error: err.message });
  }
  if (err instanceof BlockEndBlockNotFoundError) {
    return reply.status(400).send({ error: err.message });
  }
  if (err instanceof BlockEndReferencedError) {
    return reply.status(409).send({ error: err.message, edgeIds: err.edgeIds });
  }
  if (err instanceof BlockEndLabelTakenError) {
    return reply.status(409).send({ error: err.message });
  }
  throw err;
}
