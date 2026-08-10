import { FastifyInstance } from 'fastify';

/**
 * `GET /api/capabilities` — process-scoped, not layout-scoped, so this is
 * its own route file rather than folded into a `/api/layouts/:layoutId/`
 * resource file (#65 R3).
 *
 * Authenticated by the global `onRequest` hook, deliberately with NO
 * `requireAdmin` (#65 D3) — a capabilities read is not a config write. Always
 * mounted, in every mode: a 404 here would be exactly the thing D3 exists to
 * avoid teaching the frontend to interpret. `capabilities` is computed once
 * in `server.ts` from whether the corresponding service was constructed —
 * "the capability is literally the service existing in this process" — so
 * this file never re-derives it from a flag.
 */
export interface Capabilities {
  sensorSimulation: boolean;
}

export async function capabilityRoutes(fastify: FastifyInstance, capabilities: Capabilities): Promise<void> {
  fastify.get('/api/capabilities', async () => capabilities);
}
