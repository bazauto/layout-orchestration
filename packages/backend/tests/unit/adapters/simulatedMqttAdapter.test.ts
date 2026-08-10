/**
 * SimulatedMqttAdapter — retained-flag behaviour (see docs/sensor-fault-recovery.md D1/D8).
 */
import { describe, it, expect, vi } from 'vitest';
import { SimulatedMqttAdapter } from '../../../src/adapters/mqtt/SimulatedMqttAdapter';

describe('SimulatedMqttAdapter — retained flag', () => {
  it('publish({retain:true}) delivers retained: false to an already-subscribed handler — live delivery is never "retained"', async () => {
    const adapter = new SimulatedMqttAdapter();
    const handler = vi.fn();
    await adapter.subscribe('layout/test/sensor/s1/reading', handler);

    await adapter.publish('layout/test/sensor/s1/reading', { state: 'occupied' }, { retain: true });
    await new Promise((r) => setImmediate(r));

    expect(handler).toHaveBeenCalledWith(
      { state: 'occupied' },
      'layout/test/sensor/s1/reading',
      false,
    );
  });

  it('a later subscribe() replays a retained message with retained: true', async () => {
    const adapter = new SimulatedMqttAdapter();
    await adapter.publish('layout/test/sensor/s1/reading', { state: 'clear' }, { retain: true });

    const handler = vi.fn();
    await adapter.subscribe('layout/test/sensor/s1/reading', handler);
    await new Promise((r) => setImmediate(r));

    expect(handler).toHaveBeenCalledWith({ state: 'clear' }, 'layout/test/sensor/s1/reading', true);
  });

  it('publish with no retain option delivers retained: false', async () => {
    const adapter = new SimulatedMqttAdapter();
    const handler = vi.fn();
    await adapter.subscribe('layout/test/sensor/s1/reading', handler);

    await adapter.publish('layout/test/sensor/s1/reading', { state: 'occupied' });
    await new Promise((r) => setImmediate(r));

    expect(handler).toHaveBeenCalledWith(
      { state: 'occupied' },
      'layout/test/sensor/s1/reading',
      false,
    );
  });

  it('simulateIncoming defaults to retained: false', () => {
    const adapter = new SimulatedMqttAdapter();
    const handler = vi.fn();
    adapter.subscribe('layout/test/sensor/s1/reading', handler);

    adapter.simulateIncoming('layout/test/sensor/s1/reading', { state: 'occupied' });

    expect(handler).toHaveBeenCalledWith(
      { state: 'occupied' },
      'layout/test/sensor/s1/reading',
      false,
    );
  });

  it('simulateIncoming(topic, payload, true) exercises the reconnect-replay case with no broker', () => {
    const adapter = new SimulatedMqttAdapter();
    const handler = vi.fn();
    adapter.subscribe('layout/test/sensor/s1/reading', handler);

    adapter.simulateIncoming('layout/test/sensor/s1/reading', { state: 'occupied' }, true);

    expect(handler).toHaveBeenCalledWith(
      { state: 'occupied' },
      'layout/test/sensor/s1/reading',
      true,
    );
  });

  it('publish records qos and retain in publishLog', async () => {
    const adapter = new SimulatedMqttAdapter();

    await adapter.publish('layout/test/sensor/s1/reading', { state: 'occupied' }, { qos: 1, retain: true });
    await adapter.publish('layout/test/sensor/s1/reading', { state: 'clear' });

    expect(adapter.publishLog[0]).toMatchObject({ qos: 1, retain: true });
    expect(adapter.publishLog[1]).toMatchObject({ qos: 1, retain: false });
  });
});

describe('SimulatedMqttAdapter — clearRetained (#65 D6/R1)', () => {
  it('deletes the retained value, so a later subscribe replays nothing', async () => {
    const adapter = new SimulatedMqttAdapter();
    await adapter.publish('layout/test/sensor/s1/reading', { state: 'occupied' }, { retain: true });

    await adapter.clearRetained('layout/test/sensor/s1/reading');

    const handler = vi.fn();
    await adapter.subscribe('layout/test/sensor/s1/reading', handler);
    await new Promise((r) => setImmediate(r));

    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers '' to an already-subscribed handler with retained: false", async () => {
    const adapter = new SimulatedMqttAdapter();
    const handler = vi.fn();
    await adapter.subscribe('layout/test/sensor/s1/reading', handler);

    await adapter.clearRetained('layout/test/sensor/s1/reading');
    await new Promise((r) => setImmediate(r));

    expect(handler).toHaveBeenCalledWith('', 'layout/test/sensor/s1/reading', false);
  });

  it("records { payload: '', qos: 1, retain: true } in publishLog", async () => {
    const adapter = new SimulatedMqttAdapter();

    await adapter.clearRetained('layout/test/sensor/s1/reading');

    expect(adapter.publishLog).toContainEqual(
      expect.objectContaining({ topic: 'layout/test/sensor/s1/reading', payload: '', qos: 1, retain: true }),
    );
  });
});
