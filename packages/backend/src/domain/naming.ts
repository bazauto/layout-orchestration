/**
 * Rendering an id as an operator-readable label (#54, see `docs/naming.md`
 * for the full decision record D1–D10). Pure: imports only from `./types`.
 * A `NameBook` is passed as plain data to every helper here — never a port
 * or a service, so the domain stays dependency-free (CLAUDE.md architecture
 * rule). Every `describe*` function elsewhere in `domain/` takes an optional
 * trailing `book?: NameBook`; with no book (or a miss), every helper here
 * degrades to the raw id, byte-for-byte identical to the pre-#54 output (D8).
 */

import { BlockEdge, BlockEdgeId, BlockId, LayoutId, LocoAddress, NameBook, PointId, SensorId } from './types';

/** Every book value is truncated to this many characters at build time (D6). */
export const MAX_LABEL_CHARS = 40;

/** Characters of an id shown alongside a name, so a log line still correlates with the structured fields and the API (D6). */
export const SHORT_ID_CHARS = 8;

/** A `NameBook` with all six maps empty, for a caller with no book available. */
export const EMPTY_NAME_BOOK: NameBook = Object.freeze({
  layouts: new Map(),
  blocks: new Map(),
  points: new Map(),
  sensors: new Map(),
  locos: new Map(),
  edges: new Map(),
});

/** Cuts `value` to `MAX_LABEL_CHARS`, replacing the trailing character with `…` when it overflows. */
export function truncateLabel(value: string): string {
  if (value.length <= MAX_LABEL_CHARS) return value;
  return `${value.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

/** The first `SHORT_ID_CHARS` characters of `id`, or the whole id when it is already shorter. */
export function shortId(id: string): string {
  return id.length <= SHORT_ID_CHARS ? id : id.slice(0, SHORT_ID_CHARS);
}

/**
 * Renders `id` as `"name" (shortid)` when a name is known, or the raw id
 * verbatim when it is not — the D8 degradation path, and the one every
 * `*Label` helper below funnels through.
 */
export function label(id: string, name: string | undefined): string {
  return name === undefined ? id : `"${name}" (${shortId(id)})`;
}

export function layoutLabel(id: LayoutId, book?: NameBook): string {
  return label(id, book?.layouts.get(id));
}

export function blockLabel(id: BlockId, book?: NameBook): string {
  return label(id, book?.blocks.get(id));
}

export function pointLabel(id: PointId, book?: NameBook): string {
  return label(id, book?.points.get(id));
}

export function sensorLabel(id: SensorId, book?: NameBook): string {
  return label(id, book?.sensors.get(id));
}

export function edgeLabel(id: BlockEdgeId, book?: NameBook): string {
  return label(id, book?.edges.get(id));
}

/**
 * A loco address is meaningful to an operator on its own — `shortId(String(3))
 * === '3'` is the right fallback, not a UUID prefix, so this goes through
 * `label` with the address stringified rather than through `shortId` on some
 * other id.
 */
export function locoLabel(address: LocoAddress, book?: NameBook): string {
  return label(String(address), book?.locos.get(address));
}

/**
 * Derives an edge's display label from its endpoints — `block_edges` has no
 * name column, so there is nothing to look up directly (D1). Takes
 * UNTRUNCATED block names; the assembled label is what gets truncated, not
 * each half of it.
 */
export function buildEdgeLabel(
  edge: Pick<BlockEdge, 'fromBlockId' | 'fromEnd' | 'toBlockId' | 'toEnd'>,
  blockNameOf: (id: BlockId) => string | undefined,
): string {
  const from = blockNameOf(edge.fromBlockId) ?? edge.fromBlockId;
  const to = blockNameOf(edge.toBlockId) ?? edge.toBlockId;
  return truncateLabel(`${from}:${edge.fromEnd} → ${to}:${edge.toEnd}`);
}

/** `${n} ${singular}` for 1, `${n} ${plural ?? singular + 's'}` otherwise. */
export function pluralise(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}
