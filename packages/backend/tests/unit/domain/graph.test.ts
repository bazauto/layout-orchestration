import { describe, it, expect } from 'vitest';
import {
  buildTrackGraph,
  edgesFrom,
  edgesTo,
  unsatisfiedConditions,
  isEdgeTraversable,
  traversableEdgesFrom,
  collectPointConditions,
  reachableBlocks,
} from '../../../src/domain/graph';
import { BlockEdge, PointPosition } from '../../../src/domain/types';
import { TopologyInvalidError } from '../../../src/domain/topology';

const layoutId = 'layout-1';

// ─── Fixture ────────────────────────────────────────────────────────────────
//
//   approach ──e1(east→west)──> throat ──e2(east→west, a=normal)──> platform-1
//   approach <──e6(west←east)── throat ──e3(east→west, a=reverse,b=normal)──> platform-2
//   platform-1 ──e5(west→east)──> throat  throat ──e4(east→west, a=reverse,b=reverse)──> yard

const e1: BlockEdge = {
  id: 'e1',
  layoutId,
  fromBlockId: 'approach',
  fromEnd: 'east',
  toBlockId: 'throat',
  toEnd: 'west',
  pointConditions: [],
  lengthMm: 1200,
};

const e2: BlockEdge = {
  id: 'e2',
  layoutId,
  fromBlockId: 'throat',
  fromEnd: 'east',
  toBlockId: 'platform-1',
  toEnd: 'west',
  pointConditions: [{ pointId: 'p-throat-a', requiredPosition: 'normal' }],
  lengthMm: 800,
};

const e3: BlockEdge = {
  id: 'e3',
  layoutId,
  fromBlockId: 'throat',
  fromEnd: 'east',
  toBlockId: 'platform-2',
  toEnd: 'west',
  pointConditions: [
    { pointId: 'p-throat-a', requiredPosition: 'reverse' },
    { pointId: 'p-throat-b', requiredPosition: 'normal' },
  ],
  lengthMm: 800,
};

const e4: BlockEdge = {
  id: 'e4',
  layoutId,
  fromBlockId: 'throat',
  fromEnd: 'east',
  toBlockId: 'yard',
  toEnd: 'west',
  pointConditions: [
    { pointId: 'p-throat-a', requiredPosition: 'reverse' },
    { pointId: 'p-throat-b', requiredPosition: 'reverse' },
  ],
  lengthMm: null,
};

const e5: BlockEdge = {
  id: 'e5',
  layoutId,
  fromBlockId: 'platform-1',
  fromEnd: 'west',
  toBlockId: 'throat',
  toEnd: 'east',
  pointConditions: [{ pointId: 'p-throat-a', requiredPosition: 'normal' }],
  lengthMm: 800,
};

const e6: BlockEdge = {
  id: 'e6',
  layoutId,
  fromBlockId: 'throat',
  fromEnd: 'west',
  toBlockId: 'approach',
  toEnd: 'east',
  pointConditions: [],
  lengthMm: 1200,
};

const allEdges = [e1, e2, e3, e4, e5, e6];

function positions(overrides: Record<string, PointPosition>): Map<string, PointPosition> {
  return new Map(Object.entries(overrides));
}

describe('buildTrackGraph', () => {
  it('groups outgoing edges by block in input order, including the plain return edge e6', () => {
    const graph = buildTrackGraph(layoutId, allEdges);
    // throat's east end leaves via e2/e3/e4 (point-gated); its west end leaves via
    // e6 (plain track back to approach) — all four are outgoing edges of throat.
    expect(graph.outgoing.get('throat')).toEqual([e2, e3, e4, e6]);
  });

  it('groups incoming edges by block in input order', () => {
    const graph = buildTrackGraph(layoutId, allEdges);
    expect(graph.incoming.get('throat')).toEqual([e1, e5]);
  });

  it('keeps both directions between approach and throat independent', () => {
    const graph = buildTrackGraph(layoutId, allEdges);
    expect(graph.outgoing.get('approach')).toEqual([e1]);
    expect(graph.incoming.get('approach')).toEqual([e6]);
  });

  it('throws on layoutId mismatch', () => {
    const badEdge: BlockEdge = { ...e1, id: 'bad', layoutId: 'other-layout' };
    expect(() => buildTrackGraph(layoutId, [badEdge])).toThrow(/bad/);
  });

  it('throws on duplicate edge id', () => {
    const dupe: BlockEdge = { ...e2, id: 'e1' };
    expect(() => buildTrackGraph(layoutId, [e1, dupe])).toThrow(/e1/);
  });

  it('throws on self-loop', () => {
    const loop: BlockEdge = { ...e1, id: 'loop', toBlockId: e1.fromBlockId };
    expect(() => buildTrackGraph(layoutId, [loop])).toThrow(/loop/);
  });

  it('throws a TopologyInvalidError carrying the violations', () => {
    const loop: BlockEdge = { ...e1, id: 'loop', toBlockId: e1.fromBlockId };
    expect(() => buildTrackGraph(layoutId, [loop])).toThrow(TopologyInvalidError);
    try {
      buildTrackGraph(layoutId, [loop]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TopologyInvalidError);
      expect((err as TopologyInvalidError).violations).toEqual([
        { kind: 'self-loop', edgeId: 'loop', blockId: 'approach' },
      ]);
    }
  });
});

describe('edgesFrom', () => {
  it('returns [] for an unknown block id', () => {
    const graph = buildTrackGraph(layoutId, allEdges);
    expect(edgesFrom(graph, 'nonexistent')).toEqual([]);
  });
});

describe('edgesTo', () => {
  it('returns [] for an unknown block id', () => {
    const graph = buildTrackGraph(layoutId, allEdges);
    expect(edgesTo(graph, 'nonexistent')).toEqual([]);
  });
});

describe('unsatisfiedConditions', () => {
  it('returns [] for an edge with no conditions', () => {
    expect(unsatisfiedConditions(e1, positions({}))).toEqual([]);
  });

  it('returns [] for e2 when a=normal', () => {
    expect(unsatisfiedConditions(e2, positions({ 'p-throat-a': 'normal' }))).toEqual([]);
  });

  it('returns the condition for e2 when a=reverse', () => {
    expect(unsatisfiedConditions(e2, positions({ 'p-throat-a': 'reverse' }))).toEqual([
      { pointId: 'p-throat-a', requiredPosition: 'normal' },
    ]);
  });

  it('returns the condition for e2 when a is unknown (fail-safe)', () => {
    expect(unsatisfiedConditions(e2, positions({ 'p-throat-a': 'unknown' }))).toEqual([
      { pointId: 'p-throat-a', requiredPosition: 'normal' },
    ]);
  });

  it('returns the condition for e2 when a is absent from the map (dangling reference fails closed)', () => {
    expect(unsatisfiedConditions(e2, positions({}))).toEqual([
      { pointId: 'p-throat-a', requiredPosition: 'normal' },
    ]);
  });

  it('returns only the b condition for e3 when a=reverse,b=reverse', () => {
    expect(
      unsatisfiedConditions(e3, positions({ 'p-throat-a': 'reverse', 'p-throat-b': 'reverse' })),
    ).toEqual([{ pointId: 'p-throat-b', requiredPosition: 'normal' }]);
  });
});

describe('isEdgeTraversable', () => {
  it('is true for e3 when a=reverse,b=normal', () => {
    expect(
      isEdgeTraversable(e3, positions({ 'p-throat-a': 'reverse', 'p-throat-b': 'normal' })),
    ).toBe(true);
  });

  it('is false for e3 when a=reverse,b=reverse', () => {
    expect(
      isEdgeTraversable(e3, positions({ 'p-throat-a': 'reverse', 'p-throat-b': 'reverse' })),
    ).toBe(false);
  });
});

describe('traversableEdgesFrom', () => {
  const graph = buildTrackGraph(layoutId, allEdges);

  // A train sitting in 'throat' arrived via its west end (from approach via e1),
  // so arrivedAtEnd: 'west' excludes e6 (also a west exit) as a no-reversal move,
  // isolating the point-gated east-end edges under test.

  it('returns [e2] from throat when a=normal', () => {
    expect(
      traversableEdgesFrom(graph, 'throat', positions({ 'p-throat-a': 'normal' }), {
        arrivedAtEnd: 'west',
      }),
    ).toEqual([e2]);
  });

  it('returns [e4] from throat when a=reverse,b=reverse', () => {
    expect(
      traversableEdgesFrom(
        graph,
        'throat',
        positions({ 'p-throat-a': 'reverse', 'p-throat-b': 'reverse' }),
        { arrivedAtEnd: 'west' },
      ),
    ).toEqual([e4]);
  });

  it('returns [] from throat when a=unknown', () => {
    expect(
      traversableEdgesFrom(graph, 'throat', positions({ 'p-throat-a': 'unknown' }), {
        arrivedAtEnd: 'west',
      }),
    ).toEqual([]);
  });

  it('without arrivedAtEnd, also includes the ungated e6 return edge', () => {
    expect(
      traversableEdgesFrom(graph, 'throat', positions({ 'p-throat-a': 'normal' })),
    ).toEqual([e2, e6]);
  });

  it('excludes e5 from platform-1 when arrivedAtEnd matches its fromEnd', () => {
    expect(
      traversableEdgesFrom(graph, 'platform-1', positions({ 'p-throat-a': 'normal' }), {
        arrivedAtEnd: 'west',
      }),
    ).toEqual([]);
  });

  it('includes e5 from platform-1 when arrivedAtEnd is not given', () => {
    expect(
      traversableEdgesFrom(graph, 'platform-1', positions({ 'p-throat-a': 'normal' })),
    ).toEqual([e5]);
  });

  it('returns [] for an unknown block id', () => {
    expect(traversableEdgesFrom(graph, 'nonexistent', positions({}))).toEqual([]);
  });
});

describe('collectPointConditions', () => {
  it('collects a single condition with no conflicts from [e2]', () => {
    const result = collectPointConditions([e2]);
    expect(result.conditions).toEqual([{ pointId: 'p-throat-a', requiredPosition: 'normal' }]);
    expect(result.conflicts).toEqual([]);
  });

  it('flags p-throat-a as conflicting from [e2, e3]', () => {
    const result = collectPointConditions([e2, e3]);
    expect(result.conflicts).toEqual(['p-throat-a']);
  });

  it('de-duplicates identical conditions from [e2, e2]', () => {
    const result = collectPointConditions([e2, e2]);
    expect(result.conditions).toEqual([{ pointId: 'p-throat-a', requiredPosition: 'normal' }]);
    expect(result.conflicts).toEqual([]);
  });
});

describe('reachableBlocks', () => {
  const graph = buildTrackGraph(layoutId, allEdges);

  it('reaches {approach, throat, platform-1} when a=normal', () => {
    const result = reachableBlocks(graph, 'approach', positions({ 'p-throat-a': 'normal' }));
    expect(result).toEqual(new Set(['approach', 'throat', 'platform-1']));
  });

  it('reaches {approach, throat, yard} when a=reverse,b=reverse', () => {
    const result = reachableBlocks(
      graph,
      'approach',
      positions({ 'p-throat-a': 'reverse', 'p-throat-b': 'reverse' }),
    );
    expect(result).toEqual(new Set(['approach', 'throat', 'yard']));
  });

  it('reaches only {approach, throat} when all points are unknown — e1 is ungated but every onward edge from throat is point-gated', () => {
    const result = reachableBlocks(
      graph,
      'approach',
      positions({ 'p-throat-a': 'unknown', 'p-throat-b': 'unknown' }),
    );
    expect(result).toEqual(new Set(['approach', 'throat']));
  });

  it('terminates on the e1/e6 cycle', () => {
    const result = reachableBlocks(graph, 'approach', positions({}));
    expect(result).toBeInstanceOf(Set);
  });
});
