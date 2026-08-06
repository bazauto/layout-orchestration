/**
 * Fastify server factory.
 * Registers all plugins and routes. Returns the configured Fastify instance.
 */

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { LayoutService } from '../../services/LayoutService';
import { TopologyService } from '../../services/TopologyService';
import { AuthService } from '../../services/AuthService';
import { ILayoutRepository } from '../../ports/ILayoutRepository';
import { layoutRoutes } from './routes/layouts';
import { locoRoutes } from './routes/locos';
import { pointRoutes } from './routes/points';
import { blockRoutes } from './routes/blocks';
import { sensorRoutes } from './routes/sensors';
import { gridRoutes } from './routes/grid';
import { edgeRoutes } from './routes/edges';
import { topologyRoutes } from './routes/topology';
import { authRoutes } from './routes/auth';
import { emergencyStopRoutes } from './routes/emergencyStop';
import { registerAuthHook } from './auth/hook';
import { registerWebSocket } from '../websocket/index';

export interface AuthTransportConfig {
  cookieName: string;
  cookieSecure: boolean;
  corsAllowedOrigins: string[];
}

export async function buildServer(
  layoutService: LayoutService,
  repo: ILayoutRepository,
  logLevel: string,
  topologyService: TopologyService,
  authService: AuthService,
  authConfig: AuthTransportConfig,
) {
  const fastify = Fastify({ logger: { level: logLevel } });

  // Explicit allowlist + credentials:true, not `origin: true` — together
  // with the session cookie's SameSite=Lax this is what actually closes the
  // drive-by-web-page case (see docs/auth.md). Env-driven so adding an
  // `https://` origin once TLS lands is a config edit, not a code change.
  await fastify.register(fastifyCors, {
    origin: authConfig.corsAllowedOrigins,
    credentials: true,
  });
  await fastify.register(fastifyCookie);
  // global:false — rate limiting is opt-in per route (only the login route
  // uses it today), not applied to every request by default.
  await fastify.register(fastifyRateLimit, { global: false });
  await fastify.register(fastifyWebSocket);

  // Registered before ANY route (including /health and the login route
  // themselves) — Fastify hooks only apply to routes declared after the
  // hook, on the same encapsulation context. See auth/hook.ts for the
  // exemption list and the WebSocket-upgrade rationale.
  registerAuthHook(fastify, authService, authConfig.cookieName, authConfig.cookieSecure);

  // Health check (exempt from auth)
  fastify.get('/health', async () => {
    const status = layoutService.getSystemStatus();
    return { ok: true, ...status };
  });

  await authRoutes(fastify, authService, authConfig.cookieName, authConfig.cookieSecure);
  await emergencyStopRoutes(fastify, layoutService);

  // REST API routes
  await layoutRoutes(fastify, repo);
  await locoRoutes(fastify, repo);
  await blockRoutes(fastify, repo, topologyService);
  await pointRoutes(fastify, repo, topologyService);
  await sensorRoutes(fastify, repo);
  await gridRoutes(fastify, repo);
  await edgeRoutes(fastify, topologyService);
  await topologyRoutes(fastify, layoutService, topologyService);

  // WebSocket — the upgrade itself is gated by the onRequest hook above;
  // no auth logic lives in the WS transport handler.
  await registerWebSocket(fastify, layoutService);

  return fastify;
}
