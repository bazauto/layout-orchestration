/**
 * Mirrors the backend's `domain/naming.ts` and the `NameBook` shape in
 * `domain/types.ts` — kept in sync manually, same posture as `types.ts`. In
 * a future phase these could be generated from a shared package; there is
 * no shared workspace package today (root `workspaces` is
 * `["packages/backend", "packages/frontend"]`), so this is a deliberate
 * duplicate rather than an import (#54, see docs/naming.md).
 */

export const MAX_LABEL_CHARS = 40;
export const SHORT_ID_CHARS = 8;

export interface NameBook {
  layouts: ReadonlyMap<string, string>;
  blocks: ReadonlyMap<string, string>;
  points: ReadonlyMap<string, string>;
  sensors: ReadonlyMap<string, string>;
  locos: ReadonlyMap<number, string>;
  /** Derived labels ("Down Platform:north → Up Loop:south"), not names — `block_edges` has no name column. */
  edges: ReadonlyMap<string, string>;
}

export function truncateLabel(value: string): string {
  if (value.length <= MAX_LABEL_CHARS) return value;
  return `${value.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

export function shortId(id: string): string {
  return id.length <= SHORT_ID_CHARS ? id : id.slice(0, SHORT_ID_CHARS);
}

/** Renders `id` as `"name" (shortid)` when a name is known, or the raw id verbatim when it is not. */
export function label(id: string, name: string | undefined): string {
  return name === undefined ? id : `"${name}" (${shortId(id)})`;
}

export function blockLabel(id: string, book?: NameBook): string {
  return label(id, book?.blocks.get(id));
}

export function pointLabel(id: string, book?: NameBook): string {
  return label(id, book?.points.get(id));
}

export function edgeLabel(id: string, book?: NameBook): string {
  return label(id, book?.edges.get(id));
}

export function locoLabel(address: number, book?: NameBook): string {
  return label(String(address), book?.locos.get(address));
}

/** Derives an edge's display label from its endpoints, mirroring `domain/naming.ts#buildEdgeLabel`. Takes UNTRUNCATED block names. */
export function buildEdgeLabel(
  edge: { fromBlockId: string; fromEnd: string; toBlockId: string; toEnd: string },
  blockNameOf: (id: string) => string | undefined,
): string {
  const from = blockNameOf(edge.fromBlockId) ?? edge.fromBlockId;
  const to = blockNameOf(edge.toBlockId) ?? edge.toBlockId;
  return truncateLabel(`${from}:${edge.fromEnd} → ${to}:${edge.toEnd}`);
}

/** `${n} ${singular}` for 1, `${n} ${plural ?? singular + 's'}` otherwise. */
export function pluralise(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}
