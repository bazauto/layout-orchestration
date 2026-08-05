/**
 * Fastify server factory.
 * Registers all plugins and routes. Returns the configured Fastify instance.
 */

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import { LayoutService } from '../../services/LayoutService';
import { TopologyService } from '../../services/TopologyService';
import { ILayoutRepository } from '../../ports/ILayoutRepository';
import { layoutRoutes } from './routes/layouts';
import { locoRoutes } from './routes/locos';
import { pointRoutes } from './routes/points';
import { blockRoutes } from './routes/blocks';
import { sensorRoutes } from './routes/sensors';
import { gridRoutes } from './routes/grid';
import { edgeRoutes } from './routes/edges';
import { topologyRoutes } from './routes/topology';
import { registerWebSocket } from '../websocket/index';

export async function buildServer(
  layoutService: LayoutService,
  repo: ILayoutRepository,
  logLevel: string,
  topologyService: TopologyService,
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
  await blockRoutes(fastify, repo, topologyService);
  await pointRoutes(fastify, repo, topologyService);
  await sensorRoutes(fastify, repo);
  await gridRoutes(fastify, repo);
  await edgeRoutes(fastify, topologyService);
  await topologyRoutes(fastify, layoutService, topologyService);

  // WebSocket
  await registerWebSocket(fastify, layoutService);

  return fastify;
}
