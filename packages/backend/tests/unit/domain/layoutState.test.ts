import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutStateManager } from '../../../src/domain/layoutState';

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
});
