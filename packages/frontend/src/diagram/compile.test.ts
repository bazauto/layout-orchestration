/**
 * `diagram/compile` — the copy and the ordering of the compile review panel.
 *
 * Two things are defended here. **Every gap kind renders**, because the switch
 * is exhaustive and a kind added to the union without a case is a blank line in
 * front of an operator — `diagnostics.ts` has been bitten by exactly that
 * twice. And **graph-level assertions sort above their own evidence**, which is
 * D7's whole argument expressed as a sort: "Fiddle Yard 2 has no connections"
 * must not be buried under three notes about cells.
 */

import { describe, expect, it } from 'vitest';
import {
  countByKind,
  describeComponents,
  describeConditions,
  describeConnection,
  describeGap,
  describeRowKind,
  diffRows,
  gapRank,
  hasSubstantiveChange,
  rowBadge,
  sortGapsForReview,
  type CompileRowKind,
} from './compile';
import { BlockEdgeRecord, CompileDiff, CompileGap, CompiledEdge } from '../types';

const names = {
  blocks: new Map([
    ['fy1', 'Fiddle Yard 1'],
    ['fy2', 'Fiddle Yard 2'],
  ]),
  points: new Map([['p1', 'P1 - Fiddle Yard']]),
};

const compiled = (over: Partial<CompiledEdge> = {}): CompiledEdge => ({
  fromBlockId: 'fy1',
  fromEnd: 'east',
  toBlockId: 'fy2',
  toEnd: 'west',
  pointConditions: [],
  via: [],
  crossesDiamond: false,
  ...over,
});

const live = (over: Partial<BlockEdgeRecord> = {}): BlockEdgeRecord => ({
  id: 'e1',
  layoutId: 'layout-1',
  fromBlockId: 'fy1',
  fromEnd: 'east',
  toBlockId: 'fy2',
  toEnd: 'west',
  pointConditions: [],
  ...over,
});

const emptyDiff = (): CompileDiff => ({
  added: [],
  removed: [],
  unchanged: [],
  changed: [],
  relabelled: [],
});

/** One of every `CompileGap` member. A new kind added to the union belongs here. */
const ALL_GAPS: CompileGap[] = [
  { kind: 'block-not-in-graph', blockId: 'fy2' },
  { kind: 'block-without-detection', blockId: 'fy1' },
  { kind: 'opening-unresolved', blockId: 'fy1', label: 'east', at: { x: 3, y: 4 } },
  { kind: 'dangling-block-reference', at: { x: 5, y: 1 }, blockId: 'ghost' },
  { kind: 'tile-metadata-unreadable', at: { x: 9, y: 9 } },
  { kind: 'opening-unnamed', blockId: 'fy1', at: { x: 2, y: 2 } },
  { kind: 'blocked-by-unclassified', at: { x: 11, y: 3 } },
  { kind: 'blocked-by-unmapped-point', at: { x: 12, y: 3 }, pointId: 'p1' },
  { kind: 'leg-not-covered-by-road', at: { x: 12, y: 3 }, edge: 'nw' },
  { kind: 'no-road-out-of-block', at: { x: 12, y: 3 }, blockId: 'fy1', edge: 's' },
  { kind: 'search-truncated', blockId: 'fy1', at: { x: 0, y: 0 } },
];

describe('describeGap', () => {
  it('renders every member of the union as non-empty prose', () => {
    for (const gap of ALL_GAPS) {
      const text = describeGap(gap, names);
      expect(text, gap.kind).toBeTruthy();
      expect(text.length, gap.kind).toBeGreaterThan(20);
    }
  });

  it('names a block by its operator-facing name, and degrades to the raw id', () => {
    expect(describeGap({ kind: 'block-not-in-graph', blockId: 'fy2' }, names)).toContain(
      'Fiddle Yard 2',
    );
    // docs/naming.md D8: the raw id verbatim, never a placeholder, never nothing.
    expect(describeGap({ kind: 'block-not-in-graph', blockId: 'nameless' }, names)).toContain(
      'nameless',
    );
  });

  it('spells a tile edge out, because `nw` mid-sentence reads as a typo', () => {
    expect(
      describeGap({ kind: 'leg-not-covered-by-road', at: { x: 1, y: 2 }, edge: 'nw' }, names),
    ).toContain('north-west');
  });

  it('gives every cell-level gap an address to go and look at', () => {
    const withCells = ALL_GAPS.filter((g) => 'at' in g);
    expect(withCells.length).toBeGreaterThan(0);
    for (const gap of withCells) {
      const { x, y } = (gap as { at: { x: number; y: number } }).at;
      expect(describeGap(gap, names), gap.kind).toContain(`(${x}, ${y})`);
    }
  });
});

describe('sortGapsForReview', () => {
  it('puts D7 graph-level assertions above the evidence for them', () => {
    // The backend sorts alphabetically by kind, which is deterministic and says
    // nothing about importance. `blocked-by-unclassified` therefore arrives
    // first, above the block-level assertion it is evidence for.
    const sorted = sortGapsForReview([
      { kind: 'blocked-by-unclassified', at: { x: 11, y: 3 } },
      { kind: 'block-not-in-graph', blockId: 'fy2' },
    ]);

    expect(sorted.map((g) => g.kind)).toEqual(['block-not-in-graph', 'blocked-by-unclassified']);
  });

  it('ranks exactly the three assertions as graph-level', () => {
    const top = ALL_GAPS.filter((g) => gapRank(g) === 0).map((g) => g.kind);
    expect(top).toEqual(['block-not-in-graph', 'block-without-detection', 'opening-unresolved']);
  });

  it('is stable within a band, so the list does not reshuffle between compiles', () => {
    const evidence = ALL_GAPS.filter((g) => gapRank(g) === 1);
    expect(sortGapsForReview(evidence).map((g) => g.kind)).toEqual(evidence.map((g) => g.kind));
  });
});

describe('diffRows', () => {
  it('leads with `changed`, because it is the one that must not be skimmed past', () => {
    // Same two openings, different blades. Everything else in the diff is a
    // connection appearing or disappearing, which is visible; this one looks
    // like an existing row until you read the conditions.
    const rows = diffRows({
      ...emptyDiff(),
      added: [compiled({ toBlockId: 'other' })],
      unchanged: [live({ id: 'u1' })],
      changed: [
        {
          live: live({ id: 'c1' }),
          proposed: compiled({ pointConditions: [{ pointId: 'p1', requiredPosition: 'reverse' }] }),
        },
      ],
    });

    expect(rows[0].kind).toBe('changed');
    expect(rows[rows.length - 1].kind).toBe('unchanged');
  });

  it('gives every row a key unique within the report', () => {
    // The same two blocks can appear as `relabelled` and as `unchanged` in one
    // report, so the kind is part of the key. A duplicate key is a React
    // rendering bug that shows up as rows disappearing.
    const rows = diffRows({
      ...emptyDiff(),
      unchanged: [live({ id: 'u1' })],
      relabelled: [{ live: live({ id: 'r1', fromEnd: 'east-1' }), proposed: compiled() }],
    });

    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('carries the live side on a removal and the candidate side on an addition', () => {
    const rows = diffRows({
      ...emptyDiff(),
      added: [compiled()],
      removed: [live({ id: 'gone' })],
    });

    const added = rows.find((r) => r.kind === 'added')!;
    const removed = rows.find((r) => r.kind === 'removed')!;

    expect(added.proposed).toBeDefined();
    expect(added.live).toBeUndefined();
    // A removal has no candidate — that absence *is* the finding.
    expect(removed.live).toBeDefined();
    expect(removed.proposed).toBeUndefined();
  });
});

describe('hasSubstantiveChange', () => {
  it('is false for an empty diff and for one that is only relabelling', () => {
    expect(hasSubstantiveChange(emptyDiff())).toBe(false);

    // A label is disposable compiler output (D8) and names no physical
    // difference, so applying it would ask the operator to approve a graph that
    // means exactly what the current one means.
    expect(
      hasSubstantiveChange({
        ...emptyDiff(),
        relabelled: [{ live: live(), proposed: compiled({ fromEnd: 'east-1' }) }],
        unchanged: [live({ id: 'u1' })],
      }),
    ).toBe(false);
  });

  it.each<[string, Partial<CompileDiff>]>([
    ['an addition', { added: [compiled()] }],
    ['a removal', { removed: [live()] }],
    ['a condition change', { changed: [{ live: live(), proposed: compiled() }] }],
  ])('is true for %s', (_name, over) => {
    expect(hasSubstantiveChange({ ...emptyDiff(), ...over })).toBe(true);
  });
});

describe('countByKind', () => {
  it('counts each bucket separately', () => {
    expect(
      countByKind({
        added: [compiled(), compiled({ toEnd: 'north' })],
        removed: [live()],
        unchanged: [],
        changed: [],
        relabelled: [{ live: live(), proposed: compiled() }],
      }),
    ).toEqual({ added: 2, removed: 1, unchanged: 0, changed: 0, relabelled: 1 });
  });
});

describe('badges and row descriptions', () => {
  const kinds: CompileRowKind[] = ['changed', 'added', 'removed', 'relabelled', 'unchanged'];

  it('gives every kind a badge and a sentence', () => {
    // #81: colour is never the sole carrier of meaning, so each row must carry
    // text a reader can act on without seeing the styling at all.
    for (const kind of kinds) {
      expect(rowBadge(kind), kind).toBeTruthy();
      expect(describeRowKind(kind).length, kind).toBeGreaterThan(20);
    }
  });

  it('says plainly that applying a removal deletes the connection', () => {
    expect(describeRowKind('removed')).toContain('deletes');
  });
});

describe('describeConnection and describeConditions', () => {
  it('renders both ends with their block names', () => {
    expect(describeConnection(compiled(), names)).toBe('Fiddle Yard 1 : east → Fiddle Yard 2 : west');
  });

  it('names a point and its required position', () => {
    expect(
      describeConditions([{ pointId: 'p1', requiredPosition: 'reverse' }], names),
    ).toEqual(['P1 - Fiddle Yard = reverse']);
  });
});

describe('describeComponents', () => {
  it('reports separate railways as legal rather than as a fault', () => {
    // D-B: gating on component count would refuse `auto` forever with nothing
    // for the operator to acknowledge, so the wording must not read as an error.
    const text = describeComponents([['fy1'], ['fy2']], names);
    expect(text).toContain('2 separate railways');
    expect(text).toContain('legal');
  });
});
