/**
 * Fastify server factory.
 * Registers all plugins and routes. Returns the configured Fastify instance.
 */

import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebSocket from '@fastify/websocket';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { LayoutService } from '../../services/LayoutService';
import { TopologyService } from '../../services/TopologyService';
import { AuthService } from '../../services/AuthService';
import { SensorSimulationService } from '../../services/SensorSimulationService';
import { INERT_NAME_BOOK } from '../../services/nameBook';
import { ILayoutRepository } from '../../ports/ILayoutRepository';
import { INameBook } from '../../ports/INameBook';
import { layoutRoutes } from './routes/layouts';
import { locoRoutes } from './routes/locos';
import { pointRoutes } from './routes/points';
import { blockRoutes } from './routes/blocks';
import { sensorRoutes } from './routes/sensors';
import { gridRoutes } from './routes/grid';
import { GridService } from '../../services/GridService';
import { CompileService } from '../../services/CompileService';
import { edgeRoutes } from './routes/edges';
import { topologyRoutes } from './routes/topology';
import { routeRoutes } from './routes/routes';
import { authRoutes } from './routes/auth';
import { userRoutes } from './routes/users';
import { emergencyStopRoutes } from './routes/emergencyStop';
import { dccLinkRoutes } from './routes/dccLink';
import { capabilityRoutes } from './routes/capabilities';
import { sensorSimulationRoutes } from './routes/sensorSimulation';
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
  nameBook: INameBook = INERT_NAME_BOOK,
  // #65 D2/R3: undefined in every mode except SENSOR_SIMULATION=true. The
  // six existing call sites below this parameter (every test file building
  // a server) keep compiling unchanged and all report `sensorSimulation:
  // false` — the capability is literally "the service exists in this
  // process".
  sensorSimulation?: SensorSimulationService,
  // #103: supplied by `index.ts` so the process has exactly one compiler — the
  // same instance `LayoutService` reads its gap count through. Constructed here
  // when absent, which is every test that does not care.
  compileService: CompileService = new CompileService(repo, topologyService),
  // #143: path to the built SPA (`packages/frontend/dist`), or undefined to
  // serve no static files at all — which is development, and every test that
  // does not specifically cover this.
  frontendDistPath?: string,
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

  // ── The built SPA (#143) ────────────────────────────────────────────────────
  //
  // A deployment serves the operator UI from this process, on this port, so
  // every browser request is same-origin — which is what takes CORS and the
  // cross-site cookie question out of a real deployment entirely.
  //
  // These files must be reachable WITHOUT a session: one of them is the login
  // screen, and a 401 on index.html is a deployment nobody can log into.
  // Registering the plugin before the auth hook is not enough to achieve that
  // — `@fastify/static` registers inside its own encapsulation context, which
  // inherits the root's onRequest hooks whenever they were added — so the
  // exemption is explicit, via the predicate handed to `registerAuthHook`
  // below. Serving the bundle anonymously gives nothing away: it is the same
  // compiled JavaScript that is public in this repository and it carries no
  // layout data. Every byte of layout state still arrives over /api or /ws.
  //
  // `wildcard: false` because the SPA has no client-side router — `/` is the
  // only HTML path there is. If routing is ever added, deep links will 401 and
  // the fix is a history-API fallback that has to answer for the auth hook
  // too, not just for the router.
  if (frontendDistPath) {
    await fastify.register(fastifyStatic, { root: frontendDistPath, wildcard: false });
  }

  // Exactly what `vite build` emits for this app: `index.html` plus hashed
  // files under `build.assetsDir` (default `assets/`), and nothing else — the
  // frontend workspace has no `public/` directory. Deny-by-default on purpose:
  // adding one later means adding it here, and the symptom is an obvious 401
  // in the browser rather than a route quietly becoming anonymous.
  const isPublicSpaPath = frontendDistPath
    ? (path: string) => path === '/' || path === '/index.html' || path.startsWith('/assets/')
    : undefined;

  // Registered before ANY route (including /health and the login route
  // themselves) — Fastify hooks only apply to routes declared after the
  // hook, on the same encapsulation context. See auth/hook.ts for the
  // exemption list and the WebSocket-upgrade rationale.
  registerAuthHook(
    fastify,
    authService,
    authConfig.cookieName,
    authConfig.cookieSecure,
    isPublicSpaPath,
  );

  // Health check (exempt from auth)
  fastify.get('/health', async () => {
    const status = layoutService.getSystemStatus();
    return { ok: true, ...status };
  });

  await authRoutes(fastify, authService, authConfig.cookieName, authConfig.cookieSecure);
  await userRoutes(fastify, authService);
  await emergencyStopRoutes(fastify, layoutService);

  // REST API routes
  await layoutRoutes(fastify, repo);
  await locoRoutes(fastify, repo, nameBook, layoutService);
  await blockRoutes(fastify, repo, topologyService, nameBook);
  await pointRoutes(fastify, repo, topologyService, nameBook, layoutService);
  await sensorRoutes(fastify, repo, layoutService);
  await dccLinkRoutes(fastify, layoutService);
  // #70: constructed here rather than plumbed in from `index.ts` because it
  // holds no state and depends on nothing but the repository — the same
  // reason `layoutRoutes` still takes `repo` directly. It exists so the
  // referential checks a Zod schema cannot express live in a service rather
  // than in the route callback.
  await gridRoutes(fastify, new GridService(repo), compileService);
  await edgeRoutes(fastify, topologyService);
  await topologyRoutes(fastify, layoutService, topologyService, compileService);
  await routeRoutes(fastify, layoutService);
  await capabilityRoutes(fastify, { sensorSimulation: sensorSimulation !== undefined });
  // D2: mounted only when the flag constructed the service — an absent
  // route (404), never a route that exists but refuses (403/409).
  if (sensorSimulation) {
    await sensorSimulationRoutes(fastify, sensorSimulation);
  }

  // WebSocket — the upgrade itself is gated by the onRequest hook above;
  // no auth logic lives in the WS transport handler.
  await registerWebSocket(fastify, layoutService);

  return fastify;
}
