import { FastifyInstance } from 'fastify';
import {
  SensorSimulationService,
  SensorOutOfServiceError,
  LayoutNotRunningError,
} from '../../../services/SensorSimulationService';
import { SensorNotFoundError } from '../../../services/LayoutService';
import { simulateReadingSchema } from '../../../services/validation';

/**
 * `POST /api/layouts/:layoutId/sensors/:sensorId/simulate-reading` (#65 R5).
 *
 * A thin parse-and-delegate, per safety rule 2 and D13 — every decision
 * (layout/sensor lookup, in-service check, what bytes to publish, logging)
 * lives in `SensorSimulationService.inject`. Only mounted when the service
 * exists (`server.ts`), which is itself gated by `SENSOR_SIMULATION` (D2).
 *
 * The request body is strictly validated by `simulateReadingSchema` even
 * though the `malformed` action's PUBLISHED bytes are deliberately invalid —
 * that is a different boundary from this one. See the schema's own doc
 * comment in `services/validation.ts`.
 */
export async function sensorSimulationRoutes(
  fastify: FastifyInstance,
  service: SensorSimulationService,
): Promise<void> {
  fastify.post<{ Params: { layoutId: string; sensorId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/sensors/:sensorId/simulate-reading',
    async (req, reply) => {
      const parsed = simulateReadingSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid simulate-reading payload', details: parsed.error.flatten() });
      }

      try {
        const injection = await service.inject(req.params.layoutId, req.params.sensorId, parsed.data, {
          username: req.user!.username,
        });
        return reply.status(202).send({
          sensorId: injection.sensorId,
          sensorName: injection.sensorName,
          topic: injection.topic,
          action: injection.action,
          payload: injection.payload,
          retain: injection.retain,
          publishedAt: injection.publishedAt.toISOString(),
        });
      } catch (err) {
        if (err instanceof LayoutNotRunningError || err instanceof SensorNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        if (err instanceof SensorOutOfServiceError) {
          return reply.status(409).send({ error: err.message, sensorId: err.sensorId });
        }
        throw err;
      }
    },
  );
}
