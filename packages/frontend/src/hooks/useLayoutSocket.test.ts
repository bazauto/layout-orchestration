/**
 * useLayoutSocket
 *
 * The priority hook for issue #8: this is the path by which operators see
 * live layout state, so a silent failure here means the mimic diagram goes
 * stale without anyone noticing. Uses `MockWebSocket` (src/test/mockWebSocket.ts)
 * — see that file's comment for why it is not shared with tests/e2e/helpers.ts
 * — and fake timers, since the hook's reconnect path is driven by `setTimeout`.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMockWebSocket, MockWebSocket, restoreWebSocket } from '../test/mockWebSocket';
import { useLayoutSocket } from './useLayoutSocket';
import { RouteFaultView, RouteReservation, SensorFaultView } from '../types';

function currentSocket(): MockWebSocket {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!ws) throw new Error('no MockWebSocket constructed');
  return ws;
}

const SENSOR_FAULT: SensorFaultView = {
  sensorId: 'sensor-1',
  reason: 'stuck',
  topic: 'layout/sensors/sensor-1',
  faultedAt: '2026-08-08T00:00:00.000Z',
  consecutiveValidReadings: 0,
  requiredValidReadings: 3,
  armed: false,
};

const SENSOR_FAULT_2: SensorFaultView = {
  ...SENSOR_FAULT,
  sensorId: 'sensor-2',
};

const ROUTE_FAULT: RouteFaultView = {
  routeId: 'route-1',
  kind: 'unexpected-occupancy',
  reason: 'train where it should not be',
  blockId: 'block-1',
  locoAddress: 3,
  faultedAt: '2026-08-08T00:00:00.000Z',
};

const ROUTE_FAULT_2: RouteFaultView = {
  ...ROUTE_FAULT,
  routeId: 'route-2',
};

const ROUTE: RouteReservation = {
  id: 'route-1',
  layoutId: 'layout-1',
  locoAddress: 3,
  authority: 'manual',
  status: 'active',
  path: [],
  holds: [],
  confirmedIndex: 0,
  reason: null,
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
};

beforeEach(() => {
  installMockWebSocket();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  restoreWebSocket();
});

describe('useLayoutSocket', () => {
  describe('connection lifecycle', () => {
    it('starts connecting with the initial (offline) snapshot', () => {
      const { result } = renderHook(() => useLayoutSocket());

      expect(result.current.connectionState).toBe('connecting');
      expect(result.current.snapshot.systemStatus).toBe('offline');
      expect(result.current.snapshot.blocks).toEqual({});
      expect(result.current.snapshot.points).toEqual({});
      expect(result.current.snapshot.locos).toEqual({});
      expect(result.current.snapshot.routes).toEqual({});
      expect(result.current.snapshot.sensorFaults).toEqual([]);
      expect(result.current.snapshot.routeFaults).toEqual([]);
    });

    it('transitions to connected once the socket opens', () => {
      const { result } = renderHook(() => useLayoutSocket());

      act(() => {
        currentSocket().open();
      });

      expect(result.current.connectionState).toBe('connected');
    });

    it('connects to ws://<hostname>:3000/ws', () => {
      renderHook(() => useLayoutSocket());

      expect(currentSocket().url).toBe(`ws://${window.location.hostname}:3000/ws`);
    });

    it('unmount closes the socket and does not schedule a reconnect', () => {
      const { unmount } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();
      const closeSpy = vi.spyOn(ws, 'close');

      unmount();

      expect(closeSpy).toHaveBeenCalled();
      expect(MockWebSocket.instances).toHaveLength(1);

      // Advancing well past the base reconnect delay must not construct a
      // second socket — the hook must not reconnect after it has unmounted.
      act(() => {
        vi.advanceTimersByTime(30000);
      });

      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  describe('message dispatch', () => {
    it('STATE_SNAPSHOT replaces the whole snapshot', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
        ws.emit({
          type: 'STATE_SNAPSHOT',
          payload: {
            systemStatus: 'online',
            systemMode: 'auto',
            safeStopReason: null,
            blocks: { 'block-1': { blockId: 'block-1', occupancy: 'clear', locoAddress: null, lockedByRoute: null, lastUpdated: 'x' } },
            points: {},
            locos: {},
            routes: {},
            sensorFaults: [SENSOR_FAULT],
            routeFaults: [ROUTE_FAULT],
          },
        });
      });

      expect(result.current.snapshot.systemStatus).toBe('online');
      expect(result.current.snapshot.systemMode).toBe('auto');
      expect(result.current.snapshot.blocks).toHaveProperty('block-1');
      expect(result.current.snapshot.sensorFaults).toEqual([SENSOR_FAULT]);
      expect(result.current.snapshot.routeFaults).toEqual([ROUTE_FAULT]);
    });

    it('BLOCK_STATE merges one entry by blockId and leaves the others intact', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
        ws.emit({
          type: 'BLOCK_STATE',
          payload: { blockId: 'block-1', occupancy: 'clear', locoAddress: null, lockedByRoute: null, lastUpdated: 't1' },
        });
      });
      act(() => {
        ws.emit({
          type: 'BLOCK_STATE',
          payload: { blockId: 'block-2', occupancy: 'occupied', locoAddress: 3, lockedByRoute: null, lastUpdated: 't2' },
        });
      });

      expect(result.current.snapshot.blocks['block-1']).toEqual({
        blockId: 'block-1',
        occupancy: 'clear',
        locoAddress: null,
        lockedByRoute: null,
        lastUpdated: 't1',
      });
      expect(result.current.snapshot.blocks['block-2']).toEqual({
        blockId: 'block-2',
        occupancy: 'occupied',
        locoAddress: 3,
        lockedByRoute: null,
        lastUpdated: 't2',
      });
    });

    it('POINT_STATE merges one entry by pointId and leaves the others intact', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
        ws.emit({
          type: 'POINT_STATE',
          payload: { pointId: 'point-1', position: 'normal', locked: false, lockedByRoute: null, lastUpdated: 't1' },
        });
      });
      act(() => {
        ws.emit({
          type: 'POINT_STATE',
          payload: { pointId: 'point-2', position: 'reverse', locked: true, lockedByRoute: 'route-1', lastUpdated: 't2' },
        });
      });

      expect(result.current.snapshot.points['point-1']).toEqual({
        pointId: 'point-1',
        position: 'normal',
        locked: false,
        lockedByRoute: null,
        lastUpdated: 't1',
      });
      expect(result.current.snapshot.points['point-2']).toEqual({
        pointId: 'point-2',
        position: 'reverse',
        locked: true,
        lockedByRoute: 'route-1',
        lastUpdated: 't2',
      });
    });

    it('LOCO_STATE merges by address', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
        ws.emit({
          type: 'LOCO_STATE',
          payload: { address: 3, speed: 50, direction: 'fwd', functions: {}, authority: 'manual', lastUpdated: 't1' },
        });
      });
      act(() => {
        ws.emit({
          type: 'LOCO_STATE',
          payload: { address: 4, speed: 0, direction: 'stop', functions: {}, authority: 'auto', lastUpdated: 't2' },
        });
      });

      expect(result.current.snapshot.locos[3]).toEqual({
        address: 3,
        speed: 50,
        direction: 'fwd',
        functions: {},
        authority: 'manual',
        lastUpdated: 't1',
      });
      expect(result.current.snapshot.locos[4]).toEqual({
        address: 4,
        speed: 0,
        direction: 'stop',
        functions: {},
        authority: 'auto',
        lastUpdated: 't2',
      });
    });

    it('SYSTEM_STATUS sets status, mode, and safeStopReason together', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
        ws.emit({
          type: 'SYSTEM_STATUS',
          payload: { status: 'safe-stop', mode: 'manual', reason: 'MQTT disconnected' },
        });
      });

      expect(result.current.snapshot.systemStatus).toBe('safe-stop');
      expect(result.current.snapshot.systemMode).toBe('manual');
      expect(result.current.snapshot.safeStopReason).toBe('MQTT disconnected');
    });

    it('SENSOR_FAULTS replaces the list wholesale, not a merge', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
        ws.emit({ type: 'SENSOR_FAULTS', payload: { faults: [SENSOR_FAULT, SENSOR_FAULT_2] } });
      });
      expect(result.current.snapshot.sensorFaults).toHaveLength(2);

      act(() => {
        ws.emit({ type: 'SENSOR_FAULTS', payload: { faults: [SENSOR_FAULT] } });
      });

      // The complete current set, never a delta — the second frame's single
      // fault must fully replace the first frame's two, not merge with them.
      expect(result.current.snapshot.sensorFaults).toEqual([SENSOR_FAULT]);
    });

    it('ROUTE_FAULTS replaces the list wholesale, not a merge', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
        ws.emit({ type: 'ROUTE_FAULTS', payload: { faults: [ROUTE_FAULT, ROUTE_FAULT_2] } });
      });
      expect(result.current.snapshot.routeFaults).toHaveLength(2);

      act(() => {
        ws.emit({ type: 'ROUTE_FAULTS', payload: { faults: [ROUTE_FAULT] } });
      });

      expect(result.current.snapshot.routeFaults).toEqual([ROUTE_FAULT]);
    });

    it('ROUTE_STATE merges by id and keeps a route at a terminal status, unlike the fault lists', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
        ws.emit({ type: 'ROUTE_STATE', payload: ROUTE });
      });
      expect(result.current.snapshot.routes['route-1'].status).toBe('active');

      const cancelled: RouteReservation = { ...ROUTE, status: 'cancelled', reason: 'operator cancelled' };
      act(() => {
        ws.emit({ type: 'ROUTE_STATE', payload: cancelled });
      });

      // Deliberate asymmetry with SENSOR_FAULTS/ROUTE_FAULTS: a terminal-status
      // route is a delta that stays in the map so the panel can show what
      // happened to it, rather than a wholesale replacement of "current" routes.
      expect(result.current.snapshot.routes['route-1']).toEqual(cancelled);
      expect(Object.keys(result.current.snapshot.routes)).toEqual(['route-1']);
    });

    it('ignores a malformed (non-JSON) frame without throwing and without changing the snapshot', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
      });
      const before = result.current.snapshot;

      expect(() => {
        act(() => {
          ws.emitRaw('not json{{{');
        });
      }).not.toThrow();

      expect(result.current.snapshot).toBe(before);
    });

    it('ignores an unknown message type', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
      });
      const before = result.current.snapshot;

      act(() => {
        ws.emit({ type: 'SOMETHING_UNKNOWN', payload: {} });
      });

      expect(result.current.snapshot).toBe(before);
    });
  });

  describe('reconnection', () => {
    it('on server close, connectionState is disconnected and systemStatus becomes offline', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
        ws.emit({ type: 'SYSTEM_STATUS', payload: { status: 'online', mode: 'manual', reason: null } });
      });
      expect(result.current.snapshot.systemStatus).toBe('online');

      act(() => {
        ws.serverClose();
      });

      expect(result.current.connectionState).toBe('disconnected');
      expect(result.current.snapshot.systemStatus).toBe('offline');
    });

    it('latched faults survive a drop — the single most important assertion in this file', () => {
      // Pins the comment at useLayoutSocket.ts:84-90: a sensor fault (#34) or
      // route fault (#4) is latched on the backend, not on this connection,
      // so dropping the socket must not show the operator an all-clear that
      // isn't true.
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
        ws.emit({
          type: 'STATE_SNAPSHOT',
          payload: {
            systemStatus: 'online',
            systemMode: 'manual',
            safeStopReason: null,
            blocks: {},
            points: {},
            locos: {},
            routes: {},
            sensorFaults: [SENSOR_FAULT],
            routeFaults: [ROUTE_FAULT],
          },
        });
      });

      act(() => {
        ws.serverClose();
      });

      expect(result.current.snapshot.systemStatus).toBe('offline');
      expect(result.current.snapshot.sensorFaults).toEqual([SENSOR_FAULT]);
      expect(result.current.snapshot.routeFaults).toEqual([ROUTE_FAULT]);
    });

    it('constructs a new socket after 1000ms, not before', () => {
      renderHook(() => useLayoutSocket());
      act(() => {
        currentSocket().serverClose();
      });
      expect(MockWebSocket.instances).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(MockWebSocket.instances).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(MockWebSocket.instances).toHaveLength(2);
    });

    it('backoff doubles across successive failures and caps at 30000ms', () => {
      renderHook(() => useLayoutSocket());

      // 1st drop: reconnects after 1000ms.
      act(() => {
        currentSocket().serverClose();
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockWebSocket.instances).toHaveLength(2);

      // 2nd drop (without a successful open in between): 2000ms.
      act(() => {
        currentSocket().serverClose();
      });
      act(() => {
        vi.advanceTimersByTime(1999);
      });
      expect(MockWebSocket.instances).toHaveLength(2);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(MockWebSocket.instances).toHaveLength(3);

      // 3rd drop: 4000ms.
      act(() => {
        currentSocket().serverClose();
      });
      act(() => {
        vi.advanceTimersByTime(3999);
      });
      expect(MockWebSocket.instances).toHaveLength(3);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(MockWebSocket.instances).toHaveLength(4);

      // Keep dropping without ever opening: 8000, 16000, then capped at 30000
      // rather than 32000.
      act(() => {
        currentSocket().serverClose();
      });
      act(() => {
        vi.advanceTimersByTime(8000);
      });
      expect(MockWebSocket.instances).toHaveLength(5);

      act(() => {
        currentSocket().serverClose();
      });
      act(() => {
        vi.advanceTimersByTime(16000);
      });
      expect(MockWebSocket.instances).toHaveLength(6);

      act(() => {
        currentSocket().serverClose();
      });
      act(() => {
        vi.advanceTimersByTime(29999);
      });
      expect(MockWebSocket.instances).toHaveLength(6);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(MockWebSocket.instances).toHaveLength(7);
    });

    it('a successful open resets the backoff to 1000ms for the next drop', () => {
      renderHook(() => useLayoutSocket());

      // Drop once and let backoff grow to 2000ms for the *next* drop.
      act(() => {
        currentSocket().serverClose();
      });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockWebSocket.instances).toHaveLength(2);

      // Open successfully — this must reset the backoff.
      act(() => {
        currentSocket().open();
      });

      // Drop again: if the backoff had NOT reset it would now be 2000ms;
      // proves it reset to 1000ms instead.
      act(() => {
        currentSocket().serverClose();
      });
      act(() => {
        vi.advanceTimersByTime(999);
      });
      expect(MockWebSocket.instances).toHaveLength(2);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(MockWebSocket.instances).toHaveLength(3);
    });

    it('onerror closes the socket, which drives the reconnect path', () => {
      renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.fail();
      });

      expect(ws.readyState).toBe(MockWebSocket.CLOSED);

      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(MockWebSocket.instances).toHaveLength(2);
    });
  });

  describe('send', () => {
    it('writes the JSON-stringified message to the open socket while connected', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      act(() => {
        ws.open();
      });

      act(() => {
        result.current.send({ type: 'EMERGENCY_STOP' });
      });

      expect(ws.sent).toEqual([JSON.stringify({ type: 'EMERGENCY_STOP' })]);
    });

    it('is a no-op and does not throw while not open', () => {
      const { result } = renderHook(() => useLayoutSocket());
      const ws = currentSocket();

      expect(() => {
        act(() => {
          result.current.send({ type: 'EMERGENCY_STOP' });
        });
      }).not.toThrow();

      expect(ws.sent).toEqual([]);
    });
  });
});
