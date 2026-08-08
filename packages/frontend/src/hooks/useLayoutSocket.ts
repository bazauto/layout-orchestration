/**
 * useLayoutSocket
 *
 * Manages the WebSocket connection to the backend.
 * - Reconnects automatically with exponential backoff.
 * - Merges incremental state updates into the full snapshot.
 * - Exposes a `send` function to dispatch ClientMessages.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BlockState,
  ClientMessage,
  LocoState,
  PointState,
  ServerMessage,
  StateSnapshot,
  SystemMode,
  SystemStatus,
} from '../types';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

const INITIAL_SNAPSHOT: StateSnapshot = {
  systemStatus: 'offline',
  systemMode: 'manual',
  safeStopReason: null,
  blocks: {},
  points: {},
  locos: {},
  sensorFaults: [],
};

const WS_URL =
  typeof window !== 'undefined'
    ? `ws://${window.location.hostname}:3000/ws`
    : 'ws://localhost:3000/ws';

const BASE_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

/**
 * The /ws upgrade now requires a valid session cookie (see docs/auth.md).
 * This hook is only called from `AuthenticatedApp` (App.tsx), which itself
 * only mounts once `useAuth` reports an authenticated session — so a
 * connection is never attempted before login, without this hook needing to
 * know anything about auth state itself.
 */
export function useLayoutSocket() {
  const [snapshot, setSnapshot] = useState<StateSnapshot>(INITIAL_SNAPSHOT);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelay = useRef(BASE_RECONNECT_MS);
  const unmounted = useRef(false);

  const connect = useCallback(() => {
    if (unmounted.current) return;
    setConnectionState('connecting');

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectDelay.current = BASE_RECONNECT_MS;
      setConnectionState('connected');
    };

    ws.onmessage = (evt) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(evt.data) as ServerMessage;
      } catch {
        return;
      }

      setSnapshot((prev) => applyMessage(prev, msg));
    };

    ws.onclose = () => {
      if (unmounted.current) return;
      setConnectionState('disconnected');
      // Deliberately spread `s` rather than reset to INITIAL_SNAPSHOT: a
      // sensor fault is latched on the backend, not on this connection, so a
      // drop must not clear `sensorFaults` — that would show the operator an
      // all-clear that isn't true. A reconnect's STATE_SNAPSHOT replaces the
      // list with the authoritative current set (#34).
      setSnapshot((s) => ({ ...s, systemStatus: 'offline' }));
      const delay = reconnectDelay.current;
      reconnectDelay.current = Math.min(delay * 2, MAX_RECONNECT_MS);
      setTimeout(connect, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  useEffect(() => {
    unmounted.current = false;
    connect();
    return () => {
      unmounted.current = true;
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: ClientMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { snapshot, connectionState, send };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyMessage(prev: StateSnapshot, msg: ServerMessage): StateSnapshot {
  switch (msg.type) {
    case 'STATE_SNAPSHOT':
      return msg.payload;

    case 'BLOCK_STATE': {
      const b = msg.payload as BlockState;
      return { ...prev, blocks: { ...prev.blocks, [b.blockId]: b } };
    }

    case 'POINT_STATE': {
      const p = msg.payload as PointState;
      return { ...prev, points: { ...prev.points, [p.pointId]: p } };
    }

    case 'LOCO_STATE': {
      const l = msg.payload as LocoState;
      return { ...prev, locos: { ...prev.locos, [l.address]: l } };
    }

    case 'SYSTEM_STATUS': {
      const s = msg.payload as { status: SystemStatus; mode: SystemMode; reason: string | null };
      return { ...prev, systemStatus: s.status, systemMode: s.mode, safeStopReason: s.reason };
    }

    case 'SENSOR_FAULTS':
      // Always the complete current set, never a delta — replace wholesale.
      return { ...prev, sensorFaults: msg.payload.faults };

    default:
      return prev;
  }
}
