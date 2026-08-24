import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DccLinkNotFaultedError, LayoutService } from '../../../services/LayoutService';
import { requireNotMonitor } from '../auth/hook';

/**
 * The whole body. Deliberately explicit rather than a `/power/on` and
 * `/power/off` pair: an operator UI sends the state it wants, and a toggle that
 * derives "the other one" from a state that may read `unknown` is the same
 * mistake the point key avoided (#165 M14).
 */
const trackPowerBody = z.object({ on: z.boolean() });

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

  /**
   * Track power on or off (#149) — `admin` or `operator`, never `monitor`.
   *
   * Not admin-only, because this is an *operating* control and not a config
   * edit: powering down to re-rail a wagon or handle stock is ordinary driving,
   * and after a station cutoff it is the only recovery path that does not
   * involve reaching for the command station's power switch.
   *
   * A malformed body is an ordinary 400, per the standing convention that the
   * fail-safe rule is scoped to sensor and control *topics* — an operator UI
   * sending nonsense is a bug in the UI, not a reason to halt the layout.
   *
   * Answers with the link view rather than an acknowledgement, and that is the
   * point: `setTrackPower` probes the station afterwards, so what comes back is
   * the power state the **station reported**, not the one that was asked for.
   */
  fastify.post(
    '/api/layouts/:layoutId/dcc-link/power',
    { preHandler: requireNotMonitor },
    async (req, reply) => {
      const parsed = trackPowerBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Body must be { on: boolean }' });
      }

      await layoutService.setTrackPower(parsed.data.on);
      return reply.status(200).send(layoutService.getDccLink());
    },
  );
}
