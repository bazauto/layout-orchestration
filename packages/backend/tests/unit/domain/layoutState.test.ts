import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutStateManager } from '../../../src/domain/layoutState';
import { RouteReservation } from '../../../src/domain/types';

describe('LayoutStateManager', () => {
  let manager: LayoutStateManager;

  beforeEach(() => {
    manager = new LayoutStateManager('test-layout');
  });

  describe('initial state', () => {
    it('starts offline', () => {
      expect(manager.getState().systemStatus).toBe('offline');
    });

    it('starts in manual mode', () => {
      expect(manager.getState().systemMode).toBe('manual');
    });

    it('has no blocks, points, or locos', () => {
      const state = manager.getState();
      expect(state.blocks.size).toBe(0);
      expect(state.points.size).toBe(0);
      expect(state.locos.size).toBe(0);
    });
  });

  describe('system status transitions', () => {
    it('transitions to online', () => {
      manager.setOnline();
      expect(manager.getState().systemStatus).toBe('online');
      expect(manager.getState().safeStopReason).toBeNull();
    });

    it('transitions to safe-stop with a reason', () => {
      manager.setOnline();
      manager.enterSafeStop('MQTT disconnected');
      expect(manager.getState().systemStatus).toBe('safe-stop');
      expect(manager.getState().safeStopReason).toBe('MQTT disconnected');
    });

    it('clears safe-stop and returns to online', () => {
      manager.setOnline();
      manager.enterSafeStop('test reason');
      manager.clearSafeStop();
      expect(manager.getState().systemStatus).toBe('online');
      expect(manager.getState().safeStopReason).toBeNull();
    });

    it('does not clear safe-stop if already online', () => {
      manager.setOnline();
      manager.clearSafeStop(); // no-op
      expect(manager.getState().systemStatus).toBe('online');
    });
  });

  describe('block management', () => {
    it('registers a block with unknown occupancy', () => {
      const block = manager.registerBlock('b1');
      expect(block.blockId).toBe('b1');
      expect(block.occupancy).toBe('unknown');
      expect(block.locoAddress).toBeNull();
    });

    it('updates block occupancy', () => {
      manager.registerBlock('b1');
      const updated = manager.updateBlockOccupancy('b1', 'occupied', 3);
      expect(updated.occupancy).toBe('occupied');
      expect(updated.locoAddress).toBe(3);
    });

    it('retains lock when updating occupancy', () => {
      manager.registerBlock('b1');
      manager.lockBlock('b1', 'route-1');
      manager.updateBlockOccupancy('b1', 'clear');
      expect(manager.getBlock('b1')?.lockedByRoute).toBe('route-1');
    });

    it('unlocks a block', () => {
      manager.registerBlock('b1');
      manager.lockBlock('b1', 'route-1');
      manager.unlockBlock('b1');
      expect(manager.getBlock('b1')?.lockedByRoute).toBeNull();
    });

    it('lockBlock on an unregistered block id is a silent no-op (ReservationService must not rely on this call to validate anything)', () => {
      // No registerBlock('ghost') call — the block does not exist in state.
      expect(() => manager.lockBlock('ghost', 'route-1')).not.toThrow();
      expect(manager.getBlock('ghost')).toBeUndefined();
    });
  });

  describe('point management', () => {
    it('registers a point with unknown position', () => {
      const point = manager.registerPoint('p1');
      expect(point.pointId).toBe('p1');
      expect(point.position).toBe('unknown');
      expect(point.locked).toBe(false);
    });

    it('updates point position', () => {
      manager.registerPoint('p1');
      const updated = manager.updatePointPosition('p1', 'reverse');
      expect(updated.position).toBe('reverse');
    });

    it('locks and unlocks a point', () => {
      manager.registerPoint('p1');
      manager.lockPoint('p1', 'route-2');
      expect(manager.getPoint('p1')?.locked).toBe(true);
      expect(manager.getPoint('p1')?.lockedByRoute).toBe('route-2');
      manager.unlockPoint('p1');
      expect(manager.getPoint('p1')?.locked).toBe(false);
    });

    it('lockPoint on an unregistered point id is a silent no-op', () => {
      expect(() => manager.lockPoint('ghost', 'route-1')).not.toThrow();
      expect(manager.getPoint('ghost')).toBeUndefined();
    });
  });

  describe('loco management', () => {
    it('creates a loco with defaults', () => {
      const loco = manager.updateLoco(3, {});
      expect(loco.address).toBe(3);
      expect(loco.speed).toBe(0);
      expect(loco.direction).toBe('stop');
      expect(loco.authority).toBe('manual');
    });

    it('updates loco speed and direction', () => {
      manager.updateLoco(3, {});
      const updated = manager.updateLoco(3, { speed: 75, direction: 'fwd' });
      expect(updated.speed).toBe(75);
      expect(updated.direction).toBe('fwd');
    });

    it('stops all locos', () => {
      manager.updateLoco(3, { speed: 50, direction: 'fwd' });
      manager.updateLoco(7, { speed: 30, direction: 'rev' });
      const stopped = manager.stopAllLocos();
      expect(stopped).toHaveLength(2);
      for (const loco of stopped) {
        expect(loco.speed).toBe(0);
        expect(loco.direction).toBe('stop');
      }
    });
  });

  describe('route management', () => {
    function route(overrides: Partial<RouteReservation> = {}): RouteReservation {
      const now = new Date();
      return {
        id: 'route-1',
        layoutId: 'test-layout',
        locoAddress: 3,
        authority: 'manual',
        status: 'active',
        path: [],
        holds: [],
        confirmedIndex: 0,
        reason: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
    }

    it('has no routes initially', () => {
      expect(manager.listRoutes()).toEqual([]);
      expect(manager.getRoute('route-1')).toBeUndefined();
    });

    it('upserts and retrieves a route', () => {
      manager.upsertRoute(route());
      expect(manager.getRoute('route-1')?.status).toBe('active');
      expect(manager.listRoutes()).toHaveLength(1);
    });

    it('upsertRoute replaces an existing route by id', () => {
      manager.upsertRoute(route({ status: 'active' }));
      manager.upsertRoute(route({ status: 'suspended' }));
      expect(manager.listRoutes()).toHaveLength(1);
      expect(manager.getRoute('route-1')?.status).toBe('suspended');
    });

    it('listRoutes filters by status when given', () => {
      manager.upsertRoute(route({ id: 'r1', status: 'active' }));
      manager.upsertRoute(route({ id: 'r2', status: 'cancelled' }));
      expect(manager.listRoutes(['active']).map((r) => r.id)).toEqual(['r1']);
    });

    it('removeRoute deletes a route', () => {
      manager.upsertRoute(route());
      manager.removeRoute('route-1');
      expect(manager.getRoute('route-1')).toBeUndefined();
      expect(manager.listRoutes()).toEqual([]);
    });
  });

  describe('sensor observations (see docs/sensor-fault-recovery.md)', () => {
    it('registerSensor creates an observation with no fault and no reading', () => {
      const created = manager.registerSensor({
        sensorId: 's1',
        blockId: 'b1',
        type: 'block_detection',
        inService: true,
      });
      expect(created).toEqual({
        sensorId: 's1',
        blockId: 'b1',
        type: 'block_detection',
        inService: true,
        faulted: false,
        lastReading: null,
        lastReadingAt: null,
      });
    });

    it('re-registering preserves faulted and lastReading while updating blockId/type/inService', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true });
      manager.recordSensorReading('s1', 'occupied', new Date('2026-01-01T00:00:00.000Z'));
      manager.setSensorFaulted('s1', true);

      const reRegistered = manager.registerSensor({
        sensorId: 's1',
        blockId: 'b2',
        type: 'ir_position',
        inService: false,
      });

      expect(reRegistered.blockId).toBe('b2');
      expect(reRegistered.type).toBe('ir_position');
      expect(reRegistered.inService).toBe(false);
      expect(reRegistered.faulted).toBe(true);
      expect(reRegistered.lastReading).toBe('occupied');
    });

    it('unregisterSensor removes the observation', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true });
      manager.unregisterSensor('s1');
      expect(manager.getSensorObservation('s1')).toBeUndefined();
    });

    it('listSensorObservationsForBlock returns only that block’s sensors, [] for a block with none', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true });
      manager.registerSensor({ sensorId: 's2', blockId: 'b2', type: 'block_detection', inService: true });
      expect(manager.listSensorObservationsForBlock('b1').map((o) => o.sensorId)).toEqual(['s1']);
      expect(manager.listSensorObservationsForBlock('b3')).toEqual([]);
    });

    it('recordSensorReading sets lastReading and lastReadingAt', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true });
      const at = new Date('2026-01-01T00:00:00.000Z');
      manager.recordSensorReading('s1', 'clear', at);
      const observation = manager.getSensorObservation('s1');
      expect(observation?.lastReading).toBe('clear');
      expect(observation?.lastReadingAt).toBe(at);
    });

    it('clearSensorReading nulls both lastReading and lastReadingAt', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true });
      manager.recordSensorReading('s1', 'occupied', new Date());
      manager.clearSensorReading('s1');
      const observation = manager.getSensorObservation('s1');
      expect(observation?.lastReading).toBeNull();
      expect(observation?.lastReadingAt).toBeNull();
    });

    it('setSensorFaulted toggles faulted without touching the reading', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true });
      manager.recordSensorReading('s1', 'occupied', new Date());
      manager.setSensorFaulted('s1', true);
      expect(manager.getSensorObservation('s1')?.faulted).toBe(true);
      expect(manager.getSensorObservation('s1')?.lastReading).toBe('occupied');
      manager.setSensorFaulted('s1', false);
      expect(manager.getSensorObservation('s1')?.faulted).toBe(false);
    });

    it('every mutator is a no-op on an unknown sensorId — must not throw, must not create a phantom observation', () => {
      expect(() => manager.recordSensorReading('ghost', 'occupied', new Date())).not.toThrow();
      expect(() => manager.clearSensorReading('ghost')).not.toThrow();
      expect(() => manager.setSensorFaulted('ghost', true)).not.toThrow();
      expect(() => manager.unregisterSensor('ghost')).not.toThrow();
      expect(manager.getSensorObservation('ghost')).toBeUndefined();
    });
  });
});
