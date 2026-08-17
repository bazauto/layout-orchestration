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

  describe('point management (see docs/point-feedback.md)', () => {
    const NOW = new Date('2026-08-14T00:00:00.000Z');

    it("registers a point unreported, confirmedPosition 'unknown', via initialPointState", () => {
      const point = manager.registerPoint('p1', 'required', NOW);
      expect(point.pointId).toBe('p1');
      expect(point.commandedPosition).toBeNull();
      expect(point.confirmedPosition).toBe('unknown');
      expect(point.confirmation).toBe('unreported');
      expect(point.positionFeedback).toBe('required');
      expect(point.locked).toBe(false);
    });

    it('carries the configured feedback mode through unchanged', () => {
      const point = manager.registerPoint('p1', 'none', NOW);
      expect(point.positionFeedback).toBe('none');
    });

    it('setPointState stores whatever it is given for a registered point', () => {
      const registered = manager.registerPoint('p1', 'none', NOW);
      const next = { ...registered, commandedPosition: 'reverse' as const, confirmedPosition: 'reverse' as const };
      const stored = manager.setPointState('p1', next);
      expect(stored).toBe(next);
      expect(manager.getPoint('p1')).toEqual(next);
    });

    it('locks and unlocks a point', () => {
      manager.registerPoint('p1', 'none', NOW);
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

    // ── Failure path ────────────────────────────────────────────────────

    it('setPointState for an UNREGISTERED point id is a no-op returning the passed state without inserting — PointConfirmationService relies on this', () => {
      const phantom = manager.registerPoint('template', 'none', NOW); // borrow a well-formed PointState shape
      const ghostState = { ...phantom, pointId: 'ghost' };
      const result = manager.setPointState('ghost', ghostState);
      expect(result).toBe(ghostState); // returns the passed state unchanged
      expect(manager.getPoint('ghost')).toBeUndefined(); // but nothing was inserted
      expect(manager.getState().points.size).toBe(1); // only 'template' is registered
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
        position: null,
      });
      expect(created).toEqual({
        sensorId: 's1',
        blockId: 'b1',
        type: 'block_detection',
        inService: true,
        faulted: false,
        // #28 D6: a newly registered sensor is untrusted until a LIVE reading
        // arrives. This is the fail-safe default and it is what makes a
        // restart honest — every sensor starts as evidence of nothing and
        // earns trust back inside one re-assert interval.
        trusted: false,
        lastReading: null,
        lastReadingAt: null,
        lastLiveReadingAt: null,
        position: null,
        lastRisingEdgeAt: null,
      });
    });

    it('re-registering preserves faulted and lastReading while updating blockId/type/inService/position', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      manager.recordSensorReading('s1', 'occupied', new Date('2026-01-01T00:00:00.000Z'), 'live');
      manager.setSensorFaulted('s1', true);

      const reRegistered = manager.registerSensor({
        sensorId: 's1',
        blockId: 'b2',
        type: 'ir_position',
        inService: false,
        position: { towardBlockId: 'b3', offsetMm: 400 },
      });

      expect(reRegistered.blockId).toBe('b2');
      expect(reRegistered.type).toBe('ir_position');
      expect(reRegistered.inService).toBe(false);
      expect(reRegistered.faulted).toBe(true);
      expect(reRegistered.lastReading).toBe('occupied');
      // #77 D3: position is config, taken from the caller, not preserved like
      // the observation fields — a re-measure takes effect at once.
      expect(reRegistered.position).toEqual({ towardBlockId: 'b3', offsetMm: 400 });
      // ...while the fix itself, which records *when* a train was seen and not
      // where, survives the re-registration.
      expect(reRegistered.lastRisingEdgeAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
      // #28: liveness survives it too, for the same reason — re-registering is
      // a config edit (the operator changed a block or an offset), not an
      // assertion that the device stopped reporting.
      expect(reRegistered.trusted).toBe(true);
      expect(reRegistered.lastLiveReadingAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    });

    it('unregisterSensor removes the observation', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      manager.unregisterSensor('s1');
      expect(manager.getSensorObservation('s1')).toBeUndefined();
    });

    it('listSensorObservationsForBlock returns only that block’s sensors, [] for a block with none', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      manager.registerSensor({ sensorId: 's2', blockId: 'b2', type: 'block_detection', inService: true, position: null });
      expect(manager.listSensorObservationsForBlock('b1').map((o) => o.sensorId)).toEqual(['s1']);
      expect(manager.listSensorObservationsForBlock('b3')).toEqual([]);
    });

    it('recordSensorReading sets lastReading and lastReadingAt', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      const at = new Date('2026-01-01T00:00:00.000Z');
      manager.recordSensorReading('s1', 'clear', at, 'live');
      const observation = manager.getSensorObservation('s1');
      expect(observation?.lastReading).toBe('clear');
      expect(observation?.lastReadingAt).toBe(at);
    });

    it('clearSensorReading nulls lastReading, lastReadingAt and the position fix', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      manager.recordSensorReading('s1', 'occupied', new Date(), 'live');
      manager.clearSensorReading('s1');
      const observation = manager.getSensorObservation('s1');
      expect(observation?.lastReading).toBeNull();
      expect(observation?.lastReadingAt).toBeNull();
      // #77 D11: an observation from a sensor the system has stopped trusting
      // is not one to keep crediting distance from.
      expect(observation?.lastRisingEdgeAt).toBeNull();
    });

    // ── #77 D6: the fix is the rising edge, and only the rising edge ─────────

    it('recordSensorReading takes a position fix on clear -> occupied, and on the first reading of all', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'ir_position', inService: true, position: null });
      const first = new Date('2026-01-01T00:00:00.000Z');
      manager.recordSensorReading('s1', 'occupied', first, 'live');
      expect(manager.getSensorObservation('s1')?.lastRisingEdgeAt).toBe(first);

      const cleared = new Date('2026-01-01T00:00:05.000Z');
      manager.recordSensorReading('s1', 'clear', cleared, 'live');
      // A clear does not take a fix and does not discard the one already held —
      // the train having passed only means more time has elapsed.
      expect(manager.getSensorObservation('s1')?.lastRisingEdgeAt).toBe(first);

      const second = new Date('2026-01-01T00:00:09.000Z');
      manager.recordSensorReading('s1', 'occupied', second, 'live');
      expect(manager.getSensorObservation('s1')?.lastRisingEdgeAt).toBe(second);
    });

    it('a repeated occupied reading does NOT move the fix, though it does move lastReadingAt', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'ir_position', inService: true, position: null });
      const rising = new Date('2026-01-01T00:00:00.000Z');
      const republished = new Date('2026-01-01T00:00:30.000Z');
      manager.recordSensorReading('s1', 'occupied', rising, 'live');
      manager.recordSensorReading('s1', 'occupied', republished, 'live');

      const observation = manager.getSensorObservation('s1');
      expect(observation?.lastReadingAt).toBe(republished);
      // The load-bearing half: a device re-publishing its state on a timer must
      // not appear to re-observe a train that has long since gone, or every fix
      // taken from it would be indefinitely fresh.
      expect(observation?.lastRisingEdgeAt).toBe(rising);
    });

    // ── #28: provenance (see docs/sensor-trust.md D6/D7) ────────────────

    it('a retained reading is recorded but advances neither liveness nor trust', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      const at = new Date('2026-01-01T00:00:00.000Z');
      manager.recordSensorReading('s1', 'clear', at, 'retained');

      const observation = manager.getSensorObservation('s1');
      // Recorded — not thrown away. A retained value is worth displaying and
      // logging; it is just not evidence of live track.
      expect(observation?.lastReading).toBe('clear');
      expect(observation?.lastReadingAt).toBe(at);
      // ...but the two fields that make it believable stay put.
      expect(observation?.lastLiveReadingAt).toBeNull();
      expect(observation?.trusted).toBe(false);
    });

    it('a live reading sets liveness AND trust, because a reading received now is fresh now', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      const at = new Date('2026-01-01T00:00:00.000Z');
      manager.recordSensorReading('s1', 'clear', at, 'live');

      const observation = manager.getSensorObservation('s1');
      expect(observation?.lastLiveReadingAt).toBe(at);
      // Trust is restored here rather than at the next sweep — a sensor
      // coming back must restore its block at once, not up to a sweep
      // interval later.
      expect(observation?.trusted).toBe(true);
    });

    it('a retained reading NEVER demotes a sensor that is already trusted', () => {
      // Trust is a property of the device, not of the connection. A broker
      // blip replays retained values to a backend whose sensors are all
      // perfectly alive; flapping them to untrusted would be a nuisance
      // degrade, and the freshness window catches a genuinely dead one on its
      // own schedule anyway.
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      const live = new Date('2026-01-01T00:00:00.000Z');
      manager.recordSensorReading('s1', 'clear', live, 'live');
      manager.recordSensorReading('s1', 'clear', new Date('2026-01-01T00:00:01.000Z'), 'retained');

      const observation = manager.getSensorObservation('s1');
      expect(observation?.trusted).toBe(true);
      expect(observation?.lastLiveReadingAt).toBe(live);
    });

    it('a retained occupied takes NO position fix, and a live occupied after it takes none either', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'ir_position', inService: true, position: null });
      manager.recordSensorReading('s1', 'occupied', new Date('2026-01-01T00:00:00.000Z'), 'retained');
      // A retained `occupied` is an archived copy of a train arriving at an
      // UNKNOWN time — crediting braking distance from it is exactly what
      // #77 D6 exists to prevent.
      expect(manager.getSensorObservation('s1')?.lastRisingEdgeAt).toBeNull();

      manager.recordSensorReading('s1', 'occupied', new Date('2026-01-01T00:00:05.000Z'), 'live');
      // Still none, and this looks like a bug and is not: the transition test
      // sees `occupied -> occupied`. The train was already standing there
      // before anything was watching, so the system genuinely does not know
      // when it arrived — and no fix is better than one stamped wrongly.
      expect(manager.getSensorObservation('s1')?.lastRisingEdgeAt).toBeNull();
    });

    it('clearSensorReading drops liveness and trust with the reading', () => {
      // Otherwise a sensor de-serviced for a week and put back would return
      // carrying `trusted: true`, and the first thing it heard — quite
      // possibly a retained replay from a controller that had been off the
      // whole time — would be believed on a week-old assertion.
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      manager.recordSensorReading('s1', 'clear', new Date('2026-01-01T00:00:00.000Z'), 'live');
      manager.clearSensorReading('s1');

      const observation = manager.getSensorObservation('s1');
      expect(observation?.trusted).toBe(false);
      expect(observation?.lastLiveReadingAt).toBeNull();
    });

    it('setSensorTrusted is a no-op on an unknown sensorId, and listSensorObservations returns every registered one', () => {
      expect(() => manager.setSensorTrusted('ghost', true)).not.toThrow();
      expect(manager.getSensorObservation('ghost')).toBeUndefined();

      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      manager.registerSensor({ sensorId: 's2', blockId: null, type: 'block_detection', inService: true, position: null });
      // The trust sweep's input: every sensor, including one mapped to no
      // block, which must not throw its way through the sweep.
      expect(manager.listSensorObservations().map((o) => o.sensorId).sort()).toEqual(['s1', 's2']);
    });

    it('setSensorFaulted toggles faulted without touching the reading', () => {
      manager.registerSensor({ sensorId: 's1', blockId: 'b1', type: 'block_detection', inService: true, position: null });
      manager.recordSensorReading('s1', 'occupied', new Date(), 'live');
      manager.setSensorFaulted('s1', true);
      expect(manager.getSensorObservation('s1')?.faulted).toBe(true);
      expect(manager.getSensorObservation('s1')?.lastReading).toBe('occupied');
      manager.setSensorFaulted('s1', false);
      expect(manager.getSensorObservation('s1')?.faulted).toBe(false);
    });

    it('every mutator is a no-op on an unknown sensorId — must not throw, must not create a phantom observation', () => {
      expect(() => manager.recordSensorReading('ghost', 'occupied', new Date(), 'live')).not.toThrow();
      expect(() => manager.clearSensorReading('ghost')).not.toThrow();
      expect(() => manager.setSensorFaulted('ghost', true)).not.toThrow();
      expect(() => manager.unregisterSensor('ghost')).not.toThrow();
      expect(manager.getSensorObservation('ghost')).toBeUndefined();
    });
  });
});
