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
  BlockEnd,
  BlockId,
  PointId,
  classifyTile,
} from '../domain/types';
import { BlockOpening, Coordinate, EndLabelCollision, GeometryTile } from './gridGeometry';

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
  /** #84 — a buffer says this end is finished; an edge says track continues. One of them is wrong. */
  | {
      kind: 'buffer-contradicted-by-edge';
      severity: 'warning';
      blockId: BlockId;
      label: string;
      edgeIds: string[];
    }
  /** #84 — no edges and no buffer: an edge nobody has authored yet, now distinguishable from a deliberate dead end. */
  | { kind: 'end-unfinished'; severity: 'info'; blockId: BlockId; label: string; at: Coordinate }
  /** #72 — an end an edge references, with no opening on the drawing to put it at. */
  | { kind: 'end-not-on-diagram'; severity: 'warning'; blockId: BlockId; label: string }
  /** #72 — two openings of one block face the same way, so the generator refused to name either. */
  | {
      kind: 'end-label-collision';
      severity: 'warning';
      blockId: BlockId;
      label: string;
      at: Coordinate[];
    }
  /** #74 — a block no sensor reports on. Its occupancy can only ever be `unknown`. */
  | { kind: 'block-without-detection'; severity: 'info'; blockId: BlockId };

export interface DiagnosticsInput {
  tiles: readonly GeometryTile[];
  /** Coordinates whose metadata blob failed to parse — `parseTileMetadata` reported them rather than throwing. */
  unreadableTiles: readonly Coordinate[];
  blocks: readonly { id: string }[];
  points: readonly { id: string }[];
  sensors: readonly { id: string; blockId: string | null; inService: boolean }[];
  edges: readonly BlockEdge[];
  ends: readonly BlockEnd[];
  openings: readonly BlockOpening[];
  collisions: readonly EndLabelCollision[];
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
  out.push(...annotationDiagnostics(input));
  out.push(...endDiagnostics(input));
  out.push(...detectionDiagnostics(input));

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
    if (meta.pointId !== undefined && (meta.pointRoads?.length ?? 0) === 0) {
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
 * The #84 checks, plus #72's two visibility ones.
 *
 * The useful direction is the reverse of the obvious one. A block end with no
 * outgoing edges is ambiguous today: either a deliberate dead end or an edge
 * nobody has authored. A buffer resolves it — "this end is finished" versus
 * "this end is still to do" — and the buffers are already drawn.
 */
function endDiagnostics(input: DiagnosticsInput): GridDiagnostic[] {
  const out: GridDiagnostic[] = [];

  const edgesByEnd = new Map<string, string[]>();
  for (const edge of input.edges) {
    for (const k of [`${edge.fromBlockId} ${edge.fromEnd}`, `${edge.toBlockId} ${edge.toEnd}`]) {
      const list = edgesByEnd.get(k);
      if (list) list.push(edge.id);
      else edgesByEnd.set(k, [edge.id]);
    }
  }

  const openingByEnd = new Map(input.openings.map((o) => [`${o.blockId} ${o.label}`, o]));

  for (const end of input.ends) {
    const k = `${end.blockId} ${end.label}`;
    const edgeIds = edgesByEnd.get(k) ?? [];
    const opening = openingByEnd.get(k);

    if (!opening) {
      // Only worth reporting for an end something actually depends on. An
      // unpinned generated end always has an opening by construction, and a
      // hand-created one for track not yet drawn is a legitimate work order,
      // not a mistake.
      if (edgeIds.length > 0) {
        out.push({
          kind: 'end-not-on-diagram',
          severity: 'warning',
          blockId: end.blockId,
          label: end.label,
        });
      }
      continue;
    }

    if (opening.terminated && edgeIds.length > 0) {
      out.push({
        kind: 'buffer-contradicted-by-edge',
        severity: 'warning',
        blockId: end.blockId,
        label: end.label,
        edgeIds: [...edgeIds].sort(),
      });
    }

    if (!opening.terminated && edgeIds.length === 0) {
      out.push({
        kind: 'end-unfinished',
        severity: 'info',
        blockId: end.blockId,
        label: end.label,
        at: opening.at,
      });
    }
  }

  for (const collision of input.collisions) {
    out.push({
      kind: 'end-label-collision',
      severity: 'warning',
      blockId: collision.blockId,
      label: collision.label,
      at: collision.at,
    });
  }

  return out;
}

/**
 * #74's third stated goal: spot a block with no detection at all.
 *
 * Out-of-service sensors do not count — an out-of-service sensor contributes
 * nothing to derived occupancy (`docs/sensor-fault-recovery.md` D3), so a
 * block covered only by one is, for occupancy purposes, uncovered.
 */
function detectionDiagnostics(input: DiagnosticsInput): GridDiagnostic[] {
  const covered = new Set(
    input.sensors.filter((s) => s.inService && s.blockId).map((s) => s.blockId!),
  );

  // Only blocks that are actually drawn: a block row created in the Configure
  // screen and not yet placed on the diagram is unfinished authoring of a
  // different kind, and #71's unclassified-tile list already covers that end
  // of it.
  const drawn = new Set(
    input.tiles.map((t) => t.metadata.blockId).filter((id): id is string => id !== undefined),
  );

  return [...drawn]
    .filter((blockId) => !covered.has(blockId))
    .sort()
    .map((blockId) => ({
      kind: 'block-without-detection' as const,
      severity: 'info' as const,
      blockId,
    }));
}
