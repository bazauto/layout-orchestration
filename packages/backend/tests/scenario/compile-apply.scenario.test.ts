/**
 * Scenario: applying a compiled track graph (#103, `docs/track-graph-compilation.md`).
 *
 * The failure path CLAUDE.md requires alongside the happy one, run through the
 * real `ReservationService`/`LayoutService`/`TopologyService` trio rather than
 * stubs — because the thing being asserted is precisely the interaction between
 * them.
 *
 * Two properties, and they are the whole reason the apply is shaped the way it
 * is:
 *
 * 1. **An apply is refused while any route holds anything in the layout**
 *    (D-E). Not per edge: a compile replaces every row and regenerates every
 *    end label, so a live route's recorded path could be left naming openings
 *    that no longer exist. The per-target guards on `updateEdge`/`deleteEdge`
 *    do not compose into this.
 * 2. **An apply can never Safe-Stop the layout** (D9). `reloadTopology()`
 *    halts a railway when it loads a graph with a fatal violation, so an apply
 *    that wrote first and validated afterwards would turn an authoring action
 *    into a stopped train. Every refusal happens before the write, and the
 *    system stays `online` through all of them.
 */

import { describe, it, expect } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { CompileService } from '../../src/services/CompileService';
import { LockedByRouteError, TopologyRejectedError } from '../../src/services/TopologyService';

const LOCO_3 = {
  id: 'loco-3',
  layoutId: LAYOUT_ID,
  name: 'Loco 3',
  address: 3,
  type: 'diesel',
  maxSpeed: 126,
  brakingFactor: 0.5,
};

const BLOCKS = [
  { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
  { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
  { id: 'b3', layoutId: LAYOUT_ID, name: 'Block 3' },
];
const SENSORS = [
  { id: 's1', layoutId: LAYOUT_ID, name: 'Sensor 1', type: 'block_detection' as const, blockId: 'b1', mqttTopic: `layout/${LAYOUT_ID}/sensor/s1/reading`, inService: true },
  { id: 's2', layoutId: LAYOUT_ID, name: 'Sensor 2', type: 'block_detection' as const, blockId: 'b2', mqttTopic: `layout/${LAYOUT_ID}/sensor/s2/reading`, inService: true },
  { id: 's3', layoutId: LAYOUT_ID, name: 'Sensor 3', type: 'block_detection' as const, blockId: 'b3', mqttTopic: `layout/${LAYOUT_ID}/sensor/s3/reading`, inService: true },
];

/** `b1 -> b2 -> b3`, both directions, as a compiled candidate set. */
const CANDIDATES = [
  { fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west', pointConditions: [] },
  { fromBlockId: 'b2', fromEnd: 'west', toBlockId: 'b1', toEnd: 'east', pointConditions: [] },
  { fromBlockId: 'b2', fromEnd: 'east', toBlockId: 'b3', toEnd: 'west', pointConditions: [] },
  { fromBlockId: 'b3', fromEnd: 'west', toBlockId: 'b2', toEnd: 'east', pointConditions: [] },
];

async function seedAndStart(h: ReturnType<typeof createScenarioHarness>) {
  h.repo._setBlocks(BLOCKS);
  h.repo._setSensors(SENSORS);
  h.repo._setLocos([LOCO_3]);
  await h.start();
  await h.sensorReports('s2', 'clear');
  await h.sensorReports('s3', 'clear');
}

describe('scenario: applying a compiled graph', () => {
  it('1. applies onto an empty graph, and the pathfinder can immediately plan on it', async () => {
    // The migration this issue exists to enable, end to end: `block_edges`
    // starts empty (Westgate Hollow's actual state), the compiled graph is
    // applied, and a route is granted over it without anything else happening
    // in between.
    const h = createScenarioHarness();
    await seedAndStart(h);
    expect(await h.repo.listBlockEdges(LAYOUT_ID)).toEqual([]);

    await h.topologyService.replaceGraph(LAYOUT_ID, CANDIDATES, 'fingerprint-1');

    expect(await h.repo.listBlockEdges(LAYOUT_ID)).toHaveLength(4);
    expect((await h.repo.getCompiledGraph(LAYOUT_ID))?.drawingFingerprint).toBe('fingerprint-1');
    expect(h.service.getSystemStatus().status).toBe('online');

    await h.sensorReports('s1', 'occupied');
    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });

    // `reloadTopology` ran as part of the apply, so the `TrackGraph` the
    // pathfinder searches is the compiled one — no restart, no second step.
    expect(grant.granted).toBe(true);
  });

  it('2. refuses the apply while a route holds the layout, changes nothing, and does not Safe-Stop', async () => {
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.topologyService.replaceGraph(LAYOUT_ID, CANDIDATES, 'fingerprint-1');
    await h.sensorReports('s1', 'occupied');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });
    expect(grant.granted).toBe(true);
    if (!grant.granted) throw new Error('expected grant');

    const before = await h.repo.listBlockEdges(LAYOUT_ID);

    // A different drawing — one edge fewer — offered while the route is live.
    await expect(
      h.topologyService.replaceGraph(LAYOUT_ID, CANDIDATES.slice(0, 2), 'fingerprint-2'),
    ).rejects.toThrow(LockedByRouteError);

    // Nothing moved: the graph the route was planned over is intact, ids and
    // all, and the recorded provenance still names the drawing it came from.
    const after = await h.repo.listBlockEdges(LAYOUT_ID);
    expect(after.map((e) => e.id).sort()).toEqual(before.map((e) => e.id).sort());
    expect((await h.repo.getCompiledGraph(LAYOUT_ID))?.drawingFingerprint).toBe('fingerprint-1');

    // The route still holds everything it held.
    const state = h.service.getAllState();
    expect(state.blocks.get('b1')?.lockedByRoute).toBe(grant.reservation.id);
    expect(state.blocks.get('b3')?.lockedByRoute).toBe(grant.reservation.id);

    // And the refusal is an ordinary rejection, not a halt.
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('3. allows the apply once the route is cancelled — an ordering requirement, not a deadlock', async () => {
    // The operator is never stuck: cancel is always available, so "cancel the
    // route, then edit" is a sequence, not a wall.
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.topologyService.replaceGraph(LAYOUT_ID, CANDIDATES, 'fingerprint-1');
    await h.sensorReports('s1', 'occupied');

    const grant = await h.service.requestRoute({
      locoAddress: 3,
      authority: 'manual',
      startBlockId: 'b1',
      path: { kind: 'destination', destinationBlockId: 'b3' },
    });
    if (!grant.granted) throw new Error('expected grant');

    await h.service.cancelRoute(grant.reservation.id, 'making way for a recompile');

    await h.topologyService.replaceGraph(LAYOUT_ID, CANDIDATES.slice(0, 2), 'fingerprint-2');

    expect(await h.repo.listBlockEdges(LAYOUT_ID)).toHaveLength(2);
    expect((await h.repo.getCompiledGraph(LAYOUT_ID))?.drawingFingerprint).toBe('fingerprint-2');
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('4. refuses an invalid candidate graph without writing, and the layout stays online', async () => {
    // The never-write-then-discover assertion at the scenario level. An
    // `unknown-block` violation is fatal on reload: had this set been written
    // and rejected afterwards, the layout would have Safe-Stopped as a direct
    // result of an authoring action, which is exactly what D9 forbids.
    const h = createScenarioHarness();
    await seedAndStart(h);
    await h.topologyService.replaceGraph(LAYOUT_ID, CANDIDATES, 'fingerprint-1');

    await expect(
      h.topologyService.replaceGraph(
        LAYOUT_ID,
        [
          ...CANDIDATES,
          { fromBlockId: 'b3', fromEnd: 'east', toBlockId: 'b-deleted', toEnd: 'west', pointConditions: [] },
        ],
        'fingerprint-bad',
      ),
    ).rejects.toThrow(TopologyRejectedError);

    expect(await h.repo.listBlockEdges(LAYOUT_ID)).toHaveLength(4);
    expect((await h.repo.getCompiledGraph(LAYOUT_ID))?.drawingFingerprint).toBe('fingerprint-1');
    expect(h.service.getSystemStatus().status).toBe('online');
  });

  it('5. refuses an apply whose fingerprint does not match the drawing as it stands', async () => {
    // D10's time-of-check/time-of-use guard, through `CompileService` rather
    // than `TopologyService`: the drawing here is empty, so any fingerprint the
    // caller supplies is one it did not come from.
    const h = createScenarioHarness();
    await seedAndStart(h);
    const compileService = new CompileService(h.repo, h.topologyService);

    await expect(compileService.apply(LAYOUT_ID, 'a-fingerprint-from-another-drawing')).rejects.toThrow(
      /drawing has changed/i,
    );

    expect(await h.repo.listBlockEdges(LAYOUT_ID)).toEqual([]);
    await expect(h.repo.getCompiledGraph(LAYOUT_ID)).resolves.toBeNull();
    expect(h.service.getSystemStatus().status).toBe('online');
  });
});
