/**
 * WebSocket transport handler.
 *
 * - Registers a /ws endpoint on the Fastify instance.
 * - Forwards LayoutEvents from LayoutService to all connected clients.
 * - Accepts ClientMessages from connected clients and dispatches to LayoutService.
 * - Broadcasts a periodic HEARTBEAT (#82 D5) to every connected client.
 * - Refuses a driving ClientMessage from a 'monitor' connection (#63 D2/D3).
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
// Type-only: `@fastify/websocket` v11 exports `WebSocket` as a *type alias*
// (`export type WebSocket = ws.WebSocket`) and nothing by that name at
// runtime — its only runtime exports are `default` and `fastifyWebsocket`.
// Reaching for a value on it (`WebSocket.OPEN`) therefore throws a TypeError,
// which is exactly what silently broke every broadcast below. Readiness is
// checked against the socket's own `OPEN` constant instead.
import type { WebSocket } from '@fastify/websocket';
import { LayoutService } from '../../services/LayoutService';
import { LayoutEvent, Role, ServerMessage } from '../../domain/types';
import { clientMessageSchema } from '../../services/validation';
import { HEARTBEAT_INTERVAL_MS } from '../../domain/liveness';

/**
 * `ClientMessage` kinds that move something. Everything else (today, nothing
 * — every `ClientMessage` variant either drives or is `EMERGENCY_STOP`) is
 * left unlisted rather than gated by exclusion, so a future read-only message
 * type needs no change here.
 */
const DRIVING_MESSAGE_TYPES = new Set([
  'THROTTLE_COMMAND',
  'POINT_COMMAND',
  'FUNCTION_COMMAND',
  'SET_MODE',
]);

export async function registerWebSocket(
  fastify: FastifyInstance,
  layoutService: LayoutService,
): Promise<void> {
  const clients = new Set<WebSocket>();

  // Forward every LayoutEvent to all connected WebSocket clients
  layoutService.on('event', (event: LayoutEvent) => {
    const serialized = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(serialized);
      }
    }
  });

  // #82 D5/D7: an application-level ServerMessage, not a protocol-level `ws`
  // ping — a ping is invisible to the browser WebSocket API, so a client
  // could never use it to detect staleness. `unref()` and the `onClose` hook
  // below are what stop this interval holding the process (or a test's
  // Fastify instance) open.
  const heartbeatInterval = setInterval(() => {
    const heartbeat: ServerMessage = {
      type: 'HEARTBEAT',
      payload: { serverTime: new Date().toISOString() },
    };
    const serialized = JSON.stringify(heartbeat);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(serialized);
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatInterval.unref();
  fastify.addHook('onClose', async () => {
    clearInterval(heartbeatInterval);
  });

  fastify.get('/ws', { websocket: true }, (socket, request: FastifyRequest) => {
    // #63 D2: captured once, here, at the upgrade — never re-read from
    // `request.user` inside the message handler below. `registerAuthHook`
    // (transport/http/auth/hook.ts) has already rejected an unauthenticated
    // upgrade before this handler ever runs, so `request.user` is always
    // populated here and this branch is never expected to be reached. The
    // fallback is 'monitor', not 'operator', precisely BECAUSE it should be
    // unreachable: CLAUDE.md safety rule 1 resolves uncertainty in the
    // fail-safe direction, and the least-privileged role is what makes a
    // broken invariant here cost a refused command rather than handing an
    // unidentified connection driving authority. This is what keeps auth
    // enforcement at the connection edge (docs/auth.md "Enforcement") rather
    // than adding a second, mid-connection lookup: the role a socket carries
    // for its whole lifetime is fixed the moment it opens.
    const role: Role = request.user?.role ?? 'monitor';

    clients.add(socket);
    fastify.log.info({ total: clients.size }, '[WS] Client connected');

    // Send current full state snapshot on connect
    const state = layoutService.getAllState();
    const snapshot: ServerMessage = {
      type: 'STATE_SNAPSHOT',
      payload: {
        systemStatus: state.systemStatus,
        systemMode: state.systemMode,
        safeStopReason: state.safeStopReason,
        blocks: Object.fromEntries(state.blocks),
        points: Object.fromEntries(state.points),
        locos: Object.fromEntries(state.locos),
        routes: Object.fromEntries(state.routes),
        // DD10 (docs/sensor-fault-recovery.md): only the derived fault set is
        // surfaced here. `state.sensors` (per-sensor last-reading) is
        // deliberately NOT included — it is diagnostic runtime state nothing
        // renders. Do not "complete" this snapshot with it later.
        sensorFaults: layoutService.getSensorFaults(),
        /** #25: latched point faults, same posture as `sensorFaults` above — the derived view, never the raw health object. */
        pointFaults: layoutService.getPointFaults(),
        /** #4: latched route faults, same posture as `sensorFaults` above — the derived view, never the raw health object. */
        routeFaults: layoutService.getRouteFaults(),
        /** #6: latched braking faults, same posture again — one per loco (B10). */
        brakingFaults: layoutService.getBrakingFaults(),
        /**
         * #148: the command-station link. In the snapshot rather than on an
         * event of its own because it is state, not a transition — a browser
         * opening onto a Safe-Stopped layout needs to be told the station is
         * silent, and the event that said so may have fired an hour ago.
         */
        dccLink: layoutService.getDccLink(),
        automationRuns: layoutService.getAutomationRuns(),
      },
    };
    socket.send(JSON.stringify(snapshot));

    socket.on('message', async (rawMsg) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawMsg.toString());
      } catch {
        socket.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Invalid JSON' } }));
        return;
      }

      const result = clientMessageSchema.safeParse(parsed);
      if (!result.success) {
        socket.send(
          JSON.stringify({
            type: 'ERROR',
            payload: { message: 'Invalid message', details: result.error.flatten() },
          }),
        );
        return;
      }

      const msg = result.data;

      // #63 D2/D3: an authorisation check at the transport edge, not a
      // domain decision — it refuses the message before it reaches
      // LayoutService, the same "parse, validate, delegate" shape as the Zod
      // check just above. A refusal is an ERROR reply, never a socket close
      // (D3), for the same reason auth itself is never enforced
      // mid-connection: nothing tears a socket down while a train might be
      // moving. EMERGENCY_STOP is deliberately absent from
      // DRIVING_MESSAGE_TYPES (D4) — every role, including monitor, may send it.
      if (role === 'monitor' && DRIVING_MESSAGE_TYPES.has(msg.type)) {
        socket.send(
          JSON.stringify({
            type: 'ERROR',
            payload: { message: `monitor role may not send ${msg.type}` },
          }),
        );
        return;
      }

      try {
        switch (msg.type) {
          case 'THROTTLE_COMMAND':
            await layoutService.handleThrottleCommand(msg.payload);
            break;
          case 'POINT_COMMAND':
            await layoutService.handlePointCommand(msg.payload);
            break;
          case 'FUNCTION_COMMAND':
            await layoutService.handleFunctionCommand(msg.payload);
            break;
          case 'SET_MODE':
            await layoutService.handleSetMode(msg.payload);
            break;
          case 'EMERGENCY_STOP':
            await layoutService.handleEmergencyStop();
            break;
        }
      } catch (err) {
        socket.send(
          JSON.stringify({
            type: 'ERROR',
            payload: { message: err instanceof Error ? err.message : 'Command failed' },
          }),
        );
      }
    });

    socket.on('close', () => {
      clients.delete(socket);
      fastify.log.info({ total: clients.size }, '[WS] Client disconnected');
    });
  });
}
