import { describe, it, expect, vi } from 'vitest';
import { LayoutService } from '../../../src/services/LayoutService';
import { LayoutStateManager } from '../../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository } from '../../../src/ports/ILayoutRepository';

// ── In-memory repository stub ─────────────────────────────────────────────────

function makeRepo(): ILayoutRepository {
  return {
    listLayouts: vi.fn().mockResolvedValue([]),
    getLayout: vi.fn().mockResolvedValue(null),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn().mockResolvedValue([]),
    getLoco: vi.fn().mockResolvedValue(null),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([{ id: 'b1', layoutId: 'test', name: 'Block 1' }]),
    createBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn().mockResolvedValue([
      { id: 'p1', layoutId: 'test', name: 'Point 1', dccAddress: 10, blockId: 'b1' },
    ]),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn().mockResolvedValue([
      {
        id: 's1',
        layoutId: 'test',
        name: 'Sensor 1',
        type: 'block_detection',
        blockId: 'b1',
        mqttTopic: 'layout/test/sensor/s1/reading',
      },
    ]),
    createSensor: vi.fn(),
    deleteSensor: vi.fn(),
    listGridTiles: vi.fn().mockResolvedValue([]),
    upsertGridTile: vi.fn(),
    clearGrid: vi.fn(),
  };
}

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ── Test helpers ──────────────────────────────────────────────────────────────

async function buildStartedService() {
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const repo = makeRepo();
  const stateManager = new LayoutStateManager('test');
  const service = new LayoutService(dcc, mqtt, repo, stateManager, silentLogger);
  await service.start('test');
  return { service, dcc, mqtt, repo, stateManager };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('LayoutService — startup', () => {
  it('sets system status to online after start', async () => {
    const { service } = await buildStartedService();
    expect(service.getSystemStatus().status).toBe('online');
    await service.stop();
  });

  it('registers blocks and points from the repository', async () => {
    const { stateManager, service } = await buildStartedService();
    expect(stateManager.getBlock('b1')).toBeDefined();
    expect(stateManager.getPoint('p1')).toBeDefined();
    await service.stop();
  });
});

describe('LayoutService — throttle commands', () => {
  it('issues a DCC speed command and updates loco state', async () => {
    const { service, dcc } = await buildStartedService();

    await service.handleThrottleCommand({ locoAddress: 3, speed: 50, direction: 'fwd' });

    expect(dcc.commandLog).toHaveLength(1);
    expect(dcc.commandLog[0].type).toBe('SET_SPEED');
    expect(dcc.commandLog[0].data).toMatchObject({ address: 3, speed: 50, direction: 'fwd' });
    await service.stop();
  });

  it('emits a LOCO_STATE event', async () => {
    const { service } = await buildStartedService();
    const events: unknown[] = [];
    service.on('event', (e) => events.push(e));

    await service.handleThrottleCommand({ locoAddress: 3, speed: 40, direction: 'rev' });

    const locoEvents = (events as Array<{ type: string }>).filter((e) => e.type === 'LOCO_STATE');
    expect(locoEvents).toHaveLength(1);
    await service.stop();
  });

  it('rejects an invalid speed', async () => {
    const { service } = await buildStartedService();
    await expect(
      service.handleThrottleCommand({ locoAddress: 3, speed: 200, direction: 'fwd' }),
    ).rejects.toThrow(/speed/i);
    await service.stop();
  });

  it('rejects an invalid loco address', async () => {
    const { service } = await buildStartedService();
    await expect(
      service.handleThrottleCommand({ locoAddress: 0, speed: 50, direction: 'fwd' }),
    ).rejects.toThrow(/address/i);
    await service.stop();
  });
});

describe('LayoutService — emergency stop', () => {
  it('stops all locos and issues DCC emergency stop', async () => {
    const { service, dcc, stateManager } = await buildStartedService();

    await service.handleThrottleCommand({ locoAddress: 3, speed: 50, direction: 'fwd' });
    dcc.clearLog();

    await service.handleEmergencyStop();

    expect(dcc.commandLog[0].type).toBe('EMERGENCY_STOP');
    expect(stateManager.getLoco(3)?.speed).toBe(0);
    await service.stop();
  });
});

describe('LayoutService — point commands', () => {
  it('issues a DCC point command and updates point state', async () => {
    const { service, dcc, stateManager } = await buildStartedService();

    await service.handlePointCommand({ pointId: 'p1', position: 'reverse' });

    expect(dcc.commandLog).toHaveLength(1);
    expect(dcc.commandLog[0].type).toBe('SET_POINT');
    expect(stateManager.getPoint('p1')?.position).toBe('reverse');
    await service.stop();
  });

  it('rejects a command on a locked point without force', async () => {
    const { service, stateManager } = await buildStartedService();
    stateManager.lockPoint('p1', 'route-99');

    await expect(service.handlePointCommand({ pointId: 'p1', position: 'normal' })).rejects.toThrow(
      /locked/i,
    );
    await service.stop();
  });

  it('allows a force override on a locked point', async () => {
    const { service, stateManager } = await buildStartedService();
    stateManager.lockPoint('p1', 'route-99');

    await expect(
      service.handlePointCommand({ pointId: 'p1', position: 'normal', force: true }),
    ).resolves.not.toThrow();
    await service.stop();
  });
});

describe('LayoutService — sensor-driven block state', () => {
  it('updates block occupancy when a sensor reading arrives', async () => {
    const { service, mqtt, stateManager } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', {
      state: 'occupied',
      updatedAt: new Date().toISOString(),
    });

    // simulateIncoming is synchronous via the handler called directly
    await new Promise((r) => setImmediate(r));
    expect(stateManager.getBlock('b1')?.occupancy).toBe('occupied');
    await service.stop();
  });

  it('ignores malformed sensor payloads', async () => {
    const { service, mqtt, stateManager } = await buildStartedService();

    mqtt.simulateIncoming('layout/test/sensor/s1/reading', { badField: 'nonsense' });
    await new Promise((r) => setImmediate(r));

    // Block should remain in its initial 'unknown' state
    expect(stateManager.getBlock('b1')?.occupancy).toBe('unknown');
    await service.stop();
  });
});

describe('LayoutService — safe-stop on connection loss', () => {
  it('enters safe-stop when MQTT disconnects', async () => {
    const { service, mqtt } = await buildStartedService();

    // Simulate broker going offline
    (mqtt as SimulatedMqttAdapter).disconnect();
    await new Promise((r) => setImmediate(r));

    expect(service.getSystemStatus().status).toBe('safe-stop');
    await service.stop();
  });
});
