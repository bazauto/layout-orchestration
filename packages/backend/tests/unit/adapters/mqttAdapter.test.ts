import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// The real `mqtt` package opens a socket on `connect()`. Mock it with a bare
// EventEmitter that mimics the subset of MqttClient's API this adapter uses,
// so the adapter can be driven synchronously without a broker.
class FakeMqttClient extends EventEmitter {
  connected = false;
  publish = vi.fn((_topic: string, _payload: string, _opts: unknown, cb: (err?: Error) => void) => cb());
  subscribe = vi.fn((_topic: string, _opts: unknown, cb?: (err?: Error) => void) => cb?.());
  unsubscribe = vi.fn((_topic: string, cb?: (err?: Error) => void) => cb?.());
  end = vi.fn((_force: boolean, _opts: unknown, cb: () => void) => cb());
}

let fakeClient: FakeMqttClient;

vi.mock('mqtt', () => ({
  default: {
    connect: vi.fn(() => fakeClient),
  },
}));

// Import after the mock is registered so MqttAdapter picks up the mocked module.
import { MqttAdapter } from '../../../src/adapters/mqtt/MqttAdapter';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function buildConnectedAdapter() {
  fakeClient = new FakeMqttClient();
  const adapter = new MqttAdapter(
    { url: 'mqtt://localhost', clientId: 'test' },
    silentLogger,
  );
  const connectPromise = adapter.connect();
  fakeClient.emit('connect');
  await connectPromise;
  return adapter;
}

describe('MqttAdapter — non-JSON payload handling', () => {
  beforeEach(() => {
    silentLogger.info.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  it('delivers a valid JSON payload to the matching subscriber, forwarding retained: false when packet.retain is absent', async () => {
    const adapter = await buildConnectedAdapter();
    const handler = vi.fn();
    await adapter.subscribe('layout/test/sensor/s1/reading', handler);

    fakeClient.emit(
      'message',
      'layout/test/sensor/s1/reading',
      Buffer.from(JSON.stringify({ state: 'occupied' })),
      {},
    );

    expect(handler).toHaveBeenCalledWith(
      { state: 'occupied' },
      'layout/test/sensor/s1/reading',
      false,
    );
  });

  it('forwards retained: true when packet.retain is true', async () => {
    const adapter = await buildConnectedAdapter();
    const handler = vi.fn();
    await adapter.subscribe('layout/test/sensor/s1/reading', handler);

    fakeClient.emit(
      'message',
      'layout/test/sensor/s1/reading',
      Buffer.from(JSON.stringify({ state: 'occupied' })),
      { retain: true },
    );

    expect(handler).toHaveBeenCalledWith(
      { state: 'occupied' },
      'layout/test/sensor/s1/reading',
      true,
    );
  });

  it('forwards retained: false when packet.retain is explicitly false', async () => {
    const adapter = await buildConnectedAdapter();
    const handler = vi.fn();
    await adapter.subscribe('layout/test/sensor/s1/reading', handler);

    fakeClient.emit(
      'message',
      'layout/test/sensor/s1/reading',
      Buffer.from(JSON.stringify({ state: 'occupied' })),
      { retain: false },
    );

    expect(handler).toHaveBeenCalledWith(
      { state: 'occupied' },
      'layout/test/sensor/s1/reading',
      false,
    );
  });

  it('forwards a non-JSON payload to the subscriber as a raw string instead of dropping it', async () => {
    // Per mqtt-contract.md §Fail-Safe Triggers item 3, a malformed payload on
    // a sensor/control topic is a Safe-Stop trigger — a decision that belongs
    // to the subscriber (LayoutService), not this transport adapter. Silently
    // dropping the message here would prevent that decision from ever being
    // made, so the raw bytes must still reach the handler for its own
    // (Zod) validation to reject.
    const adapter = await buildConnectedAdapter();
    const handler = vi.fn();
    await adapter.subscribe('layout/test/sensor/s1/reading', handler);

    fakeClient.emit(
      'message',
      'layout/test/sensor/s1/reading',
      Buffer.from('not-json{{{'),
      {},
    );

    expect(handler).toHaveBeenCalledWith('not-json{{{', 'layout/test/sensor/s1/reading', false);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      '[MQTT] Received non-JSON payload; forwarding raw for the subscriber to validate',
      { topic: 'layout/test/sensor/s1/reading' },
    );
  });

  it('forwards a retained non-JSON payload as retained: true — a retained message is still retained even when malformed', async () => {
    const adapter = await buildConnectedAdapter();
    const handler = vi.fn();
    await adapter.subscribe('layout/test/sensor/s1/reading', handler);

    fakeClient.emit(
      'message',
      'layout/test/sensor/s1/reading',
      Buffer.from('not-json{{{'),
      { retain: true },
    );

    expect(handler).toHaveBeenCalledWith('not-json{{{', 'layout/test/sensor/s1/reading', true);
  });
});
