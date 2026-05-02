/**
 * Fastify server factory.
 * Registers all plugins and routes. Returns the configured Fastify instance.
 */

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import { LayoutService } from '../../services/LayoutService';
import { ILayoutRepository } from '../../ports/ILayoutRepository';
import { layoutRoutes } from './routes/layouts';
import { locoRoutes } from './routes/locos';
import { pointRoutes } from './routes/points';
import { blockRoutes } from './routes/blocks';
import { sensorRoutes } from './routes/sensors';
import { gridRoutes } from './routes/grid';
import { registerWebSocket } from '../websocket/index';

export async function buildServer(
  layoutService: LayoutService,
  repo: ILayoutRepository,
  logLevel: string,
) {
  const fastify = Fastify({ logger: { level: logLevel } });

  await fastify.register(fastifyCors, { origin: true });
  await fastify.register(fastifyWebSocket);

  // Health check
  fastify.get('/health', async () => {
    const status = layoutService.getSystemStatus();
    return { ok: true, ...status };
  });

  // REST API routes
  await layoutRoutes(fastify, repo);
  await locoRoutes(fastify, repo);
  await blockRoutes(fastify, repo);
  await pointRoutes(fastify, repo);
  await sensorRoutes(fastify, repo);
  await gridRoutes(fastify, repo);

  // WebSocket
  await registerWebSocket(fastify, layoutService);

  return fastify;
}
