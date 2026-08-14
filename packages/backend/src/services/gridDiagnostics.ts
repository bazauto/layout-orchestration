/**
 * Grid diagnostics — everything the drawing and the track graph can disagree
 * about, derived rather than remembered.
 *
 * ## Why this is a separate read-only surface
 *
 * The grid and `block_edges` describe the same railway twice, by hand, and
 * until now nothing checked that the two agreed. That is the root cause behind
 * most of wave 2: unverifiable point placements, absent sensor positions, and
 * a mostly-unauthored edge set that nothing distinguished from a finished one.
 *
 * These checks close that gap **without giving a tile any authority**. Every
 * finding is advisory. Nothing here refuses a write, and nothing here reaches
 * `SystemHealth`:
 *
 * - A buffer contradicted by an edge is a *drawing-versus-graph* disagreement,
 *   not a topology violation. `TopologyService` must not start refusing edge
 *   writes because of a tile (#84).
 * - An unfinished layout is a normal state, not an error. Half of what this
 *   produces on Westgate Hollow today is a to-do list, and a to-do list styled
 *   as a wall of errors trains the operator to ignore it.
 *
 * Hence two severities, on a rule: **`warning` means two representations
 * disagree, or a known hazard is drawn. `info` means authoring is unfinished.**
 *
 * ## What a buffer means, and what it still does not
 *
 * A buffer tile asserts "track ends here, nothing continues beyond", and that
 * is checkable against `block_edges`. It is **not** a route-safety mechanism:
 * the pathfinder already cannot plan beyond a block end with no outgoing edge,
 * and the absence of that edge remains the authority. A buffer is an authoring
 * cross-check and a UI affordance.
 */

import {
  AnnotationEntityType,
  BlockEdge,
  BlockId,
  PointId,
  TileEdge,
  classifyTile,
  depictsPoint,
} from '../domain/types';
import {
  CompiledOpening,
  Coordinate,
  GeometryTile,
  UnjoinedEdge,
} from './gridGeometry';

export type DiagnosticSeverity = 'warning' | 'info';

export type GridDiagnostic =
  /** #71 — a tile that is neither tagged to a block nor declared deliberately decorative. The to-do list for the manual classification pass. */
  | { kind: 'unclassified-tile'; severity: 'info'; at: Coordinate }
  /** A tile whose metadata blob predates the closed schema and could not be read. It still draws; nothing else about it is known. */
  | { kind: 'tile-metadata-unreadable'; severity: 'warning'; at: Coordinate }
  /** A tile referencing a record that has since been deleted. The write path cannot catch this — the delete happens elsewhere. */
  | {
      kind: 'dangling-tile-reference';
      severity: 'warning';
      at: Coordinate;
      refKind: 'block' | 'point' | 'sensor';
      recordId: string;
    }
  /** #73 — a tile depicting a point with no leg mapping, so a mimic cannot draw its position. */
  | { kind: 'point-tile-unmapped'; severity: 'info'; at: Coordinate; pointId: PointId }
  /** #74 — one entity annotated on more than one tile. It is one physical thing; the diagram says otherwise. */
  | {
      kind: 'duplicate-annotation';
      severity: 'warning';
      entityType: AnnotationEntityType;
      entityId: string;
      at: Coordinate[];
    }
  /** #83 item 4 / #26 — a plain diamond is drawn, and route conflicts through it are not detected. */
  | { kind: 'diamond-blind-spot'; severity: 'warning'; at: Coordinate }
  /** #91 — drawn track runs into a tile that draws nothing back. The drawing looks continuous and the block ends there. */
  | {
      kind: 'track-not-joined';
      severity: 'warning';
      at: Coordinate;
      edge: TileEdge;
      against: Coordinate;
    }
  /**
   * #84 — a buffer says this opening is finished; a live edge says track
   * continues through it. One of them is wrong (OQ3).
   *
   * The **only** end-related diagnostic left, and the only one that could
   * survive #103: it compares two representations that still both exist — the
   * drawing, and the `block_edges` a past compile wrote. Everything else in
   * this family compared the drawing against `block_ends`, which is gone.
   *
   * Note what it now catches that it could not before. The graph is a snapshot
   * of some earlier compile; drawing a buffer across an opening that graph
   * routes through is exactly the drift a stale graph produces, and it is
   * visible here before anyone recompiles. `docs/topology.md`'s staleness
   * warning says the graph is behind; this says where.
   */
  | {
      kind: 'buffer-contradicted-by-edge';
      severity: 'warning';
      blockId: BlockId;
      label: string;
      edgeIds: string[];
    };

export interface DiagnosticsInput {
  tiles: readonly GeometryTile[];
  /** Coordinates whose metadata blob failed to parse — `parseTileMetadata` reported them rather than throwing. */
  unreadableTiles: readonly Coordinate[];
  blocks: readonly { id: string }[];
  points: readonly { id: string }[];
  sensors: readonly { id: string; blockId: string | null; inService: boolean }[];
  edges: readonly BlockEdge[];
  /** Compiler output (D8), not stored rows: every drawn opening, named, none refused. */
  openings: readonly CompiledOpening[];
  /** #91 — places one tile's drawn track runs into another that draws nothing back. */
  unjoined: readonly UnjoinedEdge[];
}

/**
 * Runs every check. Pure: the caller assembles the input, this decides
 * nothing about the world and writes nothing.
 *
 * Output is sorted so the editor's list does not reshuffle between polls —
 * a warning that moves while you are reading it is worse than no warning.
 */
export function runGridDiagnostics(input: DiagnosticsInput): GridDiagnostic[] {
  const out: GridDiagnostic[] = [];

  out.push(...tileDiagnostics(input));
  out.push(...unjoinedDiagnostics(input));
  out.push(...annotationDiagnostics(input));
  out.push(...openingDiagnostics(input));

  return out.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.kind.localeCompare(b.kind) ||
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

const severityRank = (s: DiagnosticSeverity) => (s === 'warning' ? 0 : 1);

function tileDiagnostics(input: DiagnosticsInput): GridDiagnostic[] {
  const out: GridDiagnostic[] = [];
  const blockIds = new Set(input.blocks.map((b) => b.id));
  const pointIds = new Set(input.points.map((p) => p.id));
  const sensorIds = new Set(input.sensors.map((s) => s.id));

  for (const at of input.unreadableTiles) {
    out.push({ kind: 'tile-metadata-unreadable', severity: 'warning', at });
  }

  for (const tile of input.tiles) {
    const at = { x: tile.x, y: tile.y };
    const meta = tile.metadata;

    if (classifyTile(meta) === 'unclassified') {
      out.push({ kind: 'unclassified-tile', severity: 'info', at });
    }

    if (meta.blockId !== undefined && !blockIds.has(meta.blockId)) {
      out.push({
        kind: 'dangling-tile-reference',
        severity: 'warning',
        at,
        refKind: 'block',
        recordId: meta.blockId,
      });
    }

    if (meta.pointId !== undefined && !pointIds.has(meta.pointId)) {
      out.push({
        kind: 'dangling-tile-reference',
        severity: 'warning',
        at,
        refKind: 'point',
        recordId: meta.pointId,
      });
    }

    for (const annotation of meta.annotations ?? []) {
      const known = annotation.entityType === 'sensor' && sensorIds.has(annotation.entityId);
      if (!known) {
        out.push({
          kind: 'dangling-tile-reference',
          severity: 'warning',
          at,
          refKind: annotation.entityType,
          recordId: annotation.entityId,
        });
      }
    }

    // A tile depicting a point with no road mapping: the mimic can be told the
    // point is reverse and still not know which line to draw. Cheap to author
    // now while the points are being placed; a retrofit means revisiting every
    // point tile by hand (#73).
    //
    // Gated on the tile *type*, not on `pointId` alone (#92). A point is drawn
    // as two tiles — the point tile, and a `straight-45` companion carrying the
    // divergent road to the adjacent row — and both are tagged with the same
    // `pointId`. Only the first has legs to map: `defaultPointRoads` returns
    // nothing for the companion and the editor hides the mapping control for
    // it, so asking for one was asking for something no operator could give.
    if (
      meta.pointId !== undefined &&
      depictsPoint(tile.tileType) &&
      (meta.pointRoads?.length ?? 0) === 0
    ) {
      out.push({ kind: 'point-tile-unmapped', severity: 'info', at, pointId: meta.pointId });
    }

    // #83 item 4. The palette has had a `crossing` tile all along, so a plain
    // diamond can be drawn today — while #26 records that two routes fouling
    // at one are not detected, because neither shares a block or a point. The
    // editor is where that blind spot would actually be noticed.
    if (tile.tileType === 'crossing') {
      out.push({ kind: 'diamond-blind-spot', severity: 'warning', at });
    }
  }

  return out;
}

/**
 * #91 — drawn track that stops against a tile which has nothing meeting it.
 *
 * `warning`, not `info`: this is the "two representations disagree" class, and
 * the two representations here are the drawing and itself. Track drawn up to a
 * boundary reads as continuous, so the block quietly ending at that cell looks
 * like a generator fault rather than a drawing one. This is the finding that
 * explains it.
 */
function unjoinedDiagnostics(input: DiagnosticsInput): GridDiagnostic[] {
  return input.unjoined.map((u) => ({
    kind: 'track-not-joined' as const,
    severity: 'warning' as const,
    at: u.at,
    edge: u.edge,
    against: u.against,
  }));
}

function annotationDiagnostics(input: DiagnosticsInput): GridDiagnostic[] {
  const places = new Map<string, { entityType: AnnotationEntityType; entityId: string; at: Coordinate[] }>();

  for (const tile of input.tiles) {
    for (const annotation of tile.metadata.annotations ?? []) {
      const k = `${annotation.entityType}:${annotation.entityId}`;
      const entry = places.get(k);
      if (entry) entry.at.push({ x: tile.x, y: tile.y });
      else
        places.set(k, {
          entityType: annotation.entityType,
          entityId: annotation.entityId,
          at: [{ x: tile.x, y: tile.y }],
        });
    }
  }

  // Surfaced rather than refused on write. A sensor being moved from one tile
  // to another is a two-step edit, and a write path that refused the first
  // step would make moving one impossible without deleting it first.
  return [...places.values()]
    .filter((p) => p.at.length > 1)
    .map((p) => ({
      kind: 'duplicate-annotation' as const,
      severity: 'warning' as const,
      entityType: p.entityType,
      entityId: p.entityId,
      at: p.at.sort((a, b) => a.y - b.y || a.x - b.x),
    }));
}

/**
 * #84's one surviving check, re-expressed over compiled openings (OQ3).
 *
 * ## What went, and why it is not a loss
 *
 * `end-not-on-diagram`, `pinned-end-not-on-diagram` and `end-label-collision`
 * were all findings about `block_ends`: a stored name with no drawn opening, a
 * deliberately pinned one likewise, and two openings the generator refused to
 * name. None of those states can exist now. A label is derived from the drawing
 * on every compile, so it cannot outlive the geometry it describes, cannot be
 * pinned, and cannot be refused — `compileOpenings` disambiguates by suffix
 * (D8/D-I).
 *
 * `end-unfinished` — an opening with no edge and no buffer — is the one whose
 * *check* mattered, and it was promoted rather than deleted (OQ4). It is the
 * compile gap `opening-unresolved`, which is strictly stronger: a gap refuses
 * `auto`, and an `info` diagnostic refused nothing.
 *
 * `block-without-detection` moved the same way, and had to. It was here as
 * `info` and is a compile gap as well; two findings for one fact, with two
 * severities and only one of them gating, is precisely the duplication this
 * issue exists to end. The gap is the one that matters — D9's argument that an
 * unverifiable point mapping is caught on first movement depends entirely on
 * the wrong block being detected.
 *
 * ## What is left, and why it belongs here rather than in the compiler
 *
 * A buffer contradicted by a live edge is a **drawing-versus-graph**
 * disagreement, and the compiler has no opinion about the stored graph — it
 * emits a candidate. This is the last place those two artefacts are compared
 * outside the diff, and it stays `warning` for the reason the severity rule
 * gives: two representations disagree.
 */
function openingDiagnostics(input: DiagnosticsInput): GridDiagnostic[] {
  const edgesByEnd = new Map<string, string[]>();
  for (const edge of input.edges) {
    for (const k of [`${edge.fromBlockId} ${edge.fromEnd}`, `${edge.toBlockId} ${edge.toEnd}`]) {
      const list = edgesByEnd.get(k);
      if (list) list.push(edge.id);
      else edgesByEnd.set(k, [edge.id]);
    }
  }

  const out: GridDiagnostic[] = [];

  for (const opening of input.openings) {
    if (!opening.terminated) continue;

    // Keyed on `(blockId, label)` — the same tuple `block_edges` carries. A
    // compiled label matches a stored edge only when the drawing has not moved
    // since that edge was written, which is the point: a label that no longer
    // matches produces no finding here, and staleness is reported as staleness
    // rather than as a phantom contradiction.
    const edgeIds = edgesByEnd.get(`${opening.blockId} ${opening.label}`) ?? [];
    if (edgeIds.length === 0) continue;

    out.push({
      kind: 'buffer-contradicted-by-edge',
      severity: 'warning',
      blockId: opening.blockId,
      label: opening.label,
      edgeIds: [...edgeIds].sort(),
    });
  }

  return out;
}

/*
 * `detectionDiagnostics` was here. `block-without-detection` is a **compile
 * gap** now (D7/D9) and only there: it was reported in both places, as `info`
 * here and as a gap that refuses `auto` there, which is one fact wearing two
 * severities. The gap is the one that has to win — D9's argument that an
 * unverifiable point mapping is caught on first movement rests entirely on the
 * wrong block being detected, and an advisory `info` line never rested on
 * anything.
 *
 * The reasoning it carried is not lost: out-of-service sensors do not count,
 * because an out-of-service sensor contributes nothing to derived occupancy
 * (`docs/sensor-fault-recovery.md` D3), so a block covered only by one is for
 * occupancy purposes uncovered. `compileTrackGraph` applies exactly that test.
 */
