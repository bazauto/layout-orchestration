/**
 * Port: IMqttAdapter
 *
 * Defines the contract for MQTT pub/sub communication.
 * Implementations: MqttAdapter (real broker), SimulatedMqttAdapter (tests/dev).
 */

export interface PublishOptions {
  qos?: 0 | 1 | 2;
  retain?: boolean;
}

/**
 * `retained` mirrors mqtt.js's `packet.retain`: true when the broker
 * delivered this message because it was retained (e.g. replayed on
 * subscribe or reconnect), not because it was just published live. See
 * docs/sensor-fault-recovery.md D1/D8: `sensor/{sensorId}/reading` is a
 * retained topic (mqtt-contract.md), so a broker reconnect replays the last
 * reading — one free, stale, valid-looking message that must not count
 * toward a sensor fault's recovery-arming threshold, since it arrives
 * exactly when the system knows least about the layout.
 */
export type MqttMessageHandler = (payload: unknown, topic: string, retained: boolean) => void;

export interface IMqttAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onConnectionChange(handler: (connected: boolean) => void): void;

  /**
   * Publishes a message. The payload is serialized to JSON automatically.
   */
  publish(topic: string, payload: unknown, options?: PublishOptions): Promise<void>;

  /**
   * Subscribes to a topic pattern. The handler receives the deserialized JSON payload.
   * Supports MQTT wildcards (+ and #).
   */
  subscribe(topic: string, handler: MqttMessageHandler): Promise<void>;

  unsubscribe(topic: string): Promise<void>;
}
