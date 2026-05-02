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

export type MqttMessageHandler = (payload: unknown, topic: string) => void;

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
