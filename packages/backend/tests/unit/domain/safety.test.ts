import { describe, it, expect } from 'vitest';
import {
  evaluateSafeStop,
  evaluateSystemSafeStop,
  oldestSensorFault,
  oldestPointFault,
  oldestRouteFault,
  oldestBrakingFault,
  canIssueAutoCommand,
  canIssueManualCommand,
  canGrantRoute,
  canForcePointOverride,
  isBlockEffectivelyOccupied,
  isValidSpeed,
  isValidLocoAddress,
} from '../../../src/domain/safety';
import { BrakingFault, PointFault, RouteFault, SensorFault } from '../../../src/domain/types';

describe('evaluateSafeStop', () => {
  it('returns no safe-stop when both connections are healthy', () => {
    const result = evaluateSafeStop({ mqttConnected: true, dccConnected: true });
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('triggers safe-stop when MQTT disconnects', () => {
    const result = evaluateSafeStop({ mqttConnected: false, dccConnected: true });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/MQTT/i);
  });

  it('triggers safe-stop when DCC controller disconnects', () => {
    const result = evaluateSafeStop({ mqttConnected: true, dccConnected: false });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/DCC/i);
  });

  it('triggers safe-stop when both connections are down', () => {
    const result = evaluateSafeStop({ mqttConnected: false, dccConnected: false });
    expect(result.shouldStop).toBe(true);
  });
});

function fault(overrides: Partial<SensorFault> = {}): SensorFault {
  return {
    sensorId: 's1',
    reason: 'Malformed sensor payload from sensor "s1" on topic "layout/test/sensor/s1/reading": bad shape',
    topic: 'layout/test/sensor/s1/reading',
    faultedAt: new Date('2026-01-01T00:00:00.000Z'),
    consecutiveValidReadings: 0,
    ...overrides,
  };
}

function routeFault(overrides: Partial<RouteFault> = {}): RouteFault {
  return {
    routeId: 'r1',
    kind: 'unexpected-occupancy',
    reason: 'Route r1 violated: unexpected occupancy in block b3',
    blockId: 'b3',
    pointId: null,
    locoAddress: 3,
    faultedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function pointFault(overrides: Partial<PointFault> = {}): PointFault {
  return {
    pointId: 'p1',
    kind: 'timeout',
    reason: 'Point p1 failed to confirm: timed out waiting for a reading',
    faultedAt: new Date('2026-01-01T00:00:00.000Z'),
    consecutiveConfirmations: 0,
    ...overrides,
  };
}

function brakingFault(overrides: Partial<BrakingFault> = {}): BrakingFault {
  return {
    locoAddress: 3,
    kind: 'overrun',
    reason: 'Loco 3 overran its braking target: block b4 is occupied at or beyond the stopping point of route r1',
    routeId: 'r1',
    blockId: 'b4',
    faultedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('oldestBrakingFault', () => {
  it('returns null for an empty collection', () => {
    expect(oldestBrakingFault({})).toBeNull();
  });

  it('returns the fault with the earliest faultedAt', () => {
    const older = brakingFault({ locoAddress: 3, faultedAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = brakingFault({ locoAddress: 8, faultedAt: new Date('2026-01-02T00:00:00.000Z') });
    expect(oldestBrakingFault({ 8: newer, 3: older })).toBe(older);
  });
});

describe('oldestPointFault', () => {
  it('returns null for an empty collection', () => {
    expect(oldestPointFault({})).toBeNull();
  });

  it('returns the fault with the earliest faultedAt', () => {
    const older = pointFault({ pointId: 'p1', faultedAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = pointFault({ pointId: 'p2', faultedAt: new Date('2026-01-02T00:00:00.000Z') });
    expect(oldestPointFault({ p2: newer, p1: older })).toBe(older);
  });
});

describe('oldestRouteFault', () => {
  it('returns null for an empty collection', () => {
    expect(oldestRouteFault({})).toBeNull();
  });

  it('returns the fault with the earliest faultedAt', () => {
    const older = routeFault({ routeId: 'r1', faultedAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = routeFault({ routeId: 'r2', faultedAt: new Date('2026-01-02T00:00:00.000Z') });
    expect(oldestRouteFault({ r2: newer, r1: older })).toBe(older);
  });
});

describe('oldestSensorFault', () => {
  it('returns null for an empty collection', () => {
    expect(oldestSensorFault({})).toBeNull();
  });

  it('returns the single fault when there is exactly one', () => {
    const f = fault();
    expect(oldestSensorFault({ s1: f })).toBe(f);
  });

  it('returns the fault with the earliest faultedAt when there are several', () => {
    const older = fault({ sensorId: 's1', faultedAt: new Date('2026-01-01T00:00:00.000Z') });
    const newer = fault({ sensorId: 's2', faultedAt: new Date('2026-01-02T00:00:00.000Z') });
    expect(oldestSensorFault({ s2: newer, s1: older })).toBe(older);
  });

  it('resolves a tied faultedAt to insertion order (first-inserted wins)', () => {
    const tiedAt = new Date('2026-01-01T00:00:00.000Z');
    const first = fault({ sensorId: 's1', faultedAt: tiedAt });
    const second = fault({ sensorId: 's2', faultedAt: tiedAt });
    const faults: Record<string, SensorFault> = {};
    faults.s1 = first;
    faults.s2 = second;
    expect(oldestSensorFault(faults)).toBe(first);
  });
});

describe('evaluateSystemSafeStop', () => {
  it('returns no safe-stop when connections, topology, sensor, point, and route health are all healthy', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('stops with the topology reason when connections are healthy but topology is invalid', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: false,
      topologyReason: 'Topology invalid: 1 violation — edge e1 is a self-loop on block b1',
      sensorFaults: {},
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe(
      'Topology invalid: 1 violation — edge e1 is a self-loop on block b1',
    );
  });

  it('lets a connection failure reason win over an invalid topology', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: false,
      dccConnected: true,
      topologyValid: false,
      topologyReason: 'Topology invalid: 1 violation — edge e1 is a self-loop on block b1',
      sensorFaults: {},
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/MQTT/i);
  });

  it('stops with the sensor-fault reason when connections, topology, and route recovery are healthy but a sensor payload was malformed', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: { s1: fault() },
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe(
      'Malformed sensor payload from sensor "s1" on topic "layout/test/sensor/s1/reading": bad shape',
    );
  });

  it('lets a connection failure reason win over a sensor fault', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: false,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: { s1: fault() },
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/MQTT/i);
  });

  it('lets an invalid-topology reason win over a sensor fault', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: false,
      topologyReason: 'Topology invalid: 1 violation — edge e1 is a self-loop on block b1',
      sensorFaults: { s1: fault() },
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/self-loop/i);
  });

  it('reports the OLDEST of two faults with distinct faultedAt values', () => {
    const older = fault({
      sensorId: 's1',
      reason: 'Malformed sensor payload from sensor "s1" on topic "t1": older',
      faultedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = fault({
      sensorId: 's2',
      reason: 'Malformed sensor payload from sensor "s2" on topic "t2": newer',
      faultedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: { s2: newer, s1: older },
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/older/);
  });

  it('resolves two faults with an identical faultedAt to the first-inserted (deterministic tie-break)', () => {
    const tiedAt = new Date('2026-01-01T00:00:00.000Z');
    const first = fault({
      sensorId: 's1',
      reason: 'Malformed sensor payload from sensor "s1" on topic "t1": first',
      faultedAt: tiedAt,
    });
    const second = fault({
      sensorId: 's2',
      reason: 'Malformed sensor payload from sensor "s2" on topic "t2": second',
      faultedAt: tiedAt,
    });
    const sensorFaults: Record<string, SensorFault> = {};
    sensorFaults.s1 = first;
    sensorFaults.s2 = second;
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults,
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.reason).toMatch(/first/);
  });

  it('still stops with the survivor reason once one of two faults is removed', () => {
    // s1 (which would have had an EARLIER faultedAt than s2) is deliberately
    // absent from `sensorFaults` below — already resolved/removed, as if by
    // acknowledgeSensorFault or an out-of-service transition.
    const s2 = fault({
      sensorId: 's2',
      reason: 'Malformed sensor payload from sensor "s2" on topic "t2": s2 reason',
      faultedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: { s2 }, // s1 already resolved/removed
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/s2 reason/);
  });

  // ── Point faults (#25, D4) ───────────────────────────────────────────────

  it('stops with the point-fault reason when everything above it (MQTT, DCC, topology, sensor faults) is healthy', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: { p1: pointFault() },
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/failed to confirm/);
  });

  it('lets a sensor fault win over a point fault — the sensor is the more systemic failure', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: { s1: fault() },
      pointFaults: { p1: pointFault() },
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/Malformed sensor payload/);
  });

  it('lets a point fault win over a route fault — the point failure is the cause, the route fault the symptom', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: { p1: pointFault() },
      routeFaults: { r1: routeFault() },
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/failed to confirm/);
  });

  it('lets a point fault win over recovered routes', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: { p1: pointFault() },
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 3,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/failed to confirm/);
  });

  it('reports the OLDEST point fault when several are latched (the first cause)', () => {
    const older = pointFault({
      pointId: 'p1',
      reason: 'older point fault',
      faultedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = pointFault({
      pointId: 'p2',
      reason: 'newer point fault',
      faultedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: { p2: newer, p1: older },
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.reason).toBe('older point fault');
  });

  // ── Route faults (#4) ──────────────────────────────────────────────────

  it('stops with the route-fault reason when everything above it is healthy', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: {},
      routeFaults: { r1: routeFault() },
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/unexpected occupancy in block b3/);
  });

  it('lets a sensor fault win over a route fault — the sensor is usually the cause, the route the symptom', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: { s1: fault() },
      pointFaults: {},
      routeFaults: { r1: routeFault() },
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/Malformed sensor payload/);
  });

  it('lets a route fault win over recovered routes', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: {},
      routeFaults: { r1: routeFault() },
      brakingFaults: {},
      recoveredRouteCount: 3,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/unexpected occupancy in block b3/);
  });

  it('reports the OLDEST route fault when several are latched (the first cause)', () => {
    const older = routeFault({
      routeId: 'r1',
      reason: 'older route fault',
      faultedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = routeFault({
      routeId: 'r2',
      reason: 'newer route fault',
      faultedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: {},
      routeFaults: { r2: newer, r1: older },
      brakingFaults: {},
      recoveredRouteCount: 0,
    });
    expect(result.reason).toBe('older route fault');
  });

  // ── Braking faults (#6, docs/braking.md B10) ───────────────────────────

  it('stops with a braking-fault reason when nothing more systemic is wrong', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: {},
      routeFaults: {},
      brakingFaults: { 3: brakingFault() },
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/overran its braking target/);
  });

  it('lets a braking fault win over a route fault — the overrun is usually the cause, the route violation its symptom (B10)', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: {},
      // The route fault is OLDER, so this cannot pass by accident on timestamps.
      routeFaults: { r1: routeFault({ faultedAt: new Date('2025-01-01T00:00:00.000Z') }) },
      brakingFaults: { 3: brakingFault() },
      recoveredRouteCount: 0,
    });
    expect(result.reason).toMatch(/overran its braking target/);
  });

  it('lets a sensor fault and a point fault both win over a braking fault — a bad detector explains a bogus overrun (B10)', () => {
    const withSensor = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: { s1: fault({ faultedAt: new Date('2027-01-01T00:00:00.000Z') }) },
      pointFaults: {},
      routeFaults: {},
      brakingFaults: { 3: brakingFault() },
      recoveredRouteCount: 0,
    });
    expect(withSensor.reason).toMatch(/malformed/i);

    const withPoint = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: { p1: pointFault({ faultedAt: new Date('2027-01-01T00:00:00.000Z') }) },
      routeFaults: {},
      brakingFaults: { 3: brakingFault() },
      recoveredRouteCount: 0,
    });
    expect(withPoint.reason).toMatch(/failed to confirm/i);
  });

  it('reports the OLDEST braking fault when two locos are latched (the first cause)', () => {
    const older = brakingFault({
      locoAddress: 3,
      reason: 'older braking fault',
      faultedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const newer = brakingFault({
      locoAddress: 8,
      reason: 'newer braking fault',
      faultedAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: {},
      routeFaults: {},
      brakingFaults: { 8: newer, 3: older },
      recoveredRouteCount: 0,
    });
    expect(result.reason).toBe('older braking fault');
  });

  it('stops with a recovered-route reason when connections, topology, and sensor health are all healthy but routes survived a restart (D9)', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: {},
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 2,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/2 route reservation\(s\) survived a restart/i);
  });

  it('lets a sensor fault win over recovered routes (full check order: MQTT, DCC, topology, sensor fault, point fault, route fault, then recovered routes)', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFaults: { s1: fault() },
      pointFaults: {},
      routeFaults: {},
      brakingFaults: {},
      recoveredRouteCount: 1,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/malformed/i);
  });
});

describe('canGrantRoute', () => {
  it('permits a grant only when online', () => {
    expect(canGrantRoute('online')).toBe(true);
  });

  it('refuses a grant during safe-stop', () => {
    expect(canGrantRoute('safe-stop')).toBe(false);
  });

  it('refuses a grant when offline', () => {
    expect(canGrantRoute('offline')).toBe(false);
  });
});

describe('canForcePointOverride', () => {
  it('permits a force override in manual mode while online', () => {
    expect(canForcePointOverride('online', 'manual')).toBe(true);
  });

  it('permits a force override in hybrid mode', () => {
    expect(canForcePointOverride('online', 'hybrid')).toBe(true);
  });

  it('refuses a force override in auto mode — no manual authority in auto', () => {
    expect(canForcePointOverride('online', 'auto')).toBe(false);
  });

  it('permits a force override during safe-stop for operator recovery', () => {
    expect(canForcePointOverride('safe-stop', 'manual')).toBe(true);
  });

  it('refuses a force override when offline', () => {
    expect(canForcePointOverride('offline', 'manual')).toBe(false);
  });
});

describe('canIssueAutoCommand', () => {
  it('permits auto commands when online and in auto mode', () => {
    expect(canIssueAutoCommand('online', 'auto')).toBe(true);
  });

  it('permits auto commands when online and in hybrid mode', () => {
    expect(canIssueAutoCommand('online', 'hybrid')).toBe(true);
  });

  it('denies auto commands in manual mode', () => {
    expect(canIssueAutoCommand('online', 'manual')).toBe(false);
  });

  it('denies auto commands during safe-stop', () => {
    expect(canIssueAutoCommand('safe-stop', 'auto')).toBe(false);
  });

  it('denies auto commands when offline', () => {
    expect(canIssueAutoCommand('offline', 'auto')).toBe(false);
  });
});

describe('canIssueManualCommand', () => {
  it('permits manual commands when online', () => {
    expect(canIssueManualCommand('online')).toBe(true);
  });

  it('permits manual commands during safe-stop (operator recovery)', () => {
    expect(canIssueManualCommand('safe-stop')).toBe(true);
  });

  it('denies manual commands when offline', () => {
    expect(canIssueManualCommand('offline')).toBe(false);
  });
});

describe('isBlockEffectivelyOccupied', () => {
  it('treats "occupied" as effectively occupied', () => {
    expect(isBlockEffectivelyOccupied('occupied')).toBe(true);
  });

  it('treats "unknown" as effectively occupied (fail-safe rule)', () => {
    expect(isBlockEffectivelyOccupied('unknown')).toBe(true);
  });

  it('treats "clear" as not occupied', () => {
    expect(isBlockEffectivelyOccupied('clear')).toBe(false);
  });
});

describe('isValidSpeed', () => {
  it('accepts 0', () => expect(isValidSpeed(0)).toBe(true));
  it('accepts 126', () => expect(isValidSpeed(126)).toBe(true));
  it('rejects -1', () => expect(isValidSpeed(-1)).toBe(false));
  it('rejects 127', () => expect(isValidSpeed(127)).toBe(false));
  it('rejects non-integer', () => expect(isValidSpeed(50.5)).toBe(false));
});

describe('isValidLocoAddress', () => {
  it('accepts 1', () => expect(isValidLocoAddress(1)).toBe(true));
  it('accepts 9999', () => expect(isValidLocoAddress(9999)).toBe(true));
  it('rejects 0', () => expect(isValidLocoAddress(0)).toBe(false));
  it('rejects 10000', () => expect(isValidLocoAddress(10000)).toBe(false));
  it('rejects non-integer', () => expect(isValidLocoAddress(3.5)).toBe(false));
});
