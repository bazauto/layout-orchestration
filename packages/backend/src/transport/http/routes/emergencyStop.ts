import { FastifyInstance } from 'fastify';
import { LayoutService } from '../../../services/LayoutService';

/**
 * `POST /api/emergency-stop` — deliberately unauthenticated (see the
 * exemption list in transport/http/auth/hook.ts and docs/auth.md).
 *
 * The same `ClientMessage`-based `EMERGENCY_STOP` remains available over an
 * authenticated WebSocket connection (transport/websocket/index.ts) — this
 * route exists so the layout can be halted even without a live authenticated
 * session, since the WebSocket upgrade itself now requires one. A thin
 * wrapper only: the actual stop logic lives in
 * `LayoutService.handleEmergencyStop`.
 */
export async function emergencyStopRoutes(
  fastify: FastifyInstance,
  layoutService: LayoutService,
): Promise<void> {
  fastify.post('/api/emergency-stop', async (_req, reply) => {
    await layoutService.handleEmergencyStop();
    return reply.status(200).send({ ok: true });
  });
}
