import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';
import {
  LayoutService,
  SensorFaultNotArmedError,
  SensorNotFaultedError,
  SensorNotFoundError,
} from '../../../services/LayoutService';
import { sensorCreateSchema, sensorUpdateSchema } from '../../../services/validation';
import { layoutLabel } from '../../../domain/naming';
import { requireAdmin } from '../auth/hook';

export async function sensorRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
  layoutService: LayoutService,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/sensors',
    async (req) => {
      return repo.listSensors(req.params.layoutId);
    },
  );

  // Config — admin-only. Parses and delegates to LayoutService, which owns
  // re-syncing the MQTT subscription / sensor registry / fault state to
  // match the persisted change (safety rule 2 — see docs/sensor-fault-recovery.md DD12).
  fastify.post<{ Params: { layoutId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/sensors',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = sensorCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid sensor payload', details: parsed.error.flatten() });
      }
      const sensor = await layoutService.createSensorConfig(req.params.layoutId, parsed.data);
      return reply.status(201).send(sensor);
    },
  );

  fastify.put<{ Params: { layoutId: string; id: string }; Body: unknown }>(
    '/api/layouts/:layoutId/sensors/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = sensorUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid sensor payload', details: parsed.error.flatten() });
      }
      try {
        const updated = await layoutService.updateSensorConfig(
          req.params.layoutId,
          req.params.id,
          parsed.data,
        );
        return reply.status(200).send(updated);
      } catch (err) {
        if (err instanceof SensorNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  fastify.delete<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/sensors/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        await layoutService.deleteSensorConfig(req.params.layoutId, req.params.id);
        return reply.status(204).send();
      } catch (err) {
        if (err instanceof SensorNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  /**
   * Deliberately NO `preHandler` here (D5, docs/sensor-fault-recovery.md):
   * still authenticated — the global onRequest hook (auth/hook.ts) applies
   * to every route including this one — but any role, operator included,
   * may acknowledge. The mirror image of `POST /api/emergency-stop`'s
   * deliberate lack of auth: that route is unauthenticated because it can
   * only move the system in the fail-safe direction, whereas this one moves
   * the system OUT of Safe-Stop and so DOES require a session — just not an
   * admin one, since it is a transient, driving-adjacent action refused
   * outright unless the fault has already armed (D1).
   */
  fastify.post<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/sensors/:id/acknowledge-fault',
    async (req, reply) => {
      try {
        const result = await layoutService.acknowledgeSensorFault(req.params.layoutId, req.params.id);
        return reply.status(200).send(result);
      } catch (err) {
        if (err instanceof SensorNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        if (err instanceof SensorNotFaultedError) {
          return reply.status(409).send({ error: err.message, sensorId: err.sensorId });
        }
        if (err instanceof SensorFaultNotArmedError) {
          return reply.status(409).send({
            error: err.message,
            sensorId: err.sensorId,
            consecutiveValidReadings: err.consecutiveValidReadings,
            requiredValidReadings: err.requiredValidReadings,
            outstanding: err.outstanding,
          });
        }
        throw err;
      }
    },
  );

  // Authenticated, any role — a read, like GET .../sensors above.
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/sensor-faults',
    async (req, reply) => {
      if (req.params.layoutId !== layoutService.getLayoutId()) {
        return reply.status(404).send({
          error: `Layout ${layoutLabel(req.params.layoutId, layoutService.getNames())} is not the running layout`,
        });
      }
      return { faults: layoutService.getSensorFaults() };
    },
  );
}
