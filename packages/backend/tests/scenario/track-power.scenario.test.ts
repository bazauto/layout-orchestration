/**
 * Scenario: track power (#149, see `docs/dcc-link.md`).
 *
 * Two failures, one channel.
 *
 * **A cold start into dead rails.** PicoDCC's tracks come up unpowered —
 * `PicoDccTrack`'s constructor drives the power pin low, and power turns on only
 * in response to `<1>`. Nothing ever sent one. The orchestrator connected,
 * reported the DCC leg healthy, accepted route requests, and issued throttle
 * commands into rails with no current on them.
 *
 * **A cutoff with no way back.** The station cuts power itself on a timing
 * violation, a PIO failure, or a Core 1 heartbeat failure. Power then stays off
 * until something sends `<1>`, and since nothing did, the only recovery was
 * power-cycling the command station — the one thing an operator standing at the
 * screen cannot do.
 *
 * The line every case here draws: **track power off is not a Safe-Stop.** The
 * layout is already stopped, by the most complete means there is. It refuses new
 * routes and abandons automation, and it latches nothing.
 *
 * Fixture: two blocks, one edge, one loco, sensors on both blocks. Exercised
 * through the real `SimulatedDccAdapter` and `LayoutService`.
 */

import { describe, expect, it } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { GrantRequest } from '../../src/services/ReservationService';

const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
];

const LOCOS = [{ address: 3, layoutId: LAYOUT_ID, name: 'Loco 3', maxSpeed: 126 }];

const SENSORS = [
  {
    id: 's1',
    layoutId: LAYOUT_ID,
    name: 'Sensor 1',
    type: 'block_detection' as const,
    blockId: 'b1',
    mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`,
    inService: true,
  },
  {
    id: 's2',
    layoutId: LAYOUT_ID,
    name: 'Sensor 2',
    type: 'block_detection' as const,
    blockId: 'b2',
    mqttTopic: `layout/${LAYOUT_ID}/sensor/s2/reading`,
    inService: true,
  },
];

async function seedAndStart(h: ReturnType<typeof createScenarioHarness>) {
  h.repo._setBlocks(BLOCKS);
  h.repo._setPoints([]);
  h.repo._setSensors(SENSORS);
  h.repo._setLocos(LOCOS);
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
  await h.sensorReports('s1', 'occupied');
  await h.sensorReports('s2', 'clear');
}

async function requestRoute(h: ReturnType<typeof createScenarioHarness>) {
  const edges = await h.repo.listBlockEdges(LAYOUT_ID);
  const e1 = edges.find((e) => e.fromBlockId === 'b1' && e.toBlockId === 'b2')!;
  const request: GrantRequest = {
    locoAddress: 3,
    authority: 'manual',
    startBlockId: 'b1',
    path: { kind: 'edges', edgeIds: [e1.id] },
  };
  return h.service.requestRoute(request);
}

describe('scenario: track power (#149)', () => {
  it('1. commands power on when the link comes up — a cold start no longer runs into dead rails', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    // The command went out...
    expect(h.dcc.commandLog.some((c) => c.type === 'SET_TRACK_POWER' && c.data.on === true)).toBe(
      true,
    );
    // ...and, more to the point, the station's ANSWER is what we believe.
    // `setTrackPower` probes afterwards precisely so this is the reported state
    // rather than the requested one (docs/dcc-link.md D12).
    expect(h.service.getDccLink().mainPowerOn).toBe(true);
    expect(h.service.getSystemStatus().status).toBe('online');

    await h.service.stop();
  });

  it('2. a station-side cutoff is observed, refuses new routes, and does NOT Safe-Stop', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    expect((await requestRoute(h)).granted).toBe(true);

    // The station cuts power on a fault and says so — PicoDCC#4's <p0 MAIN>.
    h.dcc.setSimulatedPower('main', false);

    expect(h.service.getDccLink().mainPowerOn).toBe(false);

    // Not a Safe-Stop. The layout is already stopped, and calling that an
    // emergency would mean an operator who switched power off to re-rail a
    // wagon came back to a system needing acknowledgement.
    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getRouteFaults()).toEqual([]);

    await h.service.stop();
  });

  it('3. a route requested while the layout is dark is refused, and the refusal says what to do about it', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    h.dcc.setSimulatedPower('main', false);

    const outcome = await requestRoute(h);
    expect(outcome.granted).toBe(false);
    if (outcome.granted) throw new Error('unreachable');
    expect(outcome.rejections).toEqual([{ kind: 'track-power-off' }]);

    await h.service.stop();
  });

  it('4. an operator can switch power back on from the orchestrator — the recovery path that used to need a power cycle', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    h.dcc.setSimulatedPower('main', false);
    expect((await requestRoute(h)).granted).toBe(false);

    h.dcc.clearLog();
    await h.service.setTrackPower(true);

    expect(h.dcc.commandLog.some((c) => c.type === 'SET_TRACK_POWER' && c.data.on === true)).toBe(
      true,
    );
    expect(h.service.getDccLink().mainPowerOn).toBe(true);

    // ...and routing works again, with no acknowledgement of anything, because
    // nothing was ever latched.
    expect((await requestRoute(h)).granted).toBe(true);

    await h.service.stop();
  });

  it('5. an operator switching power off is an ordinary operating state, not a fault', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    await h.service.setTrackPower(false);

    expect(h.service.getDccLink().mainPowerOn).toBe(false);
    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getDccLink().fault).toBeNull();
    expect(h.service.getRouteFaults()).toEqual([]);

    // The layout is refused to new traffic while it is dark, which is the whole
    // difference between "already stopped" and "safe to route over".
    expect((await requestRoute(h)).granted).toBe(false);

    await h.service.stop();
  });

  it('6. an existing route keeps its locks in the dark — another train must not be routed over track this one is standing on', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    const outcome = await requestRoute(h);
    if (!outcome.granted) throw new Error('expected grant');
    const routeId = outcome.reservation.id;

    h.dcc.setSimulatedPower('main', false);

    // Still active, still holding. Power is not a reason to release track a
    // train may be standing on — if anything it is a reason not to, since the
    // train cannot be moved off it.
    expect(h.service.listRoutes(['active']).map((r) => r.id)).toContain(routeId);
    expect(h.service.getAllState().blocks.get('b1')?.lockedByRoute).toBe(routeId);
    expect(h.service.getAllState().blocks.get('b2')?.lockedByRoute).toBe(routeId);

    await h.service.stop();
  });

  it('7. power coming back does not re-report itself as a loss — the transition is edge-triggered', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    h.dcc.setSimulatedPower('main', false);
    h.dcc.setSimulatedPower('main', true);
    h.dcc.setSimulatedPower('main', true); // A repeat of the same state changes nothing

    expect(h.service.getDccLink().mainPowerOn).toBe(true);
    expect(h.service.getSystemStatus().status).toBe('online');
    expect((await requestRoute(h)).granted).toBe(true);

    await h.service.stop();
  });
});
