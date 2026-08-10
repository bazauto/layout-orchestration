import { describe, it, expect, vi } from 'vitest';
import {
  SensorSimulationService,
  SensorOutOfServiceError,
  LayoutNotRunningError,
} from '../../../src/services/SensorSimulationService';
import { SensorNotFoundError } from '../../../src/services/LayoutService';
import { SimulatedMqttAdapter } from '../../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository, SensorRecord } from '../../../src/ports/ILayoutRepository';
import { EMPTY_NAME_BOOK } from '../../../src/domain/naming';
import { INameBook } from '../../../src/ports/INameBook';
import { NameBook } from '../../../src/domain/types';
import { MALFORMED_PAYLOADS } from '../../../src/domain/sensorSimulation';

const LAYOUT_ID = 'test-layout';

const SENSOR_S1: SensorRecord = {
  id: 's1',
  layoutId: LAYOUT_ID,
  name: 'Sensor 1',
  type: 'block_detection',
  blockId: 'b1',
  mqttTopic: 'layout/test-layout/sensor/s1/reading',
  inService: true,
};

const SENSOR_OUT_OF_SERVICE: SensorRecord = {
  ...SENSOR_S1,
  id: 's2',
  name: 'Sensor 2',
  mqttTopic: 'layout/test-layout/sensor/s2/reading',
  inService: false,
};

function makeRepo(sensors: SensorRecord[]): ILayoutRepository {
  return {
    listLayouts: vi.fn(),
    getLayout: vi.fn(),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn(),
    getLoco: vi.fn(),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn(),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn(),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn().mockImplementation(async (layoutId: string) =>
      sensors.filter((s) => s.layoutId === layoutId),
    ),
    createSensor: vi.fn(),
    updateSensor: vi.fn(),
    deleteSensor: vi.fn(),
    listGridTiles: vi.fn(),
    upsertGridTile: vi.fn(),
    deleteTile: vi.fn(),
    clearGrid: vi.fn(),
    listBlockEdges: vi.fn(),
    getBlockEdge: vi.fn(),
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),
    listReservations: vi.fn(),
    getReservation: vi.fn(),
    createReservation: vi.fn(),
    updateReservation: vi.fn(),
    markHoldsReleased: vi.fn(),
  };
}

function staticNameBook(book: NameBook): INameBook {
  return { get: () => book, refresh: async () => {} };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function buildService(sensors: SensorRecord[] = [SENSOR_S1, SENSOR_OUT_OF_SERVICE]) {
  const mqtt = new SimulatedMqttAdapter();
  const repo = makeRepo(sensors);
  const service = new SensorSimulationService(mqtt, repo, silentLogger, LAYOUT_ID, staticNameBook(EMPTY_NAME_BOOK));
  return { service, mqtt, repo };
}

const ACTOR = { username: 'test-operator' };

describe('SensorSimulationService.inject', () => {
  it("publishes to the sensor's own mqttTopic at QoS 1", async () => {
    const { service, mqtt } = buildService();

    await service.inject(LAYOUT_ID, 's1', { action: 'reading', state: 'occupied', retain: true }, ACTOR);

    expect(mqtt.publishLog).toHaveLength(1);
    expect(mqtt.publishLog[0].topic).toBe(SENSOR_S1.mqttTopic);
    expect(mqtt.publishLog[0].qos).toBe(1);
  });

  it('retain defaults through from the action: true publishes retained, false does not', async () => {
    const { service, mqtt } = buildService();

    await service.inject(LAYOUT_ID, 's1', { action: 'reading', state: 'clear', retain: false }, ACTOR);

    expect(mqtt.publishLog[0].retain).toBe(false);

    await service.inject(LAYOUT_ID, 's1', { action: 'reading', state: 'clear', retain: true }, ACTOR);

    expect(mqtt.publishLog[1].retain).toBe(true);
  });

  it('clear-retained calls clearRetained and never calls publish', async () => {
    const { service, mqtt } = buildService();
    const publishSpy = vi.spyOn(mqtt, 'publish');
    const clearSpy = vi.spyOn(mqtt, 'clearRetained');

    await service.inject(LAYOUT_ID, 's1', { action: 'clear-retained' }, ACTOR);

    expect(clearSpy).toHaveBeenCalledWith(SENSOR_S1.mqttTopic);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('each malformed variant publishes its canned payload byte-for-byte', async () => {
    const { service, mqtt } = buildService();

    for (const variant of ['bad-enum', 'missing-field', 'not-an-object'] as const) {
      await service.inject(LAYOUT_ID, 's1', { action: 'malformed', variant, retain: true }, ACTOR);
      expect(mqtt.publishLog.at(-1)?.payload).toEqual(MALFORMED_PAYLOADS[variant]);
    }
  });

  it('logs a warn naming sensor, sensorName, topic, payload, retain and username, before publishing', async () => {
    const { service, mqtt } = buildService();
    let loggedBeforePublish = false;
    silentLogger.warn.mockImplementationOnce(() => {
      loggedBeforePublish = mqtt.publishLog.length === 0;
    });

    await service.inject(LAYOUT_ID, 's1', { action: 'reading', state: 'occupied', retain: true }, ACTOR);

    expect(loggedBeforePublish).toBe(true);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      '[SensorSimulation] Publishing a FABRICATED sensor reading',
      expect.objectContaining({
        layoutId: LAYOUT_ID,
        sensorId: 's1',
        topic: SENSOR_S1.mqttTopic,
        action: 'reading',
        retain: true,
        username: ACTOR.username,
      }),
    );
  });

  it('an out-of-service sensor throws SensorOutOfServiceError and publishes nothing', async () => {
    const { service, mqtt } = buildService();

    await expect(
      service.inject(LAYOUT_ID, 's2', { action: 'reading', state: 'occupied', retain: true }, ACTOR),
    ).rejects.toThrow(SensorOutOfServiceError);
    expect(mqtt.publishLog).toHaveLength(0);
  });

  it('an unknown sensor throws SensorNotFoundError and publishes nothing', async () => {
    const { service, mqtt } = buildService();

    await expect(
      service.inject(LAYOUT_ID, 'ghost', { action: 'reading', state: 'occupied', retain: true }, ACTOR),
    ).rejects.toThrow(SensorNotFoundError);
    expect(mqtt.publishLog).toHaveLength(0);
  });

  it('a foreign layoutId throws LayoutNotRunningError and publishes nothing', async () => {
    const { service, mqtt } = buildService();

    await expect(
      service.inject('other-layout', 's1', { action: 'reading', state: 'occupied', retain: true }, ACTOR),
    ).rejects.toThrow(LayoutNotRunningError);
    expect(mqtt.publishLog).toHaveLength(0);
  });
});
