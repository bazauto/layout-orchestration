/**
 * Load-path ceiling at MAX_EDGES_PER_LAYOUT (#21).
 *
 * A catastrophic-regression smoke check, not the complexity proof — that's
 * `tests/unit/domain/topologyComplexity.test.ts`, which counts operations
 * deterministically rather than timing wall-clock. This just confirms that a
 * layout at the cap still loads, and loads fast, so a future change that
 * reintroduces an O(n^2) path on this call site is caught here even if
 * nobody re-reads the complexity benchmark's reasoning. Measured at time of
 * writing: ~11ms for 2,000 edges on ordinary dev hardware, against a 500ms
 * ceiling — a real regression should blow through that ceiling by a wide
 * margin, not sit close to it, so a future reader can tell an actual
 * regression from CI noise.
 */

import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createScenarioHarness, LAYOUT_ID } from '../scenario/harness';
import { loadTopology } from '../../src/services/topologyLoader';
import { MAX_EDGES_PER_LAYOUT } from '../../src/domain/topology';

describe('topology load path at the edge cap', () => {
  it('loads MAX_EDGES_PER_LAYOUT valid edges as a valid, non-null graph in well under 500ms', async () => {
    const h = createScenarioHarness();
    const blocks = Array.from({ length: MAX_EDGES_PER_LAYOUT + 1 }, (_, i) => ({
      id: `b${i}`,
      layoutId: LAYOUT_ID,
      name: `Block ${i}`,
    }));
    h.repo._setBlocks(blocks);

    // Inserted directly through the repo, not one HTTP POST per edge — a
    // capped bulk insert through the API is inherently O(N^2) (each create
    // re-fetches and re-validates the growing edge list) and would dominate
    // the runtime here for no benefit; this test times loadTopology alone.
    for (let i = 0; i < MAX_EDGES_PER_LAYOUT; i++) {
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

    const start = performance.now();
    const result = await loadTopology(h.repo, LAYOUT_ID);
    const elapsedMs = performance.now() - start;

    expect(result.fatal).toBe(false);
    expect(result.violations).toEqual([]);
    expect(result.graph).not.toBeNull();
    expect(result.graph?.edges.size).toBe(MAX_EDGES_PER_LAYOUT);
    expect(elapsedMs).toBeLessThan(500);
  });
});
