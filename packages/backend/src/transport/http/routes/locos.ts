import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';
import { INameBook } from '../../../ports/INameBook';
import { LayoutService, LocoNotFaultedError } from '../../../services/LayoutService';
import { describeBrakingRefusal } from '../../../domain/braking';
import { locoCreateSchema, locoUpdateSchema } from '../../../services/validation';
import { layoutLabel } from '../../../domain/naming';
import { requireAdmin } from '../auth/hook';

export async function locoRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
  nameBook: INameBook,
  layoutService: LayoutService,
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
  fastify.post<{ Params: { layoutId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/locos',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = locoCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid loco payload', details: parsed.error.flatten() });
      }
      const loco = await repo.createLoco({ layoutId: req.params.layoutId, ...parsed.data });
      // D5: refresh after the write so the new loco's name is available to
      // the next operator-facing string that renders it.
      await nameBook.refresh(req.params.layoutId);
      return reply.status(201).send(loco);
    },
  );

  fastify.put<{ Params: { layoutId: string; id: string }; Body: unknown }>(
    '/api/layouts/:layoutId/locos/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = locoUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid loco payload', details: parsed.error.flatten() });
      }
      const updated = await repo.updateLoco(req.params.id, parsed.data);
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

  /**
   * B8's standard stop (#6): the full braking ramp from the loco's current
   * commanded speed, with no destination and no overrun expectation. This is
   * the fixed, reproducible stimulus the calibration procedure in
   * docs/braking.md B8 measures a `brakingFactor` against — run it, measure
   * the distance with a ruler, invert the formula.
   *
   * `:address` is the **DCC address**, not the roster row id the CRUD routes
   * above take: braking is a runtime action against a train on the track, and
   * every other driving surface in the system is addressed the same way.
   *
   * Not admin-gated, deliberately — editing the roster is config authoring,
   * but stopping a moving train is driving, and `operator` may drive (the
   * same split the POST above documents). A refusal is a 409 carrying the
   * structured `reason` beside its rendered text; the layout keeps running,
   * because refusing to start a ramp is not itself a hazard.
   */
  fastify.post<{ Params: { layoutId: string; address: string } }>(
    '/api/layouts/:layoutId/locos/:address/brake',
    async (req, reply) => {
      if (req.params.layoutId !== layoutService.getLayoutId()) {
        return reply.status(404).send({
          error: `Layout ${layoutLabel(req.params.layoutId, layoutService.getNames())} is not the running layout`,
        });
      }

      const address = Number(req.params.address);
      if (!Number.isInteger(address)) {
        return reply.status(400).send({ error: `Invalid loco address: ${req.params.address}` });
      }

      const outcome = await layoutService.startStandardStop(address);
      if (!outcome.started) {
        return reply.status(409).send({
          // Rendered at the transport edge (D9, docs/naming.md) — this body
          // is neither persisted nor published.
          error: describeBrakingRefusal(outcome.reason, layoutService.getNames()),
          reason: outcome.reason,
        });
      }
      return reply.status(200).send({ schedule: outcome.schedule });
    },
  );

  /**
   * Every train currently under automation (#7 PR C, `docs/automation.md`).
   *
   * Authenticated, any role, and a pure read — the same posture as
   * `GET .../braking-faults` below. It gates nothing and can Safe-Stop nothing;
   * the WebSocket's `AUTOMATION_STATE` is the live channel and this is the one
   * an operator's first page load uses before any event has been published.
   *
   * Deliberately **not** on the MQTT `system/status` payload, which is binding
   * (`docs/mqtt-contract.md`) — the same call #103 made about compile
   * staleness. The ESP firmware has no use for a phase machine, and widening a
   * contract the firmware is built against to carry one would be a change
   * nobody asked for.
   */
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/automation',
    async (req, reply) => {
      if (req.params.layoutId !== layoutService.getLayoutId()) {
        return reply.status(404).send({
          error: `Layout ${layoutLabel(req.params.layoutId, layoutService.getNames())} is not the running layout`,
        });
      }
      return { runs: layoutService.getAutomationRuns() };
    },
  );

  // Authenticated, any role — a read, mirroring GET .../route-faults.
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/braking-faults',
    async (req, reply) => {
      if (req.params.layoutId !== layoutService.getLayoutId()) {
        return reply.status(404).send({
          error: `Layout ${layoutLabel(req.params.layoutId, layoutService.getNames())} is not the running layout`,
        });
      }
      return { faults: layoutService.getBrakingFaults() };
    },
  );

  /**
   * Clears a latched braking fault (B10), releasing the Safe-Stop it holds.
   *
   * No `preHandler`, exactly like the sensor- and route-fault acknowledges it
   * mirrors: authenticated by the global hook, but any role, since this is a
   * driving-adjacent recovery action. 404 when no such fault is latched —
   * there is no "not armed" case, because unlike a sensor a loco cannot prove
   * itself (B10).
   */
  fastify.post<{ Params: { layoutId: string; address: string } }>(
    '/api/layouts/:layoutId/locos/:address/acknowledge-fault',
    async (req, reply) => {
      const address = Number(req.params.address);
      if (!Number.isInteger(address)) {
        return reply.status(400).send({ error: `Invalid loco address: ${req.params.address}` });
      }

      try {
        const result = await layoutService.acknowledgeBrakingFault(req.params.layoutId, address);
        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof LocoNotFaultedError) {
          return reply.status(404).send({ error: err.message, locoAddress: err.locoAddress });
        }
        throw err;
      }
    },
  );
}
