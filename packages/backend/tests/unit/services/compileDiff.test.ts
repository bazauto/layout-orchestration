/**
 * The compile diff (#103, `docs/track-graph-compilation.md` D8/D10, plan D-J).
 *
 * The diff is the whole of D1's safety argument. Compiling is claimed to be
 * *safer* than transcribing because it puts the operator where they are best —
 * comparing a picture to a list — instead of typing slugs into a field. That
 * only holds if the list is readable, and the thing that makes it unreadable is
 * noise: end labels are disposable output regenerated on every compile, so a
 * diff keyed on them reports a redraw as "every edge removed, every edge added"
 * and the one genuinely changed row drowns.
 *
 * Hence two passes, and hence these tests: what must never happen is a real
 * change to the point conditions being classified as anything softer than
 * `changed`.
 */

import { describe, it, expect } from 'vitest';
import { diffGraph } from '../../../src/services/CompileService';
import { NamedCompiledEdge } from '../../../src/services/trackGraphCompiler';
import { BlockEdge, PointCondition } from '../../../src/domain/types';

const LAYOUT = 'layout-1';

function live(
  id: string,
  fromBlockId: string,
  fromEnd: string,
  toBlockId: string,
  toEnd: string,
  pointConditions: PointCondition[] = [],
): BlockEdge {
  return { id, layoutId: LAYOUT, fromBlockId, fromEnd, toBlockId, toEnd, pointConditions };
}

function proposed(
  fromBlockId: string,
  fromEnd: string,
  toBlockId: string,
  toEnd: string,
  pointConditions: PointCondition[] = [],
): NamedCompiledEdge {
  return {
    fromBlockId,
    fromEnd,
    toBlockId,
    toEnd,
    pointConditions,
    via: [],
    crossesDiamond: false,
  };
}

describe('diffGraph', () => {
  it('reports an unauthored graph as entirely added', () => {
    // The live layout's state today: the drawing is complete and `block_edges`
    // is empty, so the first compile is one big `added`.
    const diff = diffGraph([], [proposed('a', 'east', 'b', 'west')]);

    expect(diff.added).toHaveLength(1);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.relabelled).toHaveLength(0);
  });

  it('matches an identical edge as unchanged, so a re-compile is visibly a no-op', () => {
    const diff = diffGraph(
      [live('e1', 'a', 'east', 'b', 'west')],
      [proposed('a', 'east', 'b', 'west')],
    );

    expect(diff.unchanged.map((e) => e.id)).toEqual(['e1']);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('ignores the order of point conditions when deciding two edges are the same', () => {
    // Two conditions on one edge are a set, not a sequence. If ordering counted,
    // an operator would be shown a "change" that changes nothing, and would
    // learn to click through the diff — which is the failure that matters here.
    const diff = diffGraph(
      [
        live('e1', 'a', 'east', 'b', 'west', [
          { pointId: 'p1', requiredPosition: 'normal' },
          { pointId: 'p2', requiredPosition: 'reverse' },
        ]),
      ],
      [
        proposed('a', 'east', 'b', 'west', [
          { pointId: 'p2', requiredPosition: 'reverse' },
          { pointId: 'p1', requiredPosition: 'normal' },
        ]),
      ],
    );

    expect(diff.unchanged).toHaveLength(1);
    expect(diff.changed).toHaveLength(0);
  });

  it('reports the same ends with different point conditions as changed, never as unchanged', () => {
    // The safety-relevant category. The drawing now says this connection needs
    // the blades the other way; a route planned over the live row would set the
    // wrong road. It must not hide inside `relabelled` or `unchanged`.
    const diff = diffGraph(
      [live('e1', 'a', 'east', 'b', 'west', [{ pointId: 'p1', requiredPosition: 'normal' }])],
      [proposed('a', 'east', 'b', 'west', [{ pointId: 'p1', requiredPosition: 'reverse' }])],
    );

    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].live.id).toBe('e1');
    expect(diff.changed[0].proposed.pointConditions).toEqual([
      { pointId: 'p1', requiredPosition: 'reverse' },
    ]);
    expect(diff.unchanged).toHaveLength(0);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('reports a pure rename as relabelled, not as an add and a remove', () => {
    // D8's accepted consequence: redraw a corner and `east` becomes `east-1`.
    // The connection did not move.
    const diff = diffGraph(
      [live('e1', 'a', 'east', 'b', 'west')],
      [proposed('a', 'east-1', 'b', 'west')],
    );

    expect(diff.relabelled).toHaveLength(1);
    expect(diff.relabelled[0].live.id).toBe('e1');
    expect(diff.relabelled[0].proposed.fromEnd).toBe('east-1');
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('does not relabel across a change in point conditions', () => {
    // Both the label and the conditions moved. Nothing links the two rows, and
    // pretending otherwise would present a conditions change as a rename — the
    // exact misread the `changed` category exists to prevent.
    const diff = diffGraph(
      [live('e1', 'a', 'east', 'b', 'west', [{ pointId: 'p1', requiredPosition: 'normal' }])],
      [proposed('a', 'east-1', 'b', 'west', [{ pointId: 'p1', requiredPosition: 'reverse' }])],
    );

    expect(diff.relabelled).toHaveLength(0);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed.map((e) => e.id)).toEqual(['e1']);
  });

  it('does not relabel across a different pair of blocks', () => {
    // Same label, different destination. A rename is a change of name; this is
    // a change of railway.
    const diff = diffGraph(
      [live('e1', 'a', 'east', 'b', 'west')],
      [proposed('a', 'east', 'c', 'west')],
    );

    expect(diff.relabelled).toHaveLength(0);
    expect(diff.added).toHaveLength(1);
    expect(diff.removed.map((e) => e.id)).toEqual(['e1']);
  });

  it('pairs surplus rows deterministically and leaves the remainder added or removed', () => {
    // Two live rows for one connection, one proposal: one pairs, one is gone.
    const diff = diffGraph(
      [live('e1', 'a', 'east-1', 'b', 'west'), live('e2', 'a', 'east-2', 'b', 'west')],
      [proposed('a', 'east', 'b', 'west')],
    );

    expect(diff.relabelled).toHaveLength(1);
    expect(diff.relabelled[0].live.id).toBe('e1');
    expect(diff.removed.map((e) => e.id)).toEqual(['e2']);
    expect(diff.added).toHaveLength(0);
  });

  it('treats the two directions of one connection as two rows', () => {
    // `block_edges` is directional and the compiler emits both sides in one
    // pass (D2). A diff that folded them together would hide a drawing that
    // supports one direction and not the other — which since #104 is a
    // statement, not an oversight.
    const diff = diffGraph(
      [live('e1', 'a', 'east', 'b', 'west')],
      [proposed('a', 'east', 'b', 'west'), proposed('b', 'west', 'a', 'east')],
    );

    expect(diff.unchanged.map((e) => e.id)).toEqual(['e1']);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].fromBlockId).toBe('b');
  });

  it('is stable under input permutation', () => {
    const liveEdges = [
      live('e1', 'a', 'east', 'b', 'west'),
      live('e2', 'b', 'east', 'c', 'west'),
      live('e3', 'c', 'east', 'd', 'west'),
    ];
    const proposals = [
      proposed('a', 'east-1', 'b', 'west'),
      proposed('b', 'east', 'c', 'west'),
      proposed('d', 'east', 'e', 'west'),
    ];

    const forwards = diffGraph(liveEdges, proposals);
    const backwards = diffGraph([...liveEdges].reverse(), [...proposals].reverse());

    expect(backwards).toEqual(forwards);
    expect(forwards.unchanged.map((e) => e.id)).toEqual(['e2']);
    expect(forwards.relabelled.map((p) => p.live.id)).toEqual(['e1']);
    expect(forwards.removed.map((e) => e.id)).toEqual(['e3']);
    expect(forwards.added.map((p) => p.fromBlockId)).toEqual(['d']);
  });
});
