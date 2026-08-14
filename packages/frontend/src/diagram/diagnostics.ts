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

import { GridDiagnostic, TileEdge } from '../types';

export interface DiagnosticNames {
  blocks: ReadonlyMap<string, string>;
  points: ReadonlyMap<string, string>;
  sensors: ReadonlyMap<string, string>;
}

/** The raw id verbatim when no name is known — never a placeholder, never nothing (docs/naming.md D8). */
const named = (id: string, names: ReadonlyMap<string, string>) => names.get(id) ?? id;

const at = (c: { x: number; y: number }) => `(${c.x}, ${c.y})`;

const atList = (cs: readonly { x: number; y: number }[]) => cs.map(at).join(', ');

/** Spelled out, because `nw` in a sentence reads as a typo rather than a direction. */
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

    case 'track-not-joined':
      // #91. Says which way the track is drawn as well as where, because the
      // two cells look joined — that is the whole problem — and the operator
      // needs to know which of the two to redraw.
      return `Track at ${at(d.at)} is drawn leaving through its ${EDGE_NAMES[d.edge]} side, but the tile at ${at(d.against)} has nothing meeting it. The block ends at that edge.`;

    case 'buffer-contradicted-by-edge':
      return `Block ${named(d.blockId, names.blocks)} opening '${d.label}' has a buffer stop, but ${d.edgeIds.length} edge(s) in the track graph leave it. The drawing and the graph disagree — recompile in Configure → Edges, or redraw the buffer.`;
  }
}

/**
 * The coordinate a diagnostic points at, if it has one — a pure sibling to
 * `describeDiagnostic` (#94) so the diagnostics panel can turn a finding into
 * a "jump to this cell" button by reading the coordinate structurally,
 * rather than parsing it back out of the prose `describeDiagnostic` builds.
 *
 * `at` is sometimes a single coordinate, sometimes a list — one entry per
 * duplicate placement — and sometimes absent entirely. `buffer-contradicted-
 * by-edge`, `end-not-on-diagram`, `pinned-end-not-on-diagram` and
 * `block-without-detection` each name a block end or a block, not a cell:
 * there is nowhere on the drawing to jump to, and those four return `null`
 * rather than a made-up coordinate. A `null` here is what stops the panel from
 * rendering a diagnostic line as a button that would go nowhere.
 *
 * The switch is exhaustive over `GridDiagnostic['kind']` with no `default`,
 * which is deliberate: the return type excludes `undefined`, so a kind added
 * to the union and forgotten here fails to compile. `track-not-joined` (#91)
 * and `pinned-end-not-on-diagram` (#92) were both added to the union without
 * a case, and both silently returned `undefined` — rendering as plain text the
 * cell they name. The compiler was saying so; nothing in CI was listening,
 * because `packages/frontend`'s `tsc` never ran there. It does now.
 */
export function diagnosticCoordinate(d: GridDiagnostic): { x: number; y: number } | null {
  switch (d.kind) {
    case 'unclassified-tile':
    case 'tile-metadata-unreadable':
    case 'dangling-tile-reference':
    case 'point-tile-unmapped':
    case 'diamond-blind-spot':
      return d.at;

    // Two cells, and the jump goes to `at` rather than `against`: `at` is the
    // tile whose track is drawn leaving, which is the one the prose leads with
    // and usually the one to redraw.
    case 'track-not-joined':
      return d.at;

    // A list of coordinates — the first is as good a place to jump to as any
    // of the others, since they are all the same duplicated placement.
    case 'duplicate-annotation':
      return d.at[0] ?? null;

    // Names a block opening, not a cell. The opening spans boundaries and the
    // label sits wherever the compiler put it; jumping to one of those would be
    // a button that lands somewhere arbitrary, which is worse than no button.
    case 'buffer-contradicted-by-edge':
      return null;
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
