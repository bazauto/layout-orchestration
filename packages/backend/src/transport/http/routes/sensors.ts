import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';

export async function sensorRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/sensors',
    async (req) => {
      return repo.listSensors(req.params.layoutId);
    },
  );

  fastify.post<{
    Params: { layoutId: string };
    Body: {
      name: string;
      type: 'block_detection' | 'ir_position';
      blockId?: string;
      mqttTopic: string;
    };
  }>('/api/layouts/:layoutId/sensors', async (req, reply) => {
    const sensor = await repo.createSensor({
      layoutId: req.params.layoutId,
      name: req.body.name,
      type: req.body.type,
      blockId: req.body.blockId ?? null,
      mqttTopic: req.body.mqttTopic,
    });
    return reply.status(201).send(sensor);
  });

  fastify.put<{
    Params: { layoutId: string; id: string };
    Body: { name?: string; type?: 'block_detection' | 'ir_position'; blockId?: string | null; mqttTopic?: string };
  }>('/api/layouts/:layoutId/sensors/:id', async (req, reply) => {
    const updated = await repo.updateSensor(req.params.id, req.body);
    return reply.status(200).send(updated);
  });

  fastify.delete<{ Params: { layoutId: string; id: string } }>(
    '/api/layouts/:layoutId/sensors/:id',
    async (req, reply) => {
      await repo.deleteSensor(req.params.id);
      return reply.status(204).send();
    },
  );
}
