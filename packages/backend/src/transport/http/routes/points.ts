import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';
import { INameBook } from '../../../ports/INameBook';
import {
  LockedByRouteError,
  RecordNotFoundError,
  TopologyRejectedError,
  TopologyService,
} from '../../../services/TopologyService';
import { pointCreateSchema, pointUpdateSchema } from '../../../services/validation';
import { requireAdmin } from '../auth/hook';

export async function pointRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
  topologyService: TopologyService,
  nameBook: INameBook,
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
  fastify.post<{ Params: { layoutId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/points',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = pointCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid point payload', details: parsed.error.flatten() });
      }

      const point = await repo.createPoint({
        layoutId: req.params.layoutId,
        name: parsed.data.name,
        dccAddress: parsed.data.dccAddress,
        blockId: parsed.data.blockId,
      });
      // D5: refresh after the write so the new point's name is available to
      // the next operator-facing string that renders it.
      await nameBook.refresh(req.params.layoutId);
      return reply.status(201).send(point);
    },
  );

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
        await nameBook.refresh(req.params.layoutId);
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
        await nameBook.refresh(req.params.layoutId);
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof RecordNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        // See `blocks.ts` — D10's write-guard was reaching Fastify's default
        // handler as a 500. A held point is a 409, distinct from the 422 below:
        // 422 means the *graph* refused (an edge still references this point),
        // 409 means a live route is holding it and cancelling the route is what
        // unblocks the delete.
        if (err instanceof LockedByRouteError) {
          return reply.status(409).send({ error: err.message, routeId: err.routeId });
        }
        if (err instanceof TopologyRejectedError) {
          return reply.status(422).send({ error: err.message, violations: err.violations });
        }
        throw err;
      }
    },
  );
}
