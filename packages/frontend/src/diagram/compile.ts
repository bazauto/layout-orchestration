/**
 * Rendering a compile report as operator-facing text (#103 PR 5).
 *
 * The same split as `./diagnostics.ts` and for the same reason: the backend
 * emits **structured** gaps and edges — `kind` plus ids, never prose — and the
 * wording lives here because this is where the names are. An id is paired with
 * its name wherever one is available and degrades to the raw id byte-for-byte
 * when it is not (`docs/naming.md` D8).
 *
 * Pure and separate from the component, so the copy is testable without
 * rendering a table.
 *
 * ## Why gaps sort above their own evidence
 *
 * D7's whole argument is that a per-cell note is necessary and nowhere near
 * sufficient. When P1's tile was tinted `Fiddle Yard 1`, the walk emitted three
 * notes saying where it had stopped and never once said that three blocks had
 * become unreachable. "Fiddle Yard 2 has no connections" is the sentence that
 * matters; "no road into block at (11,3)" reads as authoring noise until you
 * already know what you are looking for.
 *
 * So `gapRank` puts the three graph-level assertions first and the evidence
 * under them. The backend sorts gaps alphabetically by kind, which is
 * deterministic and says nothing about importance; this is where importance is
 * expressed.
 */

import { BlockEdgeRecord, CompileDiff, CompileGap, CompiledEdge, PointCondition, TileEdge } from '../types';

export interface CompileNames {
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

/** `Fiddle Yard 1 : east → Siding 1 : west`. Both ends are always named — a compiled edge cannot carry a null. */
export function describeConnection(
  e: Pick<CompiledEdge, 'fromBlockId' | 'fromEnd' | 'toBlockId' | 'toEnd'>,
  names: CompileNames,
): string {
  return `${named(e.fromBlockId, names.blocks)} : ${e.fromEnd} → ${named(e.toBlockId, names.blocks)} : ${e.toEnd}`;
}

/** `P1 - Fiddle Yard = normal`, one per condition, in the order the walk merged them (already sorted by point id). */
export function describeConditions(
  conditions: readonly PointCondition[],
  names: CompileNames,
): string[] {
  return conditions.map((c) => `${named(c.pointId, names.points)} = ${c.requiredPosition}`);
}

/**
 * What a gap means and what to do about it.
 *
 * Exhaustive over `CompileGap['kind']` with no `default`, deliberately: the
 * return type excludes `undefined`, so a kind added to the union and forgotten
 * here fails the build rather than rendering as blank. `diagnostics.ts` records
 * why that matters — two kinds were added to `GridDiagnostic` without a case
 * and silently rendered nothing.
 */
export function describeGap(gap: CompileGap, names: CompileNames): string {
  switch (gap.kind) {
    // ── D7's graph-level assertions ──
    case 'block-not-in-graph':
      return `${named(gap.blockId, names.blocks)} is drawn but appears in no connection at all — nothing can route to or from it. The evidence below says where the walk stopped.`;

    case 'block-without-detection':
      return `${named(gap.blockId, names.blocks)} is in the graph but no in-service sensor reports on it, so its occupancy can only ever be unknown.`;

    case 'opening-unresolved':
      return `${named(gap.blockId, names.blocks)} opens at '${gap.label}' near ${at(gap.at)} and the track there leads nowhere the compiler can name. Draw the connection, or a buffer stop if it really ends.`;

    // ── Whole-tile problems ──
    case 'dangling-block-reference':
      return `The tile at ${at(gap.at)} is tinted for block ${named(gap.blockId, names.blocks)}, which no longer exists. Re-tint it or the connections through it are lost.`;

    case 'tile-metadata-unreadable':
      return `The tile at ${at(gap.at)} has metadata this version cannot read. It still draws; nothing else about it is known. Repaint it to rewrite it.`;

    case 'opening-unnamed':
      return `An opening of ${named(gap.blockId, names.blocks)} near ${at(gap.at)} could not be named, so no edge can reference it.`;

    // ── Per-cell walk evidence ──
    case 'blocked-by-unclassified':
      return `The walk stopped at ${at(gap.at)}: that tile is neither tagged to a block nor marked decorative. Classify it and the connection through it compiles.`;

    case 'blocked-by-unmapped-point':
      return `The walk stopped at ${at(gap.at)}: point ${named(gap.pointId, names.points)} has no leg mapping, so which position selects which road is unknown. Map its roads in the Track Editor.`;

    case 'leg-not-covered-by-road':
      return `The tile at ${at(gap.at)} draws track on its ${EDGE_NAMES[gap.edge]} side, but none of its point roads use that leg — so which position selects it is unknown. Add the missing road in the Track Editor.`;

    case 'no-road-out-of-block':
      return `${named(gap.blockId, names.blocks)} has no drawn road out through the ${EDGE_NAMES[gap.edge]} side of ${at(gap.at)}: the point there joins that side only to legs outside the block. The way *in* may still compile — a connection can be one-way. If it should be two-way, check that tile's tint and its point roads.`;

    case 'search-truncated':
      return `The search from ${named(gap.blockId, names.blocks)} at ${at(gap.at)} hit its branch limit before finishing. Some connections from there may be missing.`;
  }
}

/**
 * Sort weight for a gap: 0 for D7's graph-level assertions, 1 for the per-cell
 * evidence under them.
 *
 * Two bands rather than eleven ranks. Within a band the backend's order is kept
 * — it is deterministic, and a list that reshuffles between compiles is worse
 * than one that is merely alphabetical.
 */
export function gapRank(gap: CompileGap): 0 | 1 {
  switch (gap.kind) {
    case 'block-not-in-graph':
    case 'block-without-detection':
    case 'opening-unresolved':
      return 0;
    default:
      return 1;
  }
}

/** Graph-level assertions first, evidence under them; stable within each band. */
export function sortGapsForReview(gaps: readonly CompileGap[]): CompileGap[] {
  return [...gaps].sort((a, b) => gapRank(a) - gapRank(b));
}

/**
 * The diff as a flat list of rows to render, in review order.
 *
 * The order is the order the buckets matter in. `changed` leads because it is
 * the one an operator must not skim past: the same two openings, now requiring
 * different blades, which is a live route planned over a point set the other
 * way. `unchanged` is last and is still shown, because "the graph already
 * agrees with the drawing" is the most useful thing this surface can say about
 * a layout that is part-authored, and silence is indistinguishable from "not
 * found".
 */
export type CompileRowKind = 'changed' | 'added' | 'removed' | 'relabelled' | 'unchanged';

export interface CompileRow {
  kind: CompileRowKind;
  /** Stable within one report — see `rowKey`. */
  key: string;
  /** The candidate side, where there is one. Absent on `removed`. */
  proposed?: CompiledEdge;
  /** The live side, where there is one. Absent on `added`. */
  live?: BlockEdgeRecord;
}

const ROW_ORDER: CompileRowKind[] = ['changed', 'added', 'removed', 'relabelled', 'unchanged'];

/**
 * A stable key for one row.
 *
 * The separator is a unit separator, chosen for the reason `domain/topology.ts`
 * uses `^@`: it cannot occur in a block id or in an end label (a
 * `[a-z0-9][a-z0-9_-]*` slug), so a composite key cannot be forged by a name.
 * The kind is part of the key because a `relabelled` pair and an `unchanged`
 * row can name the same two blocks.
 */
const KEY_SEP = '\u001f';

function rowKey(kind: CompileRowKind, e: Pick<CompiledEdge, 'fromBlockId' | 'fromEnd' | 'toBlockId' | 'toEnd'>): string {
  return [kind, e.fromBlockId, e.fromEnd, e.toBlockId, e.toEnd].join(KEY_SEP);
}

export function diffRows(diff: CompileDiff): CompileRow[] {
  const byKind: Record<CompileRowKind, CompileRow[]> = {
    changed: diff.changed.map((c) => ({
      kind: 'changed' as const,
      key: rowKey('changed', c.proposed),
      proposed: c.proposed,
      live: c.live,
    })),
    added: diff.added.map((e) => ({ kind: 'added' as const, key: rowKey('added', e), proposed: e })),
    removed: diff.removed.map((e) => ({ kind: 'removed' as const, key: rowKey('removed', e), live: e })),
    relabelled: diff.relabelled.map((c) => ({
      kind: 'relabelled' as const,
      key: rowKey('relabelled', c.proposed),
      proposed: c.proposed,
      live: c.live,
    })),
    unchanged: diff.unchanged.map((e) => ({
      kind: 'unchanged' as const,
      key: rowKey('unchanged', e),
      live: e,
    })),
  };

  return ROW_ORDER.flatMap((kind) => byKind[kind]);
}

/** How many rows sit in each bucket, for the panel's summary line. */
export function countByKind(diff: CompileDiff): Record<CompileRowKind, number> {
  return {
    changed: diff.changed.length,
    added: diff.added.length,
    removed: diff.removed.length,
    relabelled: diff.relabelled.length,
    unchanged: diff.unchanged.length,
  };
}

/**
 * Whether applying this report would change the stored graph.
 *
 * `unchanged` and `relabelled` are both excluded, for different reasons.
 * `unchanged` is obvious. `relabelled` is a rewrite of a disposable label (D8)
 * and changes no physical connection — offering Apply for it alone would be
 * asking the operator to approve a graph that means exactly what the current
 * one means.
 *
 * Note this is about the **button**, not about correctness: an apply of a
 * label-only difference is perfectly safe, it is just not worth a click.
 */
export function hasSubstantiveChange(diff: CompileDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

/** Short badge text. Separate from the row itself because a table cell cannot carry a sentence. */
export function rowBadge(kind: CompileRowKind): string {
  switch (kind) {
    case 'changed':
      return 'CHANGED';
    case 'added':
      return 'ADD';
    case 'removed':
      return 'REMOVE';
    case 'relabelled':
      return 'RENAMED';
    case 'unchanged':
      return 'SAME';
  }
}

/** What a row means, and why it is worth or not worth attention. Rendered as a `title`. */
export function describeRowKind(kind: CompileRowKind): string {
  switch (kind) {
    case 'changed':
      return 'The same two openings, but the drawing now requires different point positions. Read this one.';
    case 'added':
      return 'The drawing implies this connection and the graph does not have it.';
    case 'removed':
      return 'The graph has this connection and the drawing no longer implies it. Applying deletes it.';
    case 'relabelled':
      return 'The same physical connection under a different end label. Labels are regenerated on every compile and reference nothing.';
    case 'unchanged':
      return 'The graph already agrees with the drawing. Nothing to do.';
  }
}

/**
 * The count of components, worded for an operator.
 *
 * Reported and never gated (D-B): two legitimately separate railways in one
 * layout are legal, and a component count has no acknowledge mechanism, so
 * gating on it would refuse `auto` forever with nothing to clear.
 */
export function describeComponents(components: readonly string[][], names: CompileNames): string {
  const sizes = components.map((c) => `${c.length} block${c.length === 1 ? '' : 's'} (${c.map((b) => named(b, names.blocks)).join(', ')})`);
  return `The drawing compiles to ${components.length} separate railways: ${sizes.join('; ')}. That is legal — reported so it is not a surprise.`;
}
