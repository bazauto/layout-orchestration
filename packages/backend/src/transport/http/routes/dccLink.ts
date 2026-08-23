import { FastifyInstance } from 'fastify';
import { DccLinkNotFaultedError, LayoutService } from '../../../services/LayoutService';

/**
 * The command station link (#148, `docs/dcc-link.md`).
 *
 * Two routes, both scoped by `layoutId` for consistency with every sibling —
 * although the link is a property of the *process*, not of a layout, since one
 * backend drives one command station. The path shape is the convention, not a
 * claim that a second layout would have a second station.
 */
export async function dccLinkRoutes(
  fastify: FastifyInstance,
  layoutService: LayoutService,
): Promise<void> {
  /** Read-only: responsiveness, the latched fault, both track power states, and the station's identity. */
  fastify.get('/api/layouts/:layoutId/dcc-link', async (_req, reply) => {
    return reply.status(200).send(layoutService.getDccLink());
  });

  /**
   * Clears the latched fault. No `preHandler`, so any authenticated role —
   * exactly the reasoning on `POST .../sensors/:id/acknowledge-fault`: it moves
   * the system out of Safe-Stop, so it needs a session, but it is a
   * driving-adjacent recovery action rather than an administrative one.
   *
   * 409 when nothing is latched. A no-op success would tell an operator their
   * acknowledgement landed when there was nothing to acknowledge — and the
   * likeliest reason for that is that they are looking at a stale screen.
   */
  fastify.post('/api/layouts/:layoutId/dcc-link/acknowledge-fault', async (_req, reply) => {
    try {
      return reply.status(200).send(await layoutService.acknowledgeDccLinkFault());
    } catch (err) {
      if (err instanceof DccLinkNotFaultedError) {
        return reply.status(409).send({ error: err.message });
      }
      throw err;
    }
  });
}
