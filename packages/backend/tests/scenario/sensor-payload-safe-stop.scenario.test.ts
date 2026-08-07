/**
 * Scenario: a malformed sensor payload triggers Safe-Stop.
 *
 * Covers the failure path required whenever safety/routing/occupancy logic
 * changes (see CLAUDE.md Testing expectations). Per mqtt-contract.md
 * §Fail-Safe Triggers item 3 and CLAUDE.md safety rule 3, a payload on a
 * sensor topic that fails Zod validation is a Safe-Stop trigger, not a
 * logged warning — a sensor that starts sending garbage must be treated the
 * same as one that has silently stopped, since both leave occupancy state
 * unknown and un-trustworthy (see #27).
 */

import { describe, it, expect, vi } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { LayoutEvent } from '../../src/domain/types';

function lastSystemStatusEvent(events: LayoutEvent[]) {
  const statusEvents = events.filter(
    (e): e is Extract<LayoutEvent, { type: 'SYSTEM_STATUS' }> => e.type === 'SYSTEM_STATUS',
  );
  return statusEvents[statusEvents.length - 1];
}

describe('scenario: malformed sensor payload triggers Safe-Stop', () => {
  it('processes valid readings normally, then Safe-Stops immediately on the first malformed one, halting automated movement without mutating block state', async () => {
    const h = createScenarioHarness();
    h.repo._setBlocks([{ id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' }]);
    vi.mocked(h.repo.listSensors).mockResolvedValue([
      {
        id: 's1',
        layoutId: LAYOUT_ID,
        name: 'Sensor 1',
        type: 'block_detection',
        blockId: 'b1',
        mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`,
      },
    ]);

    await h.start();
    expect(h.service.getSystemStatus().status).toBe('online');

    // A stream of valid readings behaves normally — the failure path below
    // must not be the only path exercised.
    h.mqtt.simulateIncoming(`layout/${LAYOUT_ID}/sensor/s1/reading`, {
      state: 'occupied',
      updatedAt: new Date().toISOString(),
    });
    await new Promise((r) => setImmediate(r));
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('occupied');

    h.mqtt.simulateIncoming(`layout/${LAYOUT_ID}/sensor/s1/reading`, {
      state: 'clear',
      updatedAt: new Date().toISOString(),
    });
    await new Promise((r) => setImmediate(r));
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('clear');

    // Give a loco manual/auto authority to make "automated movement halted"
    // observable via the emitted LOCO_STATE, not just the system status.
    await h.service.handleThrottleCommand({ locoAddress: 3, speed: 60, direction: 'fwd' });
    expect(h.service.getAllState().locos.get(3)?.speed).toBe(60);

    // The malformed reading — trips on the FIRST occurrence, no tolerance.
    h.mqtt.simulateIncoming(`layout/${LAYOUT_ID}/sensor/s1/reading`, { garbage: true });
    await new Promise((r) => setImmediate(r));

    const status = h.service.getSystemStatus();
    expect(status.status).toBe('safe-stop');
    expect(status.reason).toMatch(/s1/);
    expect(status.reason).toMatch(new RegExp(`sensor/s1/reading`));

    // Block state is exactly what the last VALID reading set it to — the
    // malformed message must never reach stateManager.updateBlockOccupancy.
    expect(h.service.getAllState().blocks.get('b1')?.occupancy).toBe('clear');

    // Automated movement has halted: Safe-Stop stops every loco.
    expect(h.service.getAllState().locos.get(3)?.speed).toBe(0);
    expect(h.service.getAllState().locos.get(3)?.direction).toBe('stop');

    const statusEvent = lastSystemStatusEvent(h.events);
    expect(statusEvent?.payload.status).toBe('safe-stop');
    expect(statusEvent?.payload.reason).toMatch(/s1/);

    await h.service.stop();
  });

  it('stays Safe-Stopped on a subsequent unrelated health re-evaluation (an MQTT reconnect must not silently clear a sensor-fault Safe-Stop)', async () => {
    const h = createScenarioHarness();
    h.repo._setBlocks([{ id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' }]);
    vi.mocked(h.repo.listSensors).mockResolvedValue([
      {
        id: 's1',
        layoutId: LAYOUT_ID,
        name: 'Sensor 1',
        type: 'block_detection',
        blockId: 'b1',
        mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`,
      },
    ]);

    await h.start();

    h.mqtt.simulateIncoming(`layout/${LAYOUT_ID}/sensor/s1/reading`, { garbage: true });
    await new Promise((r) => setImmediate(r));
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    // Simulate an MQTT reconnect blip — connection health alone would say
    // "all clear", but the latched sensor fault must still hold the line.
    h.mqtt.disconnect();
    await h.mqtt.connect();
    await new Promise((r) => setImmediate(r));

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toMatch(/s1/);

    await h.service.stop();
  });
});
