/**
 * Complexity benchmark for `validateTopology` (#21).
 *
 * A wall-clock ratio test would be flaky on CI and proves nothing about
 * algorithmic complexity. Instead this counts numeric-index `get` traps on a
 * `Proxy` wrapping the edge array — a deterministic, environment-independent
 * measure of how many times the array is indexed into. `Array.isArray`
 * returns `true` for a `Proxy` over an array, so `validateEdgeAgainstLayout`'s
 * array/`EdgeIndex` discriminant (see `domain/topology.ts`) is unaffected —
 * the proxy is transparent to the code under test.
 *
 * This is the test that fails before the fix and passes after it. Measured
 * numbers at the time of writing, with the pre-fix `Array#find`-per-edge
 * scan: ~40,200 reads at n = 200, ~640,800 reads at n = 800 — both close to
 * n + n^2 (the n comes from the plain `for...of` over the edge array;
 * `Array#find` never finds an early match against a duplicate-free set, so it
 * scans the full array on every one of the n edges). Under the O(n) fix:
 * ~400 reads at n = 200, ~1,600 at n = 800 — close to 2n (one `for...of` pass
 * to build the `EdgeIndex`, one more to drive the violation loop). A future
 * reader can re-run this file against the pre-#21 `domain/topology.ts` to
 * confirm it's load-bearing rather than decorative.
 */

import { describe, it, expect } from 'vitest';
import { validateTopology, TopologyContext } from '../../../src/domain/topology';
import { BlockEdge } from '../../../src/domain/types';

const LAYOUT_ID = 'bench-layout';

/** Wraps `edges` in a Proxy that counts numeric-index `get` traps, and
 * returns a getter for the running total. */
function countingEdges(edges: BlockEdge[]): { proxy: readonly BlockEdge[]; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(edges, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        reads += 1;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxy, reads: () => reads };
}

/**
 * A valid, duplicate-free edge set of size `n` over `n + 1` synthetic blocks:
 * edge `i` runs from block `bI` to block `b(i+1)`, so every tuple is distinct
 * and no edge is a self-loop.
 */
function generateEdges(n: number, layoutId: string): BlockEdge[] {
  const edges: BlockEdge[] = [];
  for (let i = 0; i < n; i++) {
    edges.push({
      id: `e${i}`,
      layoutId,
      fromBlockId: `b${i}`,
      fromEnd: 'east',
      toBlockId: `b${i + 1}`,
      toEnd: 'west',
      pointConditions: [],
      lengthMm: null,
    });
  }
  return edges;
}

function contextFor(edges: readonly BlockEdge[]): TopologyContext {
  const blockIds = new Set<string>();
  for (const edge of edges) {
    blockIds.add(edge.fromBlockId);
    blockIds.add(edge.toBlockId);
  }
  return { blockIds, pointIds: new Set() };
}

describe('validateTopology complexity', () => {
  it('reads the edge array a number of times that is linear in edge count, not quadratic', () => {
    const edges200 = generateEdges(200, LAYOUT_ID);
    const counting200 = countingEdges(edges200);
    validateTopology(LAYOUT_ID, counting200.proxy, contextFor(edges200));

    const edges800 = generateEdges(800, LAYOUT_ID);
    const counting800 = countingEdges(edges800);
    validateTopology(LAYOUT_ID, counting800.proxy, contextFor(edges800));

    const reads200 = counting200.reads();
    const reads800 = counting800.reads();

    // Linear is ~2n (index build + violation loop) so both are comfortably
    // under a 10x-of-n ceiling; the old O(n^2) scan blows through it (n=200
    // alone reads ~40,200 times, over 20x the ceiling below).
    expect(reads200).toBeLessThanOrEqual(10 * 200);
    expect(reads800).toBeLessThanOrEqual(10 * 800);

    // Linear growth from n=200 to n=800 (4x the edges) is ~4x the reads;
    // quadratic growth would be ~16x. 8 sits between the two with margin on
    // both sides, so this doesn't need per-run threshold tuning.
    expect(reads800 / reads200).toBeLessThan(8);
  });

  it('stays linear when a quarter of the edges are duplicate connections (the case the old Array#find scan degraded on)', () => {
    const unique = generateEdges(300, LAYOUT_ID);
    // 100 more edges, each duplicating the connection tuple of one of the
    // first 100 unique edges above, under a fresh id.
    const duplicates: BlockEdge[] = unique.slice(0, 100).map((e, i) => ({ ...e, id: `dup${i}` }));
    const edges = [...unique, ...duplicates];

    const counting = countingEdges(edges);
    validateTopology(LAYOUT_ID, counting.proxy, contextFor(edges));

    expect(counting.reads()).toBeLessThanOrEqual(10 * edges.length);
  });
});
