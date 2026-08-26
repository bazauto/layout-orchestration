/**
 * Scenario: track power (#149, #180, see `docs/dcc-link.md`).
 *
 * **A cutoff with no way back** is the failure #149 closed. The station cuts
 * power itself on a timing violation, a PIO failure, or a Core 1 heartbeat
 * failure. Power then stays off until something sends `<1 MAIN>`, and since
 * nothing did, the only recovery was power-cycling the command station — the one
 * thing an operator standing at the screen cannot do.
 *
 * **Nothing commands power automatically** (#180). #149 also sent `<1>` when the
 * link came up, on the argument that PicoDCC's tracks come up unpowered and a
 * cold start would otherwise run into dead rails. In service that meant the
 * layout came to life on every deploy, because a deploy restarts the unit. Cases
 * 1 and 2 below hold the line that connect *observes* power and never asserts
 * it; the observation is what stops a dark layout being routed over, which is
 * the half of #149 that was actually doing the safety work.
 *
 * The line every other case draws: **track power off is not a Safe-Stop.** The
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

describe('scenario: track power (#149, #180)', () => {
  it('1. the link coming up does not command power — a deploy restart must not bring the layout to life', async () => {
    const h = createScenarioHarness();
    // The station is dark before the orchestrator ever connects: a station that
    // cut power on a fault, or one an operator switched off and walked away
    // from. Either way, restarting the service is not consent to re-energise
    // the rails (#180).
    h.dcc.setSimulatedPower('main', false);
    await seedAndStart(h);

    expect(h.dcc.commandLog.some((c) => c.type === 'SET_TRACK_POWER')).toBe(false);
    expect(h.service.getDccLink().mainPowerOn).toBe(false);

    // Still not a Safe-Stop, and still nothing latched. A dark layout is an
    // operating state, whatever put it there.
    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getDccLink().fault).toBeNull();

    // The gate #149 built is what does the safety work: no route over rails
    // nobody has said are live.
    expect((await requestRoute(h)).granted).toBe(false);

    await h.service.stop();
  });

  it('2. but it does OBSERVE power, so the state is known before the first route is judged', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    // A live station, un-commanded. `start()` probes immediately for exactly
    // this reason, so `mainPowerOn` is the station's reported state and not the
    // never-observed `null` that refuses nothing (D10).
    expect(h.dcc.commandLog.some((c) => c.type === 'SET_TRACK_POWER')).toBe(false);
    expect(h.dcc.probeCount).toBeGreaterThan(0);
    expect(h.service.getDccLink().mainPowerOn).toBe(true);
    expect(h.service.getSystemStatus().status).toBe('online');
    expect((await requestRoute(h)).granted).toBe(true);

    await h.service.stop();
  });

  it('3. an operator commands the MAIN track only — the programming track is never written', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    expect(h.service.getDccLink().progPowerOn).toBe(true);

    await h.service.setTrackPower(false);

    // Main follows the command; prog is left exactly where the station had it.
    // It belongs to a service-mode process that does not exist yet, and this
    // orchestrator does not get to switch it as a side effect (#180).
    expect(h.service.getDccLink().mainPowerOn).toBe(false);
    expect(h.service.getDccLink().progPowerOn).toBe(true);

    await h.service.stop();
  });

  it('4. every move of the link view is PUSHED to connected clients (#179)', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    h.events.length = 0;

    await h.service.setTrackPower(false);
    h.dcc.setSimulatedPower('main', true);

    // The regression this closes: `dccLink` used to reach the browser only in
    // the opening `STATE_SNAPSHOT`, so an operator switched power off and went
    // on being shown "on", then switched it back on and was shown "off" over
    // live rails. The badge only ever moved when the socket reconnected.
    const pushed = h.events
      .filter((e) => e.type === 'DCC_LINK')
      .map((e) => (e as { payload: { mainPowerOn: boolean | null } }).payload.mainPowerOn);
    expect(pushed).toEqual([false, true]);

    // A repeat of a state already held pushes nothing — the event is edge
    // triggered on `healthChanged`, not a re-broadcast of the current value.
    h.events.length = 0;
    h.dcc.setSimulatedPower('main', true);
    expect(h.events.filter((e) => e.type === 'DCC_LINK')).toEqual([]);

    await h.service.stop();
  });

  it('5. a station-side cutoff is observed, refuses new routes, and does NOT Safe-Stop', async () => {
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

  it('6. a route requested while the layout is dark is refused, and the refusal says what to do about it', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);

    h.dcc.setSimulatedPower('main', false);

    const outcome = await requestRoute(h);
    expect(outcome.granted).toBe(false);
    if (outcome.granted) throw new Error('unreachable');
    expect(outcome.rejections).toEqual([{ kind: 'track-power-off' }]);

    await h.service.stop();
  });

  it('7. an operator can switch power back on from the orchestrator — the recovery path that used to need a power cycle', async () => {
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

  it('8. an operator switching power off is an ordinary operating state, not a fault', async () => {
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

  it('9. an existing route keeps its locks in the dark — another train must not be routed over track this one is standing on', async () => {
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

  it('10. power coming back does not re-report itself as a loss — the transition is edge-triggered', async () => {
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
