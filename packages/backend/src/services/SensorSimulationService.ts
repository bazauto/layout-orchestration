/**
 * SensorSimulationService
 *
 * Owns #65's bench-testing policy: publishing a fabricated sensor reading to
 * a sensor's own `mqttTopic`, exactly as if it had come from real hardware
 * (D1). No MQTT parsing, no domain decisions about occupancy — those still
 * happen exclusively in `LayoutService.handleSensorReading`, reached through
 * the ordinary broker round trip. This service only ever decides WHETHER to
 * publish and WHAT bytes go on the wire; safety rule 2 (no business logic in
 * transport callbacks) is why the route (`transport/http/routes/
 * sensorSimulation.ts`) is a thin parse-and-delegate into `inject` below.
 *
 * Constructed only when `SENSOR_SIMULATION=true` (see `index.ts`) — the flag
 * gates whether this service exists in the process at all (D2), not a
 * runtime check inside it.
 */

import {
  LayoutId,
  SensorId,
  SimulatedInjection,
  SimulatedReadingAction,
} from '../domain/types';
import { buildSimulatedPayload } from '../domain/sensorSimulation';
import { IMqttAdapter } from '../ports/IMqttAdapter';
import { ILayoutRepository } from '../ports/ILayoutRepository';
import { INameBook } from '../ports/INameBook';
import { INERT_NAME_BOOK } from './nameBook';
import { SensorNotFoundError } from './LayoutService';

export interface SensorSimulationLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Thrown when injection targets an out-of-service sensor (D9). Mapped to 409. */
export class SensorOutOfServiceError extends Error {
  constructor(
    readonly sensorId: SensorId,
    sensorLabelText?: string,
  ) {
    super(`Sensor ${sensorLabelText ?? sensorId} is out of service`);
    this.name = 'SensorOutOfServiceError';
  }
}

/** Thrown when `:layoutId` is not the layout this process is running (mirrors GET /sensor-faults). */
export class LayoutNotRunningError extends Error {
  constructor(
    readonly layoutId: LayoutId,
    layoutLabelText?: string,
  ) {
    super(`Layout ${layoutLabelText ?? layoutId} is not the running layout`);
    this.name = 'LayoutNotRunningError';
  }
}

export class SensorSimulationService {
  constructor(
    private readonly mqtt: IMqttAdapter,
    private readonly repo: ILayoutRepository,
    private readonly log: SensorSimulationLogger,
    private readonly layoutId: LayoutId,
    private readonly names: INameBook = INERT_NAME_BOOK,
  ) {}

  /**
   * Publishes a fabricated reading for `sensorId` and returns the exact
   * bytes that went on the wire (the D8 "last injected" echo). Order:
   *
   *  1. `layoutId` must be the layout this process is running — injecting
   *     into any other layout publishes onto a topic nobody is subscribed
   *     to, silent by design, exactly D9's objection to an out-of-service
   *     sensor.
   *  2. The sensor must exist in this layout's registry.
   *  3. The sensor must be in service. NOTHING is published otherwise —
   *     publishing anyway would strand a retained value on a topic nobody
   *     watches, which resurfaces as truth when the sensor returns to
   *     service.
   *  4. Build the payload.
   *  5. Log BEFORE publishing (D12), so the log reads "fabricated X"
   *     immediately followed by the genuine ingestion line.
   *  6. Publish — `clearRetained` for `clear-retained`, `publish` otherwise.
   */
  async inject(
    layoutId: LayoutId,
    sensorId: SensorId,
    action: SimulatedReadingAction,
    actor: { username: string },
  ): Promise<SimulatedInjection> {
    if (layoutId !== this.layoutId) {
      throw new LayoutNotRunningError(layoutId, this.names.get().layouts.get(layoutId));
    }

    const sensors = await this.repo.listSensors(layoutId);
    const sensor = sensors.find((s) => s.id === sensorId);
    if (!sensor) {
      throw new SensorNotFoundError(sensorId, this.names.get().sensors.get(sensorId));
    }

    if (!sensor.inService) {
      throw new SensorOutOfServiceError(sensorId, this.names.get().sensors.get(sensorId));
    }

    const publishedAt = new Date();
    const payload = buildSimulatedPayload(action, publishedAt);
    const retain = action.action === 'clear-retained' ? true : action.retain;

    this.log.warn('[SensorSimulation] Publishing a FABRICATED sensor reading', {
      layoutId,
      layoutName: this.names.get().layouts.get(layoutId),
      sensorId,
      sensorName: this.names.get().sensors.get(sensorId),
      blockId: sensor.blockId,
      blockName: sensor.blockId ? this.names.get().blocks.get(sensor.blockId) : undefined,
      topic: sensor.mqttTopic,
      action: action.action,
      payload,
      retain,
      username: actor.username,
    });

    if (action.action === 'clear-retained') {
      await this.mqtt.clearRetained(sensor.mqttTopic);
    } else {
      await this.mqtt.publish(sensor.mqttTopic, payload, { qos: 1, retain: action.retain });
    }

    return {
      sensorId,
      sensorName: this.names.get().sensors.get(sensorId) ?? null,
      topic: sensor.mqttTopic,
      action: action.action,
      payload,
      retain,
      publishedAt,
    };
  }
}
