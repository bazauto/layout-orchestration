/**
 * Rendering grid diagnostics as operator-facing text.
 *
 * The backend emits **structured** findings — `kind` plus ids — and never a
 * prose message, matching how `TopologyViolation` has always worked. The
 * wording lives here because this is where the names are: the editor already
 * holds the block, point and sensor records, and `docs/naming.md` requires an
 * id to be paired with its name wherever one is available, degrading to the
 * raw id byte-for-byte when it is not (D8).
 *
 * Pure and separate from the component so the copy is testable without
 * rendering an SVG.
 */

import { GridDiagnostic } from '../types';

export interface DiagnosticNames {
  blocks: ReadonlyMap<string, string>;
  points: ReadonlyMap<string, string>;
  sensors: ReadonlyMap<string, string>;
}

/** The raw id verbatim when no name is known — never a placeholder, never nothing (docs/naming.md D8). */
const named = (id: string, names: ReadonlyMap<string, string>) => names.get(id) ?? id;

const at = (c: { x: number; y: number }) => `(${c.x}, ${c.y})`;

const atList = (cs: readonly { x: number; y: number }[]) => cs.map(at).join(', ');

export function describeDiagnostic(d: GridDiagnostic, names: DiagnosticNames): string {
  switch (d.kind) {
    case 'unclassified-tile':
      return `Tile ${at(d.at)} is neither tagged to a block nor marked decorative — classify it so it stops looking like an oversight.`;

    case 'tile-metadata-unreadable':
      return `Tile ${at(d.at)} has metadata this version cannot read. It still draws; nothing else about it is known. Repaint it to rewrite it.`;

    case 'dangling-tile-reference':
      return `Tile ${at(d.at)} references ${d.refKind} ${d.recordId}, which no longer exists in this layout.`;

    case 'point-tile-unmapped':
      return `Point ${named(d.pointId, names.points)} at ${at(d.at)} has no leg mapping, so a mimic cannot draw which way it is set.`;

    case 'duplicate-annotation':
      return `${d.entityType === 'sensor' ? `Sensor ${named(d.entityId, names.sensors)}` : `${d.entityType} ${d.entityId}`} is placed on ${d.at.length} tiles (${atList(d.at)}). It is one physical thing.`;

    case 'diamond-blind-spot':
      // #83 item 4. Worth saying plainly rather than as a footnote: the editor
      // will let you draw a piece of trackwork the safety model cannot see.
      return `Plain diamond crossing at ${at(d.at)}: route conflicts through it are NOT detected (#26). Two routes can be granted across it.`;

    case 'buffer-contradicted-by-edge':
      return `Block ${named(d.blockId, names.blocks)} end '${d.label}' has a buffer stop, but ${d.edgeIds.length} edge(s) leave it. The drawing and the track graph disagree.`;

    case 'end-unfinished':
      return `Block ${named(d.blockId, names.blocks)} end '${d.label}' at ${at(d.at)} has no edges and no buffer — an edge still to author, or a buffer still to draw.`;

    case 'end-not-on-diagram':
      return `Block ${named(d.blockId, names.blocks)} end '${d.label}' is referenced by edges but has nowhere on the drawing to sit.`;

    case 'end-label-collision':
      return `Block ${named(d.blockId, names.blocks)} has two openings facing '${d.label}' (${atList(d.at)}). Name one of them by hand — the generator will not guess.`;

    case 'block-without-detection':
      return `Block ${named(d.blockId, names.blocks)} is drawn but no in-service sensor reports on it, so its occupancy can only ever be unknown.`;
  }
}

/** Groups by severity for display; `warning` first, because `info` is mostly a to-do list. */
export function partitionDiagnostics(diagnostics: readonly GridDiagnostic[]): {
  warnings: GridDiagnostic[];
  info: GridDiagnostic[];
} {
  return {
    warnings: diagnostics.filter((d) => d.severity === 'warning'),
    info: diagnostics.filter((d) => d.severity === 'info'),
  };
}
