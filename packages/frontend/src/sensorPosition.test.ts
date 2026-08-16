/**
 * #77's anchor list (`docs/sensor-position.md` D5).
 *
 * The claim worth pinning is that the list is *narrower* than what the backend
 * accepts and narrower in a specific direction: it drops anchors that could
 * never mean anything, and it must not drop ordinary ones by miscounting the
 * two rows a bidirectional connection is made of.
 */

import { describe, expect, it } from 'vitest';
import { anchorCandidates } from './sensorPosition';
import { BlockEdgeRecord, BlockRecord } from './types';

const LAYOUT = 'layout-1';

function block(id: string, name: string): BlockRecord {
  return { id, layoutId: LAYOUT, name, lengthMm: null };
}

function edge(id: string, fromBlockId: string, toBlockId: string, fromEnd = 'east'): BlockEdgeRecord {
  return {
    id,
    layoutId: LAYOUT,
    fromBlockId,
    fromEnd,
    toBlockId,
    toEnd: 'west',
    pointConditions: [],
  };
}

const BLOCKS = [block('b1', 'Platform 1'), block('b2', 'Goods Shed'), block('b3', 'Engine Shed')];

/** b1 <-> b2 and b1 <-> b3, one row per direction as the compiler emits them. */
const EDGES = [
  edge('e1', 'b1', 'b2'),
  edge('e1r', 'b2', 'b1'),
  edge('e2', 'b1', 'b3', 'north'),
  edge('e2r', 'b3', 'b1'),
];

describe('anchorCandidates', () => {
  it('offers every block joined exactly once, in name order', () => {
    // Name order, not id order: the operator picks by the name on the layout.
    expect(anchorCandidates('b1', BLOCKS, EDGES).map((b) => b.name)).toEqual([
      'Engine Shed',
      'Goods Shed',
    ]);
  });

  it('counts one direction only — a bidirectional joint is one connection, not two', () => {
    // The failure this guards: counting both rows reads every ordinary joint as
    // a duplicate and the list comes back empty for the whole layout.
    expect(anchorCandidates('b2', BLOCKS, EDGES).map((b) => b.id)).toEqual(['b1']);
  });

  it('drops a neighbour joined in more than one place — "the boundary" is then not a definite description', () => {
    const looped = [...EDGES, edge('e3', 'b1', 'b2', 'south')];
    expect(anchorCandidates('b1', BLOCKS, looped).map((b) => b.id)).toEqual(['b3']);
  });

  it('offers nothing for a sensor with no block, and nothing on an empty graph', () => {
    expect(anchorCandidates(null, BLOCKS, EDGES)).toEqual([]);
    expect(anchorCandidates('b1', BLOCKS, [])).toEqual([]);
  });

  it('never offers the block itself, even if the drawing somehow contains a self-loop', () => {
    // `block_edges_not_self_loop` makes this unreachable through the compiler,
    // but a list that would offer "toward itself" is one bad row away from a
    // 400 the operator cannot explain.
    const selfLooped = [...EDGES, edge('e-self', 'b1', 'b1')];
    expect(anchorCandidates('b1', BLOCKS, selfLooped).map((b) => b.id)).not.toContain('b1');
  });
});
