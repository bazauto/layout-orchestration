/**
 * Scenario: sensor liveness and retained-reading trust (#28, see
 * `docs/sensor-trust.md`).
 *
 * The issue in one sentence: a controller dies while its last published
 * reading was `clear`, and because `sensor/*\/reading` is retained, the broker
 * replays that `clear` to every future subscriber — including a backend that
 * has just restarted and has no other information about that block. Before
 * this work the backend believed it and reported live, empty track.
 *
 * Case 1 is the regression test the whole change exists for. Case 7 is the
 * same failure in its other disguise (a broker reconnect rather than a backend
 * restart) and is the one most likely to come back.
 *
 * Exercised end to end through the real `SimulatedMqttAdapter` and
 * `LayoutService`, on the harness's shared `ManualClock` — the trust sweep
 * runs on that clock, so `advance()` is what makes a sensor go stale here. No
 * real time passes.
 *
 * Fixture:
 *
 *   b1 --e1--> b2
 *
 * b1 carries a block_detection sensor (s1); b2 carries s2. A detector is used
 * deliberately rather than an IR beam: only a `block_detection` sensor may
 * assert `clear` (`deriveBlockOccupancy` clause 2), so it is the only sensor
 * type that can express the bug at all.
 */

import { describe, it, expect } from 'vitest';
import {
  createScenarioHarness,
  LAYOUT_ID,
  SENSOR_FRESHNESS_TIMEOUT_MS,
  SENSOR_REASSERT_MS,
  SENSOR_TRUST_SWEEP_MS,
} from './harness';

const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
];

const SENSORS = [
  { id: 's1', layoutId: LAYOUT_ID, name: 'Sensor 1 (detector)', type: 'block_detection' as const, blockId: 'b1', mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`, inService: true },
  { id: 's1b', layoutId: LAYOUT_ID, name: 'Sensor 1b (detector)', type: 'block_detection' as const, blockId: 'b1', mqttTopic: `layout/${LAYOUT_ID}/sensor/s1b/reading`, inService: true },
  { id: 's2', layoutId: LAYOUT_ID, name: 'Sensor 2 (detector)', type: 'block_detection' as const, blockId: 'b2', mqttTopic: `layout/${LAYOUT_ID}/sensor/s2/reading`, inService: true },
];

async function seedAndStart(h: ReturnType<typeof createScenarioHarness>) {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints([]);
  h.repo._setSensors(SENSORS);
  h.repo._setLocos([]);
  await h.repo.createBlockEdge({
    layoutId: LAYOUT_ID,
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [],
    lengthMm: null,
  });
  await h.start();
}

const occupancyOf = (h: ReturnType<typeof createScenarioHarness>, blockId: string) =>
  h.service.getAllState().blocks.get(blockId)?.occupancy;

const trustOf = (h: ReturnType<typeof createScenarioHarness>, sensorId: string) =>
  h.service.getAllState().sensors.get(sensorId)?.trusted;

describe('sensor liveness (#28)', () => {
  it("case 1 — the #28 case: a dead sensor's retained 'clear' is replayed and NEVER believed", async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    // The sensor published `clear` and then died. The broker still holds that
    // value, and delivers it to us with the RETAIN flag set the moment we
    // subscribe. This is exactly what a backend restart looks like from here.
    await h.sensorReports('s1', 'clear', { retained: true });

    // Recorded — the reading is not thrown away, it is just not evidence.
    expect(h.service.getAllState().sensors.get('s1')?.lastReading).toBe('clear');
    expect(h.service.getAllState().sensors.get('s1')?.lastLiveReadingAt).toBeNull();
    expect(trustOf(h, 's1')).toBe(false);

    // ...and the block is `unknown`, not `clear`. Before #28 this read
    // `clear`, and the system would have granted a route over track it had
    // no live information about at all.
    expect(occupancyOf(h, 'b1')).toBe('unknown');

    // No re-assert ever follows, because the controller is off. Well past
    // the freshness window it is still `unknown` — which is the truth, and
    // stays the truth indefinitely rather than ageing into a guess.
    await h.advance(SENSOR_FRESHNESS_TIMEOUT_MS * 3);
    expect(occupancyOf(h, 'b1')).toBe('unknown');
    expect(trustOf(h, 's1')).toBe(false);
  });

  it('case 2 — a live sensor that re-asserts on the contract interval stays trusted across many sweeps', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    // Same start as case 1: the retained replay arrives first and is not
    // believed. The difference is that this controller is alive.
    await h.sensorReports('s1', 'clear', { retained: true });
    expect(occupancyOf(h, 'b1')).toBe('unknown');

    // Its first live re-assert promotes it, without waiting for a sweep.
    await h.sensorReports('s1', 'clear');
    expect(occupancyOf(h, 'b1')).toBe('clear');

    // And it stays clear while the firmware keeps its side of the contract.
    for (let i = 0; i < 10; i += 1) {
      await h.advance(SENSOR_REASSERT_MS);
      await h.sensorReports('s1', 'clear');
      expect(occupancyOf(h, 'b1')).toBe('clear');
    }
    expect(trustOf(h, 's1')).toBe(true);
  });

  it('case 3 — a live sensor that goes silent ages out to unknown, and SAYS so', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'clear');
    expect(occupancyOf(h, 'b1')).toBe('clear');

    const events: string[] = [];
    h.service.on('event', (e: { type: string; payload?: unknown }) => {
      if (e.type === 'BLOCK_STATE') events.push(JSON.stringify(e.payload));
    });

    // One sweep short of the window: still fresh. The boundary is
    // "strictly greater than the timeout is stale" (D11).
    await h.advance(SENSOR_FRESHNESS_TIMEOUT_MS - SENSOR_TRUST_SWEEP_MS);
    expect(occupancyOf(h, 'b1')).toBe('clear');

    // Past it: degraded. The sweep is what notices — nothing arrived to
    // trigger this, which is the entire reason it cannot be evaluated lazily
    // on read (D8).
    await h.advance(SENSOR_TRUST_SWEEP_MS * 2);
    expect(trustOf(h, 's1')).toBe(false);
    expect(occupancyOf(h, 'b1')).toBe('unknown');

    // Visible to the operator rather than silent. A push-based UI that is
    // never told has no other way to find out.
    expect(events.some((e) => e.includes('"blockId":"b1"') && e.includes('"occupancy":"unknown"'))).toBe(true);
  });

  it('case 4 — recovery needs no operator action: one live reading restores it', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'occupied');
    await h.advance(SENSOR_FRESHNESS_TIMEOUT_MS * 2);
    expect(occupancyOf(h, 'b1')).toBe('unknown');

    // The controller comes back. Nothing is acknowledged, nothing is reset —
    // a stale sensor is not a fault, and there is no latch to clear.
    await h.sensorReports('s1', 'occupied');
    expect(trustOf(h, 's1')).toBe(true);
    expect(occupancyOf(h, 'b1')).toBe('occupied');
  });

  it('case 5 — a stale sensor stops contributing; it does NOT poison a block another live detector still covers', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    await h.sensorReports('s1', 'clear');
    await h.sensorReports('s1b', 'clear');
    expect(occupancyOf(h, 'b1')).toBe('clear');

    // s1b keeps re-asserting; s1 dies.
    for (let i = 0; i < 4; i += 1) {
      await h.advance(SENSOR_REASSERT_MS);
      await h.sensorReports('s1b', 'clear');
    }
    expect(trustOf(h, 's1')).toBe(false);
    expect(trustOf(h, 's1b')).toBe(true);

    // The block is still `clear`, and this is the decision worth pinning
    // (D9). #28's original plan specified the opposite — "any untrusted
    // sensor poisons the block to unknown" — but that was written before
    // #34 built the derivation, and #34 had already settled the same
    // question for a *faulted* sensor: it contributes nothing and poisons
    // nothing, because a `block_detection` sensor is a whole-block monitor
    // entitled to assert the block is empty on its own.
    //
    // Making silence poison while a device actively publishing garbage does
    // not would be an inconsistency pointing the wrong way. An untrusted
    // sensor is simply ineligible, exactly as a faulted or out-of-service one
    // is.
    expect(occupancyOf(h, 'b1')).toBe('clear');

    // What DOES degrade the block is losing its last trusted detector — the
    // common case, and the #28 case.
    await h.advance(SENSOR_FRESHNESS_TIMEOUT_MS * 2);
    expect(trustOf(h, 's1b')).toBe(false);
    expect(occupancyOf(h, 'b1')).toBe('unknown');

    // A stale sensor returning with a train reasserts occupancy outright:
    // positive evidence beats the absence of it (clause 1).
    await h.sensorReports('s1', 'occupied');
    expect(occupancyOf(h, 'b1')).toBe('occupied');
  });

  it('case 6 — a retained reading cannot refresh a sensor that has gone stale', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.sensorReports('s1', 'clear');
    await h.advance(SENSOR_FRESHNESS_TIMEOUT_MS * 2);
    expect(occupancyOf(h, 'b1')).toBe('unknown');

    // A reconnect replays the broker's archived copy. It must not read as
    // the sensor having come back: the value is the same one that went
    // stale, delivered by the broker rather than by the device.
    await h.sensorReports('s1', 'clear', { retained: true });
    expect(trustOf(h, 's1')).toBe(false);
    expect(occupancyOf(h, 'b1')).toBe('unknown');
  });

  it('case 7 — broker reconnect: a replayed retained clear does not silently restore track', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    await h.sensorReports('s1', 'clear');
    await h.sensorReports('s2', 'clear');
    expect(occupancyOf(h, 'b1')).toBe('clear');
    expect(occupancyOf(h, 'b2')).toBe('clear');

    // Broker drops — existing behaviour, Safe-Stop (docs/mqtt-contract.md
    // Fail-Safe Trigger 1). Unchanged by this work.
    await h.mqtt.disconnect();
    await new Promise((r) => setImmediate(r));

    // While we were disconnected, s1's controller died. On reconnect the
    // broker replays BOTH retained readings with RETAIN set — it cannot tell
    // us which publisher is still alive, and neither can the message.
    await h.mqtt.connect();
    await new Promise((r) => setImmediate(r));
    await h.sensorReports('s1', 'clear', { retained: true });
    await h.sensorReports('s2', 'clear', { retained: true });

    // A brief blip changes nothing, and that is deliberate. Trust is a
    // property of the DEVICE, not of the connection: a sensor heard from live
    // two seconds ago is still fresh two seconds later, whatever the broker
    // did in between. A reconnect that flapped every block to `unknown` would
    // be a nuisance degrade, and nuisance degrades are what operators learn to
    // ignore. The retained replay neither promotes nor demotes anything.
    expect(trustOf(h, 's1')).toBe(true);
    expect(occupancyOf(h, 'b1')).toBe('clear');

    // Now the outage that actually matters. Nothing arrives from either
    // controller while it lasts — and the sweep keeps running on its own
    // clock, so both age out with no special case for "we were disconnected".
    await h.advance(SENSOR_FRESHNESS_TIMEOUT_MS * 2);
    expect(occupancyOf(h, 'b1')).toBe('unknown');
    expect(occupancyOf(h, 'b2')).toBe('unknown');

    // The broker comes back and replays both retained readings, exactly as it
    // did above. This is case 1 in its other disguise, and the regression
    // most likely to come back: a replayed `clear` must not restore track.
    await h.mqtt.disconnect();
    await h.mqtt.connect();
    await new Promise((r) => setImmediate(r));
    await h.sensorReports('s1', 'clear', { retained: true });
    await h.sensorReports('s2', 'clear', { retained: true });

    expect(trustOf(h, 's1')).toBe(false);
    expect(trustOf(h, 's2')).toBe(false);
    expect(occupancyOf(h, 'b1')).toBe('unknown');
    expect(occupancyOf(h, 'b2')).toBe('unknown');

    // ...and then the two diverge on the evidence: s2 re-asserts live and
    // comes back, s1's controller is dead and never does. The two were
    // indistinguishable at the moment of reconnect and are told apart by what
    // happens next — which is the whole mechanism in one assertion pair.
    await h.sensorReports('s2', 'clear');
    expect(occupancyOf(h, 'b2')).toBe('clear');
    expect(occupancyOf(h, 'b1')).toBe('unknown');
  });
});
