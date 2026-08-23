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
  routes: {},
  sensorFaults: [],
  pointFaults: [],
  routeFaults: [],
  brakingFaults: [],
  // #148: `responsive: true` before the first snapshot arrives, deliberately —
  // this is the pre-connection placeholder, and the browser already shows
  // `systemStatus: 'offline'` for that. A `false` here would render "the command
  // station is not answering" on every page load, before anything has asked it.
  dccLink: {
    responsive: true,
    reason: null,
    fault: null,
    mainPowerOn: null,
    progPowerOn: null,
    identity: null,
    restartCount: 0,
    lastResponseAt: null,
  },
  automationRuns: [],
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
  /**
   * When this client last heard *anything* from the server (#82).
   *
   * Every inbound frame counts, not just `HEARTBEAT`: a layout busy enough to
   * be emitting state changes is self-evidently live, and requiring a
   * heartbeat specifically would report a stale connection on a socket
   * delivering events. The heartbeat exists to cover the *quiet* case, which
   * is the one a mimic cannot otherwise distinguish from a frozen socket.
   *
   * `null` until the first frame arrives — distinct from "a long time ago",
   * because a connection that has not yet delivered its opening
   * `STATE_SNAPSHOT` has nothing on screen to have gone stale.
   */
  const [lastMessageAt, setLastMessageAt] = useState<number | null>(null);
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
        // Deliberately does NOT stamp liveness: a frame this client cannot
        // parse proves the socket is open, not that the two ends still agree
        // about what is on it. Treating it as a sign of life would be the
        // display reassuring itself.
        return;
      }

      setLastMessageAt(Date.now());
      setSnapshot((prev) => applyMessage(prev, msg));
    };

    ws.onclose = () => {
      if (unmounted.current) return;
      setConnectionState('disconnected');
      // Liveness restarts from nothing on a drop. Carrying the old stamp over
      // would let a reconnect that has not yet delivered its snapshot read as
      // `live` for up to one stale-window, showing pre-drop state as current.
      setLastMessageAt(null);
      // Deliberately spread `s` rather than reset to INITIAL_SNAPSHOT: a
      // sensor fault (#34), point fault (#25), route fault (#4), or braking
      // fault (#6) is latched on the backend, not on this connection, so a
      // drop must not clear those lists — that would show the operator an
      // all-clear that isn't true. A reconnect's STATE_SNAPSHOT replaces all
      // four with the authoritative current sets.
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

  return { snapshot, connectionState, lastMessageAt, send };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function applyMessage(prev: StateSnapshot, msg: ServerMessage): StateSnapshot {
  switch (msg.type) {
    case 'STATE_SNAPSHOT':
      // `automationRuns` is defaulted rather than trusted (#7 PR C). The type
      // says it is always there and the *current* backend always sends it — but
      // this is the one place a wire payload is adopted wholesale, so a browser
      // holding a cached bundle against an older backend gets `undefined` for
      // any field added since, and `RoutesPanel` would then crash mapping over
      // it. A collection arriving absent must read as empty, never as a hole.
      return { ...msg.payload, automationRuns: msg.payload.automationRuns ?? [] };

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

    case 'POINT_FAULTS':
      // Same posture as SENSOR_FAULTS above (#25).
      return { ...prev, pointFaults: msg.payload.faults };

    case 'ROUTE_STATE': {
      // Unlike the fault lists, this IS a delta: one reservation at whatever
      // status it just reached. Terminal statuses stay in the map so the
      // panel can show what happened to a route that just ended, rather than
      // having it vanish; the panel filters what it lists.
      const r = msg.payload;
      return { ...prev, routes: { ...prev.routes, [r.id]: r } };
    }

    case 'ROUTE_FAULTS':
      return { ...prev, routeFaults: msg.payload.faults };

    case 'BRAKING_FAULTS':
      // Same posture again (#6): the complete latched set, keyed per loco on
      // the backend and sent as a list.
      return { ...prev, brakingFaults: msg.payload.faults };

    case 'AUTOMATION_STATE':
      // #7 PR C: the complete set of runs, sent only when it changed. The
      // sweep ticks four times a second and is usually a no-op, so the backend
      // suppresses an unchanged payload rather than the client diffing one.
      return { ...prev, automationRuns: msg.payload.runs };

    case 'ERROR':
      // A rejected command carries no state, so there is nothing to merge —
      // but it must not vanish either. It used to fall through to `default`,
      // which is how a backend TypeError that killed every broadcast looked
      // to an operator like a control that simply did nothing: no network
      // request to inspect, no console output, no UI change. Surfacing it
      // properly (a toast on the affected control) is still open; until then
      // this at least puts it where someone with devtools open will find it.
      // eslint-disable-next-line no-console -- deliberate; the frontend has no logger, and silence here is what hid the bug
      console.warn(
        '[ws] command rejected by backend:',
        msg.payload.message,
        msg.payload.details ?? '',
      );
      return prev;

    default:
      return prev;
  }
}
