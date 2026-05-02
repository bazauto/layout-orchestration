/**
 * SimulatedMqttAdapter
 *
 * An in-process MQTT broker simulator using Node.js EventEmitter.
 * All publish/subscribe calls happen synchronously in-process with no network.
 * Used in development (USE_SIMULATOR=true) and all automated tests.
 *
 * Supports MQTT wildcard matching for subscriptions (+ and #).
 */

import { EventEmitter } from 'events';
import { IMqttAdapter, MqttMessageHandler, PublishOptions } from '../../ports/IMqttAdapter';

function topicMatchesPattern(topic: string, pattern: string): boolean {
  const topicParts = topic.split('/');
  const patternParts = pattern.split('/');

  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i] === '#') {
      // # matches everything remaining
      return true;
    }
    if (patternParts[i] === '+') {
      // + matches exactly one level
      if (i >= topicParts.length) return false;
      continue;
    }
    if (topicParts[i] !== patternParts[i]) {
      return false;
    }
  }

  return topicParts.length === patternParts.length;
}

export class SimulatedMqttAdapter implements IMqttAdapter {
  private connected = false;
  private readonly emitter = new EventEmitter();
  private readonly subscriptions = new Map<string, MqttMessageHandler>();
  /** Retained messages — keyed by topic. */
  private readonly retained = new Map<string, unknown>();
  /** Full record of every published message. Useful for test assertions. */
  public readonly publishLog: Array<{ ts: Date; topic: string; payload: unknown }> = [];

  async connect(): Promise<void> {
    this.connected = true;
    this.emitter.emit('connectionChange', true);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.emitter.emit('connectionChange', false);
  }

  isConnected(): boolean {
    return this.connected;
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.emitter.on('connectionChange', handler);
  }

  async publish(topic: string, payload: unknown, options?: PublishOptions): Promise<void> {
    this.publishLog.push({ ts: new Date(), topic, payload });

    if (options?.retain) {
      this.retained.set(topic, payload);
    }

    // Deliver to all matching subscribers
    for (const [pattern, handler] of this.subscriptions) {
      if (topicMatchesPattern(topic, pattern)) {
        // Deliver asynchronously to match real broker behaviour
        setImmediate(() => handler(payload, topic));
      }
    }
  }

  async subscribe(topic: string, handler: MqttMessageHandler): Promise<void> {
    this.subscriptions.set(topic, handler);

    // Deliver any retained messages that match this subscription
    for (const [retainedTopic, payload] of this.retained) {
      if (topicMatchesPattern(retainedTopic, topic)) {
        setImmediate(() => handler(payload, retainedTopic));
      }
    }
  }

  async unsubscribe(topic: string): Promise<void> {
    this.subscriptions.delete(topic);
  }

  /** Simulate an incoming message from an external device (e.g., a sensor). */
  simulateIncoming(topic: string, payload: unknown): void {
    for (const [pattern, handler] of this.subscriptions) {
      if (topicMatchesPattern(topic, pattern)) {
        handler(payload, topic);
      }
    }
  }

  clearLog(): void {
    this.publishLog.length = 0;
  }
}
