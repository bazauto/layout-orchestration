/**
 * Scenario: the command-station link (#148, see `docs/dcc-link.md`).
 *
 * The issue in one sentence: `SerialDccAdapter` was write-only, so `isConnected()`
 * reported on a USB device node and nothing else. A station that had cut track
 * power, entered maintenance mode, rebooted, or simply stopped listening looked
 * identical to a healthy one, and the orchestrator went on granting routes over
 * a dark layout while reporting itself online.
 *
 * Case 1 is the regression this whole change exists for: the port stays open,
 * the station stops answering, and the layout must Safe-Stop. Case 4 is the one
 * that would have caught #147 on the first hardware run.
 *
 * Exercised end to end through the real `SimulatedDccAdapter` and
 * `LayoutService` on the harness's shared `ManualClock` — the status probe runs
 * on that clock, so `advance()` is what makes the station go silent here. No
 * real time passes.
 *
 * Fixture: one block, one point, one loco. The track graph is incidental —
 * every case here is about the link, not about where a train is.
 */

import { describe, expect, it } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { DCC_LINK_TIMEOUT_MS, DCC_PROBE_INTERVAL_MS } from '../../src/domain/dccLink';

const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
];

const POINTS = [
  {
    id: 'p1',
    layoutId: LAYOUT_ID,
    name: 'Point 1',
    dccAddress: 12,
    positionFeedback: 'none' as const,
  },
];

const LOCOS = [{ address: 3, layoutId: LAYOUT_ID, name: 'Loco 3', maxSpeed: 126 }];

async function seedAndStart(h: ReturnType<typeof createScenarioHarness>) {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints(POINTS);
  h.repo._setSensors([]);
  h.repo._setLocos(LOCOS);
  await h.start();
}

describe('scenario: the DCC command-station link', () => {
  it('1. Safe-Stops when the station stops answering, with the port still open', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getDccLink().responsive).toBe(true);

    // The station goes quiet. Nothing about the serial port changes — this is
    // precisely the state `isConnected()` cannot see.
    h.dcc.goSilent();
    expect(h.dcc.isConnected()).toBe(true);

    await h.advance(DCC_LINK_TIMEOUT_MS + DCC_PROBE_INTERVAL_MS);

    const status = h.service.getSystemStatus();
    expect(status.status).toBe('safe-stop');
    expect(status.reason).toMatch(/command station has not answered/i);
    expect(h.service.getDccLink().fault).toMatchObject({ kind: 'link-lost' });
  });

  it('2. comes back when the station starts answering again, and keeps the latch until acknowledged', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    h.dcc.goSilent();
    await h.advance(DCC_LINK_TIMEOUT_MS + DCC_PROBE_INTERVAL_MS);
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    h.dcc.goSilent(false);
    await h.advance(DCC_PROBE_INTERVAL_MS);

    // Answering again clears `responsive` — but the latched fault holds the
    // Safe-Stop, exactly like every other latch in `SystemHealth`. A layout
    // does not quietly resume because a fault stopped repeating.
    expect(h.service.getDccLink().responsive).toBe(true);
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    await h.service.acknowledgeDccLinkFault();
    expect(h.service.getDccLink().fault).toBeNull();
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('3. faults the route whose throttle command the station rejected', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    // A rejection with no route behind it latches on the link instead — this is
    // a manual throttle, so that is what should happen.
    h.dcc.rejectNext();
    await h.service.handleThrottleCommand({ locoAddress: 3, speed: 40, direction: 'fwd' });

    expect(h.service.getDccLink().fault).toMatchObject({
      kind: 'command-rejected',
      locoAddress: 3,
    });
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
  });

  it('4. Safe-Stops when the station acknowledges a command against the wrong loco', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    // #147 as the wire would have shown it: we address loco 3, the station
    // says it moved loco 1. Nothing else in the system can observe this.
    h.dcc.acknowledgeNextAs(1);
    await h.service.handleThrottleCommand({ locoAddress: 3, speed: 40, direction: 'fwd' });

    const link = h.service.getDccLink();
    expect(link.fault).toMatchObject({ kind: 'cab-mismatch', locoAddress: 3 });
    expect(link.fault?.reason).toMatch(/loco 1 for a command addressed to loco 3/);
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
  });

  it('5. Safe-Stops on an unprompted identity banner — the station rebooted', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    // A restarted station has forgotten every loco and brings both tracks up
    // dark. Nothing in a USB device node reports that.
    h.dcc.simulateRestart('deadbee');

    const link = h.service.getDccLink();
    expect(link.restartCount).toBe(1);
    expect(link.fault).toMatchObject({ kind: 'station-restarted' });
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
  });

  it('6. records track power without gating on it — that is #149, not this issue', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    h.dcc.setSimulatedPower('main', false);

    expect(h.service.getDccLink().mainPowerOn).toBe(false);
    // Deliberately still online: #148 observes power, #149 acts on it. Do not
    // "fix" this test by making a dark track Safe-Stop — a dark track is
    // already stopped, and the recovery control does not exist yet.
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('7. learns the station identity on start, and keeps probing without crying restart', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    expect(h.service.getDccLink().identity).toMatchObject({ product: 'PICODCC-SIM' });
    const probesAfterStart = h.dcc.probeCount;
    expect(probesAfterStart).toBeGreaterThan(0);

    await h.advance(DCC_PROBE_INTERVAL_MS * 4);

    expect(h.dcc.probeCount).toBeGreaterThan(probesAfterStart);
    expect(h.service.getDccLink().restartCount).toBe(0);
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('8. acknowledging a fault while the station is still silent does not resume the layout', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    h.dcc.goSilent();
    await h.advance(DCC_LINK_TIMEOUT_MS + DCC_PROBE_INTERVAL_MS);
    await h.service.acknowledgeDccLinkFault();

    // The latch is gone but the evidence is not: `responsive` is still false,
    // so Safe-Stop holds. An acknowledgement cannot outrun the world.
    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getDccLink().responsive).toBe(false);
  });

  it('9. a point command the station rejects latches against the point that did not move', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    h.dcc.rejectNext();
    await h.commandPoint('p1', 'reverse');

    expect(h.service.getDccLink().fault).toMatchObject({
      kind: 'command-rejected',
      pointId: 'p1',
    });
  });
});
