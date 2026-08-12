/**
 * `diagram/edgeProposals` — the pure half of the edge-proposal review panel.
 *
 * Narrowly about the two things that would be silent failures in the UI: a
 * proposal being posted when it must not be (`isAcceptable`), and a note
 * losing the cell it names (`describeProposalNote`). The panel's layout is
 * exercised end-to-end in `tests/e2e/edge-proposals.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  countByStatus,
  describeConditions,
  describeConnection,
  describeProposalNote,
  isAcceptable,
  sortForReview,
} from './edgeProposals';
import { EdgeProposal, ProposalNote } from '../types';

const names = {
  blocks: new Map([
    ['b-fy1', 'Fiddle Yard 1'],
    ['b-s1', 'Siding 1'],
  ]),
  points: new Map([['p-1', 'P1 - Fiddle Yard']]),
};

const proposal = (over: Partial<EdgeProposal> = {}): EdgeProposal => ({
  pairId: 'pair-1',
  fromBlockId: 'b-fy1',
  fromEnd: 'east',
  toBlockId: 'b-s1',
  toEnd: 'west',
  pointConditions: [],
  lengthMm: null,
  via: [],
  crossesDiamond: false,
  status: 'new',
  ...over,
});

describe('isAcceptable', () => {
  it('accepts a new proposal whose ends are both named', () => {
    expect(isAcceptable(proposal())).toBe(true);
  });

  it.each(['needs-end-label', 'existing', 'conflicting'] as const)(
    'refuses a %s proposal',
    (status) => {
      expect(isAcceptable(proposal({ status }))).toBe(false);
    },
  );

  it('refuses a proposal with an unnamed end even if the server called it new', () => {
    // `reconcileProposals` downgrades a null end to `needs-end-label` before it
    // can be `new`, so this state should not reach the browser. The guard
    // establishes the property itself rather than inheriting it from that
    // ordering — posting `fromEnd: null` is a 400 the operator cannot act on.
    expect(isAcceptable(proposal({ fromEnd: null }))).toBe(false);
    expect(isAcceptable(proposal({ toEnd: null }))).toBe(false);
  });
});

describe('describeConnection', () => {
  it('names both blocks and both ends', () => {
    expect(describeConnection(proposal(), names)).toBe('Fiddle Yard 1 : east → Siding 1 : west');
  });

  it('falls back to the raw id when a block has no name, byte-for-byte', () => {
    // docs/naming.md D8: degrade to the id, never to a placeholder.
    expect(describeConnection(proposal({ toBlockId: 'b-unknown' }), names)).toBe(
      'Fiddle Yard 1 : east → b-unknown : west',
    );
  });

  it('marks an unnamed end rather than printing "null"', () => {
    expect(describeConnection(proposal({ toEnd: null }), names)).toBe(
      'Fiddle Yard 1 : east → Siding 1 : —',
    );
  });
});

describe('describeConditions', () => {
  it('names each point and the position it must stand in', () => {
    expect(
      describeConditions([{ pointId: 'p-1', requiredPosition: 'reverse' }], names),
    ).toEqual(['P1 - Fiddle Yard = reverse']);
  });
});

describe('describeProposalNote', () => {
  it('names the cell a walk stopped at', () => {
    const note: ProposalNote = { kind: 'blocked-by-unclassified', at: { x: 19, y: 5 } };
    expect(describeProposalNote(note, names)).toContain('(19, 5)');
  });

  it('names the point that has no leg mapping', () => {
    const note: ProposalNote = {
      kind: 'blocked-by-unmapped-point',
      at: { x: 11, y: 3 },
      pointId: 'p-1',
    };
    const text = describeProposalNote(note, names);
    expect(text).toContain('P1 - Fiddle Yard');
    expect(text).toContain('(11, 3)');
  });

  it('spells out the tile edge, since "nw" mid-sentence reads as a typo', () => {
    const note: ProposalNote = {
      kind: 'no-road-into-block',
      at: { x: 19, y: 8 },
      blockId: 'b-s1',
      edge: 'nw',
    };
    const text = describeProposalNote(note, names);
    expect(text).toContain('north-west');
    expect(text).toContain('Siding 1');
  });
});

describe('countByStatus', () => {
  it('counts every status, including the ones with no members', () => {
    const counts = countByStatus([
      proposal(),
      proposal({ status: 'existing' }),
      proposal({ status: 'existing' }),
    ]);
    expect(counts).toEqual({ new: 1, existing: 2, 'needs-end-label': 0, conflicting: 0 });
  });
});

describe('sortForReview', () => {
  it('puts what can be accepted first and what is already authored last', () => {
    const sorted = sortForReview([
      proposal({ status: 'existing' }),
      proposal({ status: 'needs-end-label' }),
      proposal({ status: 'new' }),
      proposal({ status: 'conflicting' }),
    ]);
    expect(sorted.map((p) => p.status)).toEqual([
      'new',
      'conflicting',
      'needs-end-label',
      'existing',
    ]);
  });
});
