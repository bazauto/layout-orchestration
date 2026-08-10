/**
 * MqttAdapter
 *
 * Real MQTT client adapter wrapping the `mqtt` npm package.
 * Connects to a Mosquitto broker and handles reconnection automatically.
 */

import mqtt, { IClientOptions, IPublishPacket, MqttClient } from 'mqtt';
import { IMqttAdapter, MqttMessageHandler, PublishOptions } from '../../ports/IMqttAdapter';

export interface MqttAdapterLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface MqttAdapterConfig {
  url: string;
  clientId: string;
  username?: string;
  password?: string;
  /** LWT topic for this client's status. Should be layout/{id}/system/status */
  lwtTopic?: string;
  /** LWT payload published when the connection drops unexpectedly. */
  lwtPayload?: unknown;
}

export class MqttAdapter implements IMqttAdapter {
  private client: MqttClient | null = null;
  private connected = false;
  private connectionHandlers: Array<(connected: boolean) => void> = [];
  private readonly subscriptions = new Map<string, MqttMessageHandler>();

  constructor(
    private readonly config: MqttAdapterConfig,
    private readonly log: MqttAdapterLogger,
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const options: IClientOptions = {
        clientId: this.config.clientId,
        username: this.config.username,
        password: this.config.password,
        clean: true,
        reconnectPeriod: 5000,
      };

      if (this.config.lwtTopic && this.config.lwtPayload !== undefined) {
        options.will = {
          topic: this.config.lwtTopic,
          payload: JSON.stringify(this.config.lwtPayload),
          qos: 1,
          retain: true,
        };
      }

      this.client = mqtt.connect(this.config.url, options);

      this.client.once('connect', () => {
        this.connected = true;
        this.log.info('[MQTT] Connected', { url: this.config.url });
        this.connectionHandlers.forEach((h) => h(true));
        resolve();
      });

      this.client.once('error', (err) => {
        reject(err);
      });

      this.client.on('connect', () => {
        if (!this.connected) {
          this.connected = true;
          this.log.info('[MQTT] Reconnected');
          this.connectionHandlers.forEach((h) => h(true));
          // Re-subscribe after reconnect
          for (const topic of this.subscriptions.keys()) {
            this.client?.subscribe(topic, { qos: 1 });
          }
        }
      });

      this.client.on('offline', () => {
        this.connected = false;
        this.log.warn('[MQTT] Broker offline / connection lost');
        this.connectionHandlers.forEach((h) => h(false));
      });

      this.client.on('error', (err) => {
        this.log.error('[MQTT] Error', { error: err.message });
      });

      this.client.on('message', (topic, rawPayload, packet: IPublishPacket) => {
        let payload: unknown;
        try {
          payload = JSON.parse(rawPayload.toString());
        } catch {
          // Do NOT drop this silently: a non-JSON payload is just as malformed
          // as one that parses but fails Zod validation (mqtt-contract.md
          // §Fail-Safe Triggers item 3), and this adapter has no way to know
          // whether `topic` is a sensor/control topic that requires a
          // Safe-Stop — that decision belongs to the subscriber (LayoutService),
          // per CLAUDE.md's "no business logic in transport callbacks" rule.
          // Deliver the raw string through instead of returning early, so the
          // subscriber's own schema validation sees it, fails, and reacts the
          // same way it would for a structurally-valid-but-wrong-shape payload.
          // Applies to a retained non-JSON payload too — it is still retained.
          this.log.warn('[MQTT] Received non-JSON payload; forwarding raw for the subscriber to validate', {
            topic,
          });
          payload = rawPayload.toString();
        }

        // `packet.retain === true` when the broker delivered this because it
        // was retained (subscribe-time or reconnect replay), not because it
        // was just published live — see the doc comment on
        // `MqttMessageHandler` for why the subscriber needs to know this.
        const retained = packet.retain === true;

        for (const [pattern, handler] of this.subscriptions) {
          if (this.topicMatchesPattern(topic, pattern)) {
            handler(payload, topic, retained);
          }
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.client) return resolve();
      this.client.end(false, {}, () => {
        this.connected = false;
        resolve();
      });
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandlers.push(handler);
  }

  async publish(topic: string, payload: unknown, options?: PublishOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client?.connected) {
        return reject(new Error('MQTT client is not connected'));
      }
      const serialized = JSON.stringify(payload);
      this.client.publish(
        topic,
        serialized,
        { qos: options?.qos ?? 1, retain: options?.retain ?? false },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
  }

  /** See the doc comment on `IMqttAdapter.clearRetained` (#65 D6/R1). */
  async clearRetained(topic: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client?.connected) {
        return reject(new Error('MQTT client is not connected'));
      }
      this.client.publish(topic, Buffer.alloc(0), { qos: 1, retain: true }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async subscribe(topic: string, handler: MqttMessageHandler): Promise<void> {
    this.subscriptions.set(topic, handler);
    return new Promise((resolve, reject) => {
      this.client?.subscribe(topic, { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async unsubscribe(topic: string): Promise<void> {
    this.subscriptions.delete(topic);
    return new Promise((resolve, reject) => {
      this.client?.unsubscribe(topic, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private topicMatchesPattern(topic: string, pattern: string): boolean {
    const topicParts = topic.split('/');
    const patternParts = pattern.split('/');
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '#') return true;
      if (patternParts[i] === '+') {
        if (i >= topicParts.length) return false;
        continue;
      }
      if (topicParts[i] !== patternParts[i]) return false;
    }
    return topicParts.length === patternParts.length;
  }
}
