import { describe, it, expect } from 'vitest';
import {
  validateTopology,
  validateEdgeAgainstLayout,
  isFatalViolation,
  describeViolations,
  TopologyInvalidError,
  TopologyContext,
  buildEdgeIndex,
} from '../../../src/domain/topology';
import { EMPTY_NAME_BOOK } from '../../../src/domain/naming';
import { BlockEdge, NameBook, TopologyViolation } from '../../../src/domain/types';

const layoutId = 'layout-1';

function edge(overrides: Partial<BlockEdge>): BlockEdge {
  return {
    id: 'e1',
    layoutId,
    fromBlockId: 'a',
    fromEnd: 'east',
    toBlockId: 'b',
    toEnd: 'west',
    pointConditions: [],
    lengthMm: null,
    ...overrides,
  };
}

const context: TopologyContext = {
  blockIds: new Set(['a', 'b', 'c']),
  pointIds: new Set(['p1']),
};

describe('validateEdgeAgainstLayout', () => {
  it('flags layout-mismatch with the expected and actual layout ids', () => {
    const e = edge({ layoutId: 'other-layout' });
    const violations = validateEdgeAgainstLayout(e, layoutId, context, [e]);
    expect(violations).toContainEqual({
      kind: 'layout-mismatch',
      edgeId: 'e1',
      expectedLayoutId: layoutId,
      actualLayoutId: 'other-layout',
    });
  });

  it('flags self-loop with the offending block id', () => {
    const e = edge({ fromBlockId: 'a', toBlockId: 'a' });
    const violations = validateEdgeAgainstLayout(e, layoutId, context, [e]);
    expect(violations).toContainEqual({ kind: 'self-loop', edgeId: 'e1', blockId: 'a' });
  });

  it('flags unknown-block for a dangling fromBlockId', () => {
    const e = edge({ fromBlockId: 'ghost' });
    const violations = validateEdgeAgainstLayout(e, layoutId, context, [e]);
    expect(violations).toContainEqual({ kind: 'unknown-block', edgeId: 'e1', blockId: 'ghost' });
  });

  it('flags unknown-block for a dangling toBlockId', () => {
    const e = edge({ toBlockId: 'ghost' });
    const violations = validateEdgeAgainstLayout(e, layoutId, context, [e]);
    expect(violations).toContainEqual({ kind: 'unknown-block', edgeId: 'e1', blockId: 'ghost' });
  });

  it('flags unknown-point for a dangling point condition', () => {
    const e = edge({ pointConditions: [{ pointId: 'ghost-point', requiredPosition: 'normal' }] });
    const violations = validateEdgeAgainstLayout(e, layoutId, context, [e]);
    expect(violations).toContainEqual({
      kind: 'unknown-point',
      edgeId: 'e1',
      pointId: 'ghost-point',
    });
  });

  it('flags duplicate-connection when another edge shares the same tuple', () => {
    const e1 = edge({ id: 'e1' });
    const e2 = edge({ id: 'e2' });
    const violations = validateEdgeAgainstLayout(e1, layoutId, context, [e1, e2]);
    expect(violations).toContainEqual({
      kind: 'duplicate-connection',
      edgeId: 'e1',
      conflictingEdgeId: 'e2',
    });
  });

  it('does not flag an edge as conflicting with itself when re-validated against a list containing it unchanged', () => {
    const e1 = edge({ id: 'e1' });
    const violations = validateEdgeAgainstLayout(e1, layoutId, context, [e1]);
    expect(violations.filter((v) => v.kind === 'duplicate-connection')).toEqual([]);
  });

  it('returns [] for a fully valid edge', () => {
    const e = edge({});
    expect(validateEdgeAgainstLayout(e, layoutId, context, [e])).toEqual([]);
  });

  it('does not flag an edge matching in three of four tuple fields as a duplicate (no false Safe-Stop from a key collision)', () => {
    const e1 = edge({ id: 'e1', fromBlockId: 'a', fromEnd: 'east', toBlockId: 'b', toEnd: 'west' });
    // Same fromBlockId/fromEnd/toBlockId, but a different toEnd — not the same connection.
    const e2 = edge({ id: 'e2', fromBlockId: 'a', fromEnd: 'east', toBlockId: 'b', toEnd: 'north' });
    const violations = validateEdgeAgainstLayout(e1, layoutId, context, [e1, e2]);
    expect(violations.filter((v) => v.kind === 'duplicate-connection')).toEqual([]);
  });

  it('reports the same conflictingEdgeId as the old Array#find scan for a three-way duplicate (e1->e2, e2->e1, e3->e1)', () => {
    const e1 = edge({ id: 'e1' });
    const e2 = edge({ id: 'e2' });
    const e3 = edge({ id: 'e3' });
    const all = [e1, e2, e3];

    expect(
      validateEdgeAgainstLayout(e1, layoutId, context, all).find((v) => v.kind === 'duplicate-connection'),
    ).toEqual({ kind: 'duplicate-connection', edgeId: 'e1', conflictingEdgeId: 'e2' });
    expect(
      validateEdgeAgainstLayout(e2, layoutId, context, all).find((v) => v.kind === 'duplicate-connection'),
    ).toEqual({ kind: 'duplicate-connection', edgeId: 'e2', conflictingEdgeId: 'e1' });
    expect(
      validateEdgeAgainstLayout(e3, layoutId, context, all).find((v) => v.kind === 'duplicate-connection'),
    ).toEqual({ kind: 'duplicate-connection', edgeId: 'e3', conflictingEdgeId: 'e1' });
  });

  it('produces identical violation lists for a raw array and a prebuilt EdgeIndex over the same input', () => {
    const e1 = edge({ id: 'e1' });
    const e2 = edge({ id: 'e2' });
    const all = [e1, e2];
    const index = buildEdgeIndex(all);

    expect(validateEdgeAgainstLayout(e1, layoutId, context, all)).toEqual(
      validateEdgeAgainstLayout(e1, layoutId, context, index),
    );
    expect(validateEdgeAgainstLayout(e2, layoutId, context, all)).toEqual(
      validateEdgeAgainstLayout(e2, layoutId, context, index),
    );
  });
});

describe('validateTopology', () => {
  it('flags duplicate-edge-id when two edges share an id', () => {
    const e1 = edge({ id: 'dup' });
    const e2 = edge({ id: 'dup', fromBlockId: 'b', toBlockId: 'c' });
    const violations = validateTopology(layoutId, [e1, e2], context);
    expect(violations).toContainEqual({ kind: 'duplicate-edge-id', edgeId: 'dup' });
  });

  it('returns three violations, not one, for three distinct problems', () => {
    const e1 = edge({ id: 'e1', layoutId: 'other-layout' });
    const e2 = edge({ id: 'e2', fromBlockId: 'a', toBlockId: 'a' });
    const e3 = edge({ id: 'e3', fromBlockId: 'ghost' });
    const violations = validateTopology(layoutId, [e1, e2, e3], context);

    expect(violations).toHaveLength(3);
    expect(violations.map((v) => v.kind)).toEqual([
      'layout-mismatch',
      'self-loop',
      'unknown-block',
    ]);
  });

  it('returns [] for a fully valid edge set', () => {
    const e1 = edge({ id: 'e1', fromBlockId: 'a', toBlockId: 'b' });
    const e2 = edge({ id: 'e2', fromBlockId: 'b', toBlockId: 'c' });
    expect(validateTopology(layoutId, [e1, e2], context)).toEqual([]);
  });
});

describe('isFatalViolation', () => {
  const cases: Array<[TopologyViolation, boolean]> = [
    [{ kind: 'layout-mismatch', edgeId: 'e1', expectedLayoutId: 'l1', actualLayoutId: 'l2' }, true],
    [{ kind: 'duplicate-edge-id', edgeId: 'e1' }, true],
    [{ kind: 'self-loop', edgeId: 'e1', blockId: 'a' }, true],
    [{ kind: 'unknown-block', edgeId: 'e1', blockId: 'a' }, true],
    [{ kind: 'unknown-point', edgeId: 'e1', pointId: 'p1' }, false],
    [{ kind: 'duplicate-connection', edgeId: 'e1', conflictingEdgeId: 'e2' }, true],
  ];

  it.each(cases)('is fatal=%s for %o', (violation, expected) => {
    expect(isFatalViolation(violation)).toBe(expected);
  });
});

describe('describeViolations', () => {
  it('summarises the count and lists the first three violations, byte-for-byte raw ids with no book (D8)', () => {
    const violations: TopologyViolation[] = [
      { kind: 'self-loop', edgeId: 'e1', blockId: 'a' },
      { kind: 'self-loop', edgeId: 'e2', blockId: 'b' },
      { kind: 'self-loop', edgeId: 'e3', blockId: 'c' },
      { kind: 'self-loop', edgeId: 'e4', blockId: 'd' },
    ];
    const description = describeViolations(violations);
    expect(description).toMatch(/^Topology invalid: 4 violations \(first 3 shown\) —/);
    expect(description).toContain('e1');
    expect(description).toContain('e2');
    expect(description).toContain('e3');
    expect(description).not.toContain('e4');
  });

  it('uses the singular, with no "(first N shown)" suffix, for exactly one violation', () => {
    const violations: TopologyViolation[] = [{ kind: 'self-loop', edgeId: 'e1', blockId: 'a' }];
    expect(describeViolations(violations)).toBe(
      'Topology invalid: 1 violation — edge e1 is a self-loop on block a',
    );
  });

  it('renders quoted names when a book is supplied', () => {
    const violations: TopologyViolation[] = [{ kind: 'self-loop', edgeId: 'e1', blockId: 'a' }];
    const book: NameBook = {
      ...EMPTY_NAME_BOOK,
      blocks: new Map([['a', 'Down Platform']]),
      edges: new Map([['e1', 'Down Platform:north → Down Platform:south']]),
    };
    expect(describeViolations(violations, book)).toBe(
      'Topology invalid: 1 violation — edge "Down Platform:north → Down Platform:south" (e1) is a self-loop on block "Down Platform" (a)',
    );
  });
});

describe('TopologyInvalidError', () => {
  it('carries the violations and is an instanceof Error', () => {
    const violations: TopologyViolation[] = [{ kind: 'self-loop', edgeId: 'e1', blockId: 'a' }];
    const error = new TopologyInvalidError(violations);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(TopologyInvalidError);
    expect(error.violations).toEqual(violations);
    expect(error.message).toContain('e1');
  });
});
