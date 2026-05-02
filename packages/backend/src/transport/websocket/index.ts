/**
 * WebSocket transport handler.
 *
 * - Registers a /ws endpoint on the Fastify instance.
 * - Forwards LayoutEvents from LayoutService to all connected clients.
 * - Accepts ClientMessages from connected clients and dispatches to LayoutService.
 */

import { FastifyInstance } from 'fastify';
import { WebSocket } from '@fastify/websocket';
import { LayoutService } from '../../services/LayoutService';
import { LayoutEvent } from '../../domain/types';
import { clientMessageSchema } from '../../services/validation';

export async function registerWebSocket(
  fastify: FastifyInstance,
  layoutService: LayoutService,
): Promise<void> {
  const clients = new Set<WebSocket>();

  // Forward every LayoutEvent to all connected WebSocket clients
  layoutService.on('event', (event: LayoutEvent) => {
    const serialized = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  });

  fastify.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    fastify.log.info({ total: clients.size }, '[WS] Client connected');

    // Send current full state snapshot on connect
    const state = layoutService.getAllState();
    const snapshot = {
      type: 'STATE_SNAPSHOT',
      payload: {
        systemStatus: state.systemStatus,
        systemMode: state.systemMode,
        safeStopReason: state.safeStopReason,
        blocks: Object.fromEntries(state.blocks),
        points: Object.fromEntries(state.points),
        locos: Object.fromEntries(state.locos),
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
