/**
 * Scenario: invalid track topology triggers Safe-Stop.
 *
 * Covers the failure path required whenever safety/routing/occupancy logic
 * changes (see CLAUDE.md Testing expectations) — an invalid `block_edges`
 * set must never silently produce a partial or wrong `TrackGraph`; it must
 * halt automation via Safe-Stop until an operator (or, here, a
 * `TopologyService` write) fixes it.
 */

import { describe, it, expect } from 'vitest';
import { createScenarioHarness, LAYOUT_ID } from './harness';
import { isEdgeTraversable } from '../../src/domain/graph';
import { LayoutEvent } from '../../src/domain/types';

function lastSystemStatusEvent(events: LayoutEvent[]) {
  const statusEvents = events.filter(
    (e): e is Extract<LayoutEvent, { type: 'SYSTEM_STATUS' }> => e.type === 'SYSTEM_STATUS',
  );
  return statusEvents[statusEvents.length - 1];
}

describe('scenario: invalid topology triggers Safe-Stop', () => {
  it('boots to safe-stop with a null graph when a self-loop edge exists, and the reason is on the emitted event', async () => {
    const h = createScenarioHarness();
    h.repo._setBlocks([{ id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' }]);
    await h.repo.createBlockEdge({
      layoutId: LAYOUT_ID,
      fromBlockId: 'b1',
      fromEnd: 'north',
      toBlockId: 'b1',
      toEnd: 'south',
      pointConditions: [],
      lengthMm: null,
    });

    // start() must resolve — a data problem is a Safe-Stop, never an
    // unhandled rejection.
    await expect(h.start()).resolves.toBeUndefined();

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toMatch(/self-loop/i);
    expect(h.service.getTrackGraph()).toBeNull();

    const status = lastSystemStatusEvent(h.events);
    expect(status?.payload.status).toBe('safe-stop');
    expect(status?.payload.reason).toMatch(/self-loop/i);

    await h.service.stop();
  });

  it('recovers to online with a non-null graph once the offending edge is replaced away', async () => {
    // The recovery path since #103 PR 5: there is no per-edge delete any more,
    // so an operator repairs a corrupt graph by fixing the drawing and applying
    // the compile — `replaceGraph`, the one remaining write. Here the drawing
    // implies nothing, so the compiled graph is empty, and an empty graph is a
    // legitimate answer rather than a refusal.
    const h = createScenarioHarness();
    h.repo._setBlocks([{ id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' }]);
    await h.repo.createBlockEdge({
      layoutId: LAYOUT_ID,
      fromBlockId: 'b1',
      fromEnd: 'north',
      toBlockId: 'b1',
      toEnd: 'south',
      pointConditions: [],
      lengthMm: null,
    });

    await h.start();
    expect(h.service.getSystemStatus().status).toBe('safe-stop');

    await h.topologyService.replaceGraph(LAYOUT_ID, [], 'fp-repaired');

    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getSystemStatus().reason).toBeNull();
    expect(h.service.getTrackGraph()).not.toBeNull();
    expect(h.service.getTrackGraph()?.edges.size).toBe(0);

    const status = lastSystemStatusEvent(h.events);
    expect(status?.payload.status).toBe('online');

    await h.service.stop();
  });

  it('safe-stops with a null graph (not a partial one) when an edge references a nonexistent block', async () => {
    const h = createScenarioHarness();
    h.repo._setBlocks([{ id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' }]);
    await h.repo.createBlockEdge({
      layoutId: LAYOUT_ID,
      fromBlockId: 'b1',
      fromEnd: 'east',
      toBlockId: 'ghost-block',
      toEnd: 'west',
      pointConditions: [],
      lengthMm: null,
    });

    await h.start();

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toMatch(/unknown block/i);
    expect(h.service.getTrackGraph()).toBeNull();

    await h.service.stop();
  });

  it('stays online with the edge present but never traversable when its point condition references a deleted point', async () => {
    const h = createScenarioHarness();
    h.repo._setBlocks([
      { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
      { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
    ]);
    h.repo._setPoints([]); // the point this edge depends on is already gone
    await h.repo.createBlockEdge({
      layoutId: LAYOUT_ID,
      fromBlockId: 'b1',
      fromEnd: 'east',
      toBlockId: 'b2',
      toEnd: 'west',
      pointConditions: [{ pointId: 'ghost-point', requiredPosition: 'normal' }],
      lengthMm: null,
    });

    await h.start();

    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getSystemStatus().reason).toBeNull();

    const graph = h.service.getTrackGraph();
    expect(graph).not.toBeNull();
    expect(graph?.edges.size).toBe(1);
    const [edge] = graph!.edges.values();

    // Fail-safe: a dangling point reference can never be satisfied, so the
    // edge is present in the graph but permanently non-traversable.
    expect(isEdgeTraversable(edge, new Map())).toBe(false);

    await h.service.stop();
  });

  it('safe-stops on a duplicate connection at scale, and heals to online once the pair is resolved (#21 — the index-based detector must not miss what the old scan caught)', async () => {
    const EDGE_COUNT = 150;
    const h = createScenarioHarness();
    const blocks = Array.from({ length: EDGE_COUNT + 1 }, (_, i) => ({
      id: `b${i}`,
      layoutId: LAYOUT_ID,
      name: `Block ${i}`,
    }));
    h.repo._setBlocks(blocks);

    const chain = Array.from({ length: EDGE_COUNT }, (_, i) => ({
      fromBlockId: `b${i}`,
      fromEnd: 'east',
      toBlockId: `b${i + 1}`,
      toEnd: 'west',
      pointConditions: [],
      lengthMm: null,
    }));

    for (const edge of chain) {
      await h.repo.createBlockEdge({ layoutId: LAYOUT_ID, ...edge });
    }
    // Duplicates the very first edge's connection tuple (b0 east -> b1 west).
    await h.repo.createBlockEdge({
      layoutId: LAYOUT_ID,
      fromBlockId: 'b0',
      fromEnd: 'east',
      toBlockId: 'b1',
      toEnd: 'west',
      pointConditions: [],
      lengthMm: null,
    });

    await h.start();

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toMatch(/duplicates the connection/i);
    // #54: the reason names the blocks the duplicated edges connect, not
    // just their UUIDs — proving a name reaches system/status.reason.
    expect(h.service.getSystemStatus().reason).toContain('Block 0');
    expect(h.service.getSystemStatus().reason).toContain('Block 1');
    expect(h.service.getTrackGraph()).toBeNull();

    // Healing case from D1: resolving the duplicate must clear Safe-Stop
    // without disturbing the other 150 edges — an incrementally cached
    // "invalid" verdict is exactly what gets this wrong. Since #103 PR 5 the
    // repair is `replaceGraph` with the corrected set, which is what an apply
    // of a fixed drawing does; the healing property under test is unchanged.
    await h.topologyService.replaceGraph(LAYOUT_ID, chain, 'fp-deduped');

    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getSystemStatus().reason).toBeNull();
    const graph = h.service.getTrackGraph();
    expect(graph).not.toBeNull();
    expect(graph?.edges.size).toBe(EDGE_COUNT);

    await h.service.stop();
  });

  it('stays online at scale when edges share three of four connection-tuple fields (a key-collision bug would show as a spurious Safe-Stop on a valid layout)', async () => {
    const EDGE_COUNT = 150;
    const h = createScenarioHarness();
    const blocks = Array.from({ length: EDGE_COUNT + 1 }, (_, i) => ({
      id: `b${i}`,
      layoutId: LAYOUT_ID,
      name: `Block ${i}`,
    }));
    h.repo._setBlocks(blocks);

    for (let i = 0; i < EDGE_COUNT; i++) {
      await h.repo.createBlockEdge({
        layoutId: LAYOUT_ID,
        fromBlockId: `b${i}`,
        fromEnd: 'east',
        toBlockId: `b${i + 1}`,
        toEnd: 'west',
        pointConditions: [],
        lengthMm: null,
      });
    }
    // Matches the first edge's fromBlockId/fromEnd/toBlockId exactly, but a
    // different toEnd — a genuinely different connection, not a duplicate.
    await h.repo.createBlockEdge({
      layoutId: LAYOUT_ID,
      fromBlockId: 'b0',
      fromEnd: 'east',
      toBlockId: 'b1',
      toEnd: 'north',
      pointConditions: [],
      lengthMm: null,
    });

    await h.start();

    expect(h.service.getSystemStatus().status).toBe('online');
    expect(h.service.getSystemStatus().reason).toBeNull();
    const graph = h.service.getTrackGraph();
    expect(graph).not.toBeNull();
    expect(graph?.edges.size).toBe(EDGE_COUNT + 1);

    await h.service.stop();
  });

  it('safe-stops with the row-schema reason, without crashing, when a row has an un-normalised from_end', async () => {
    const h = createScenarioHarness();
    h.repo._setBlocks([
      { id: 'b1', layoutId: LAYOUT_ID, name: 'Block 1' },
      { id: 'b2', layoutId: LAYOUT_ID, name: 'Block 2' },
    ]);
    h.repo._insertRawEdgeRow({
      id: 'bad-row',
      layoutId: LAYOUT_ID,
      fromBlockId: 'b1',
      fromEnd: 'North',
      toBlockId: 'b2',
      toEnd: 'south',
      pointConditions: '[]',
      lengthMm: null,
    });

    // #54/D10 regression guard: `reloadTopology` now calls `NameBookCache.refresh`
    // BEFORE `loadTopology` — and `refresh` runs its OWN `listBlockEdges` call,
    // which hits the same corrupt row and throws the same
    // `BlockEdgeRowInvalidError`. If the refresh's catch were not narrowed to
    // that error alone (or were missing), this would surface as an unhandled
    // rejection out of `start()` rather than a Safe-Stop — exactly the #10
    // regression D10 exists to prevent.
    await expect(h.start()).resolves.toBeUndefined();

    expect(h.service.getSystemStatus().status).toBe('safe-stop');
    expect(h.service.getSystemStatus().reason).toMatch(/failed validation/i);
    expect(h.service.getTrackGraph()).toBeNull();

    // The name book itself must not be the thing that failed: it falls back
    // to an empty edges map but still resolves, and everything it fetched
    // independently of the corrupt edge (blocks) is still populated.
    expect(h.nameBook.get().edges.size).toBe(0);
    expect(h.nameBook.get().blocks.get('b1')).toBe('Block 1');

    await h.service.stop();
  });
});
