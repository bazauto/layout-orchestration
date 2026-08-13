/**
 * Rendering edge proposals (#78) as operator-facing text.
 *
 * The same split as `./diagnostics.ts`, for the same reason: the backend emits
 * **structured** proposals and notes — `kind` plus ids, never prose — and the
 * wording lives here because this is where the names are. An id is paired with
 * its name wherever one is available and degrades to the raw id byte-for-byte
 * when it is not (`docs/naming.md` D8).
 *
 * Pure and separate from the component so the copy is testable without
 * rendering a table.
 *
 * ## Why acceptability is a type guard rather than a boolean
 *
 * A proposal carries `fromEnd`/`toEnd` as `string | null` — `null` meaning no
 * `block_ends` row names that opening, which is a to-do and never a guess.
 * `POST .../edges` requires both. Making the check a guard that narrows the
 * two fields to `string` is what stops the panel from ever assembling a body
 * with a null end and discovering it as a 400: the call does not compile.
 */

import { EdgeProposal, EdgeProposalStatus, PointCondition, ProposalNote, TileEdge } from '../types';

export interface ProposalNames {
  blocks: ReadonlyMap<string, string>;
  points: ReadonlyMap<string, string>;
}

/** The raw id verbatim when no name is known — never a placeholder, never nothing (docs/naming.md D8). */
const named = (id: string, names: ReadonlyMap<string, string>) => names.get(id) ?? id;

const at = (c: { x: number; y: number }) => `(${c.x}, ${c.y})`;

/** Spelled out, matching `describeDiagnostic` — `nw` mid-sentence reads as a typo rather than a direction. */
const EDGE_NAMES: Record<TileEdge, string> = {
  n: 'north',
  ne: 'north-east',
  e: 'east',
  se: 'south-east',
  s: 'south',
  sw: 'south-west',
  w: 'west',
  nw: 'north-west',
};

/**
 * A proposal both of whose ends are named, and which the graph does not
 * already carry. The only shape that may be posted.
 */
export type AcceptableProposal = EdgeProposal & {
  status: 'new';
  fromEnd: string;
  toEnd: string;
};

/**
 * Whether this proposal can be turned into an edge as it stands.
 *
 * Both end checks are made even though `reconcileProposals` already downgrades
 * a null end to `needs-end-label` before it can be `new`. That is belt and
 * braces on purpose — the guard is the thing the compiler trusts, so it must
 * establish the property itself rather than inherit it from a server-side
 * ordering a future change could reorder.
 */
export function isAcceptable(p: EdgeProposal): p is AcceptableProposal {
  return p.status === 'new' && p.fromEnd !== null && p.toEnd !== null;
}

/**
 * A stable key for one *direction* of one connection.
 *
 * Not `pairId`, which both directions deliberately share — the panel tracks an
 * accept result per row, and the two directions are two separate edges that
 * can succeed and fail independently.
 *
 * The separator is a unit separator, chosen for the reason `domain/topology.ts`
 * uses `^@`: it cannot occur in a block id or in an end label (a
 * `[a-z0-9][a-z0-9_-]*` slug), so a composite key cannot be forged by a name.
 */
const KEY_SEP = '\u001f';

export function proposalKey(p: EdgeProposal): string {
  return [p.fromBlockId, p.fromEnd ?? '', p.toBlockId, p.toEnd ?? ''].join(KEY_SEP);
}

/** `Fiddle Yard 1 : east → Siding 1 : west`, with an em dash where an end has no name. */
export function describeConnection(p: EdgeProposal, names: ProposalNames): string {
  const from = `${named(p.fromBlockId, names.blocks)} : ${p.fromEnd ?? '—'}`;
  const to = `${named(p.toBlockId, names.blocks)} : ${p.toEnd ?? '—'}`;
  return `${from} → ${to}`;
}

/** `P1 - Fiddle Yard = normal`, one per condition, in the order the walk merged them (already sorted by point id). */
export function describeConditions(
  conditions: readonly PointCondition[],
  names: ProposalNames,
): string[] {
  return conditions.map((c) => `${named(c.pointId, names.points)} = ${c.requiredPosition}`);
}

/**
 * What a status means and what to do about it.
 *
 * `existing` is reported rather than filtered out, which is #78's decision and
 * worth keeping visible in the copy: on a partly-authored layout, "the graph
 * already agrees with the drawing" is the most valuable thing this surface can
 * say, and silence is indistinguishable from "not found".
 */
export function describeStatus(status: EdgeProposalStatus): string {
  switch (status) {
    case 'new':
      return 'Not in the track graph. Accepting posts it as an ordinary edge.';
    case 'needs-end-label':
      return 'One or both openings have no block end naming them. Add or regenerate the end in the Track Editor first.';
    case 'existing':
      return 'Already authored, with the same point conditions. Nothing to do.';
    case 'conflicting':
      return 'An edge already connects these ends, but with different point conditions. Edit the existing edge below, or delete it and accept this.';
  }
}

/** Short badge text. Separate from `describeStatus` because a table cell cannot carry a sentence. */
export function statusBadge(status: EdgeProposalStatus): string {
  switch (status) {
    case 'new':
      return 'NEW';
    case 'needs-end-label':
      return 'NO END';
    case 'existing':
      return 'AUTHORED';
    case 'conflicting':
      return 'CONFLICT';
  }
}

/**
 * Why a connection that looks drawn produced no proposal.
 *
 * Each names a cell, because the point of a note is that it is a to-do with an
 * address. The walk deliberately under-proposes — stopping silently at an
 * unclassified tile finds wrong things confidently — so these lines are the
 * difference between "there is no connection here" and "I could not tell".
 */
export function describeProposalNote(note: ProposalNote, names: ProposalNames): string {
  switch (note.kind) {
    case 'blocked-by-unclassified':
      return `The walk stopped at ${at(note.at)}: that tile is neither tagged to a block nor marked decorative. Classify it and the connection through it can be proposed.`;

    case 'blocked-by-unmapped-point':
      return `The walk stopped at ${at(note.at)}: point ${named(note.pointId, names.points)} has no leg mapping, so which position selects which road is unknown. Map its roads in the Track Editor.`;

    case 'stopped-in-own-block':
      return `A path from ${named(note.blockId, names.blocks)} came back to itself at ${at(note.at)}. Not a connection to author — usually a point tile tinted as its own approach block.`;

    case 'leg-not-covered-by-road':
      return `The tile at ${at(note.at)} draws track on its ${EDGE_NAMES[note.edge]} side, but none of its point roads use that leg — so which position selects it is unknown. Add the missing road in the Track Editor.`;

    case 'no-road-out-of-block':
      return `${named(note.blockId, names.blocks)} has no drawn road out through the ${EDGE_NAMES[note.edge]} side of ${at(note.at)}: the point there joins that side only to legs outside the block. The way *in* may still be proposed — a connection can be one-way. If it should be two-way, check that tile's tint and its point roads.`;

    case 'search-truncated':
      return `The search from ${named(note.blockId, names.blocks)} at ${at(note.at)} hit its branch limit before finishing. Some connections from there may be missing.`;
  }
}

/** How many proposals sit in each status, for the panel's summary line. */
export function countByStatus(
  proposals: readonly EdgeProposal[],
): Record<EdgeProposalStatus, number> {
  const out: Record<EdgeProposalStatus, number> = {
    new: 0,
    'needs-end-label': 0,
    existing: 0,
    conflicting: 0,
  };
  for (const p of proposals) out[p.status] += 1;
  return out;
}

/**
 * Orders proposals for review: acceptable ones first, then the ones that need
 * work elsewhere, then the ones already authored.
 *
 * Stable within a status — the backend already sorts deterministically, and a
 * list that reshuffles between polls is worse than an unsorted one.
 */
const STATUS_ORDER: Record<EdgeProposalStatus, number> = {
  new: 0,
  conflicting: 1,
  'needs-end-label': 2,
  existing: 3,
};

export function sortForReview(proposals: readonly EdgeProposal[]): EdgeProposal[] {
  return [...proposals].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
}
