import { describe, it, expect } from 'vitest';
import {
  evaluateSafeStop,
  evaluateSystemSafeStop,
  canIssueAutoCommand,
  canIssueManualCommand,
  canGrantRoute,
  canForcePointOverride,
  isBlockEffectivelyOccupied,
  isValidSpeed,
  isValidLocoAddress,
} from '../../../src/domain/safety';

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

describe('evaluateSystemSafeStop', () => {
  it('returns no safe-stop when connections, topology, sensor health, and route recovery are all healthy', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFault: false,
      sensorFaultReason: null,
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
      topologyReason: 'Topology invalid: 1 violation(s) — edge e1 is a self-loop on block b1',
      sensorFault: false,
      sensorFaultReason: null,
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toBe(
      'Topology invalid: 1 violation(s) — edge e1 is a self-loop on block b1',
    );
  });

  it('lets a connection failure reason win over an invalid topology', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: false,
      dccConnected: true,
      topologyValid: false,
      topologyReason: 'Topology invalid: 1 violation(s) — edge e1 is a self-loop on block b1',
      sensorFault: false,
      sensorFaultReason: null,
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
      sensorFault: true,
      sensorFaultReason: 'Malformed sensor payload from sensor "s1" on topic "layout/test/sensor/s1/reading": bad shape',
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
      sensorFault: true,
      sensorFaultReason: 'Malformed sensor payload from sensor "s1" on topic "layout/test/sensor/s1/reading": bad shape',
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
      topologyReason: 'Topology invalid: 1 violation(s) — edge e1 is a self-loop on block b1',
      sensorFault: true,
      sensorFaultReason: 'Malformed sensor payload from sensor "s1" on topic "layout/test/sensor/s1/reading": bad shape',
      recoveredRouteCount: 0,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/self-loop/i);
  });

  it('stops with a recovered-route reason when connections, topology, and sensor health are all healthy but routes survived a restart (D9)', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFault: false,
      sensorFaultReason: null,
      recoveredRouteCount: 2,
    });
    expect(result.shouldStop).toBe(true);
    expect(result.reason).toMatch(/2 route reservation\(s\) survived a restart/i);
  });

  it('lets a sensor fault win over recovered routes (full check order: MQTT, DCC, topology, sensor fault, then recovered routes)', () => {
    const result = evaluateSystemSafeStop({
      mqttConnected: true,
      dccConnected: true,
      topologyValid: true,
      topologyReason: null,
      sensorFault: true,
      sensorFaultReason: 'Malformed sensor payload from sensor "s1" on topic "layout/test/sensor/s1/reading": bad shape',
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
