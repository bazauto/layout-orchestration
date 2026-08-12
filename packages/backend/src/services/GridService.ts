/**
 * GridService — the write path for the Track Editor's drawing (`grid_tiles`).
 *
 * The grid is a drawing, not the track model: `block_edges` is the model, and
 * no domain decision is ever taken from a tile (`docs/track-grid.md`). That is
 * exactly why this service is thin — it exists so the referential questions a
 * Zod schema cannot answer ("does this layout exist", "does this `blockId`
 * belong to *this* layout") are answered in the service layer rather than in a
 * transport callback (CLAUDE.md safety rule 2), and so the route stays parse →
 * delegate → map.
 *
 * Every rejection here is an ordinary 4xx. Nothing in this file may reach
 * `SystemHealth`: a bad admin config write must never halt a layout.
 */

import { ILayoutRepository, GridTileRecord } from '../ports/ILayoutRepository';
import { GridTileMetadata, LayoutId } from '../domain/types';
import { GridTileWriteInput, parseTileMetadata } from './validation';
import { Coordinate, GeometryTile, findUnjoinedEdges, generateBlockEnds } from './gridGeometry';
import { GridDiagnostic, runGridDiagnostics } from './gridDiagnostics';
// Aliased: the pure walk and this service's method would otherwise share a name,
// which compiles fine and reads as a recursive call.
import {
  EdgeProposalReport,
  proposeEdges as walkForProposals,
  reconcileProposals,
} from './edgeProposals';

/** Thrown when `:layoutId` does not resolve to a layout. Mapped to 404. */
export class LayoutNotFoundError extends Error {
  constructor(readonly layoutId: LayoutId) {
    super(`Layout ${layoutId} not found`);
    this.name = 'LayoutNotFoundError';
  }
}

/**
 * Thrown when a tile's metadata names a record that does not exist in this
 * layout — `blockId`, `pointId`, an annotation's `entityId` (#74), or a point
 * road's `pointId` (#73). Mapped to 400, not 422: this is a malformed
 * reference in an admin config write, not a topology proposal the graph
 * refused (which is what `TopologyRejectedError`/422 means).
 */
export class TileReferenceError extends Error {
  constructor(
    readonly kind: 'block' | 'point' | 'sensor',
    readonly recordId: string,
    readonly field = `metadata.${kind}Id`,
  ) {
    super(`${field} ${recordId} is not a ${kind} in this layout`);
    this.name = 'TileReferenceError';
  }
}

export class GridService {
  constructor(private readonly repo: ILayoutRepository) {}

  async listTiles(layoutId: LayoutId): Promise<GridTileRecord[]> {
    return this.repo.listGridTiles(layoutId);
  }

  /**
   * Upserts one tile at `(x, y)`.
   *
   * The referential check is scoped by layout, not by id alone, for the same
   * reason `deleteBlock`/`deletePoint` are (`TopologyService`): an id-only
   * check would let a tile in one layout hold a live reference to another
   * layout's block.
   *
   * Note what is deliberately NOT checked. A point tile carries both
   * `metadata.pointId` and, potentially, a `metadata.blockId`, while the
   * `points` row carries its own `blockId`. These are not required to agree —
   * see docs/track-grid.md D3. A tile's `blockId` says which block's tint the
   * tile draws in; the point's says which block the point sits in. They
   * usually match and nothing breaks when they do not.
   */
  async upsertTile(layoutId: LayoutId, input: GridTileWriteInput): Promise<GridTileRecord> {
    await this.assertLayoutExists(layoutId);
    await this.assertReferencesResolve(layoutId, input.metadata);

    return this.repo.upsertGridTile({
      layoutId,
      x: input.x,
      y: input.y,
      tileType: input.tileType,
      metadata: JSON.stringify(input.metadata),
    });
  }

  /**
   * Deletes the tile at `(x, y)`, reporting whether one was there.
   *
   * Deleting an empty cell is not an error — the editor's right-drag erase
   * sweeps across cells that may or may not hold a tile, and answering 404 to
   * half a drag would be noise. The caller gets `removed` so it can tell the
   * two apart without guessing, which is the distinction #62 is about.
   */
  async deleteTileAt(
    layoutId: LayoutId,
    x: number,
    y: number,
  ): Promise<{ removed: boolean }> {
    await this.assertLayoutExists(layoutId);
    const tiles = await this.repo.listGridTiles(layoutId);
    const tile = tiles.find((t) => t.x === x && t.y === y);
    if (!tile) return { removed: false };
    await this.repo.deleteTile(tile.id);
    return { removed: true };
  }

  /**
   * Everything the drawing and the track graph currently disagree about.
   *
   * A read-only surface: it takes no decision, refuses nothing, and changes
   * nothing. It exists because the two representations are authored
   * independently by hand and, until wave 2, nothing compared them at all —
   * which is why Westgate Hollow's edge set is mostly unauthored and nothing
   * said so.
   *
   * Assembled here rather than in the editor so there is exactly one
   * implementation of the geometry. The frontend renders findings and supplies
   * names; it does not re-derive them (and when #75 unifies the renderers,
   * there is nothing to unify on this side).
   */
  async diagnose(layoutId: LayoutId): Promise<GridDiagnostic[]> {
    await this.assertLayoutExists(layoutId);

    const [rows, blocks, points, sensors, edges, ends] = await Promise.all([
      this.repo.listGridTiles(layoutId),
      this.repo.listBlocks(layoutId),
      this.repo.listPoints(layoutId),
      this.repo.listSensors(layoutId),
      this.repo.listBlockEdges(layoutId),
      this.repo.listBlockEnds(layoutId),
    ]);

    const tiles: GeometryTile[] = [];
    const unreadableTiles: Coordinate[] = [];
    for (const row of rows) {
      const parsed = parseTileMetadata(row.metadata);
      if (!parsed.ok) unreadableTiles.push({ x: row.x, y: row.y });
      tiles.push({
        x: row.x,
        y: row.y,
        tileType: row.tileType as GeometryTile['tileType'],
        metadata: parsed.metadata,
      });
    }

    const { openings, collisions } = generateBlockEnds(tiles);

    return runGridDiagnostics({
      tiles,
      unreadableTiles,
      blocks,
      points,
      sensors,
      edges,
      ends,
      openings,
      collisions,
      // A separate pass over every tile, not only the block ones the run walk
      // visits (#91).
      unjoined: findUnjoinedEdges(tiles),
    });
  }

  /**
   * Candidate `block_edges` the drawing implies (#78).
   *
   * Read-only, and assembled exactly like `diagnose`: the two callees are pure,
   * and this owns no policy. It never writes — accepting a proposal is an
   * ordinary `POST .../edges` through `TopologyService`, so there is no second
   * write path for the track graph to be authored through.
   */
  async proposeEdges(layoutId: LayoutId): Promise<EdgeProposalReport> {
    await this.assertLayoutExists(layoutId);

    const [rows, edges, ends] = await Promise.all([
      this.repo.listGridTiles(layoutId),
      this.repo.listBlockEdges(layoutId),
      this.repo.listBlockEnds(layoutId),
    ]);

    const tiles: GeometryTile[] = rows.map((row) => ({
      x: row.x,
      y: row.y,
      tileType: row.tileType as GeometryTile['tileType'],
      // Tolerant, like every other read of this blob: a tile that will not parse
      // still draws, and still takes part in the walk as far as its type allows
      // (`docs/track-grid.md` D10).
      metadata: parseTileMetadata(row.metadata).metadata,
    }));

    const { openings } = generateBlockEnds(tiles);
    const report = walkForProposals({ tiles, openings });

    return {
      proposals: reconcileProposals(report.proposals, edges, ends),
      notes: report.notes,
    };
  }

  async clearGrid(layoutId: LayoutId): Promise<{ removed: number }> {
    await this.assertLayoutExists(layoutId);
    const removed = (await this.repo.listGridTiles(layoutId)).length;
    await this.repo.clearGrid(layoutId);
    return { removed };
  }

  private async assertLayoutExists(layoutId: LayoutId): Promise<void> {
    const layout = await this.repo.getLayout(layoutId);
    if (!layout) throw new LayoutNotFoundError(layoutId);
  }

  /**
   * Checks every id in the metadata against this layout's records.
   *
   * Each lookup list is read at most once even though four different fields
   * can want it: a point tile carrying `pointId` plus a two-road `pointRoads`
   * would otherwise make three identical `listPoints` calls per painted tile,
   * and painting is a drag gesture that fires per cell.
   *
   * Annotations (#74) are checked by their `entityType` discriminator, not by
   * guessing from the id — that discriminator exists precisely because an id
   * alone cannot be resolved back to a table. Adding a new entity type means
   * adding a case here; the exhaustiveness check below is what makes a missed
   * one a compile error rather than an unvalidated reference.
   */
  private async assertReferencesResolve(
    layoutId: LayoutId,
    metadata: GridTileMetadata,
  ): Promise<void> {
    const wantsPoints =
      metadata.pointId !== undefined || (metadata.pointRoads?.length ?? 0) > 0;
    const wantsSensors = metadata.annotations?.some((a) => a.entityType === 'sensor') ?? false;

    const [blocks, points, sensors] = await Promise.all([
      metadata.blockId !== undefined ? this.repo.listBlocks(layoutId) : [],
      wantsPoints ? this.repo.listPoints(layoutId) : [],
      wantsSensors ? this.repo.listSensors(layoutId) : [],
    ]);

    if (metadata.blockId !== undefined && !blocks.some((b) => b.id === metadata.blockId)) {
      throw new TileReferenceError('block', metadata.blockId);
    }

    if (metadata.pointId !== undefined && !points.some((p) => p.id === metadata.pointId)) {
      throw new TileReferenceError('point', metadata.pointId);
    }

    for (const road of metadata.pointRoads ?? []) {
      for (const condition of road.when) {
        if (!points.some((p) => p.id === condition.pointId)) {
          throw new TileReferenceError('point', condition.pointId, 'metadata.pointRoads[].pointId');
        }
      }
    }

    for (const annotation of metadata.annotations ?? []) {
      switch (annotation.entityType) {
        case 'sensor':
          if (!sensors.some((s) => s.id === annotation.entityId)) {
            throw new TileReferenceError(
              'sensor',
              annotation.entityId,
              'metadata.annotations[].entityId',
            );
          }
          break;
        default: {
          // Exhaustiveness: a new ANNOTATION_ENTITY_TYPES member that nobody
          // added a case for fails to compile here rather than shipping as an
          // annotation whose id is never checked against anything.
          const unreachable: never = annotation.entityType;
          throw new Error(`Unhandled annotation entity type: ${String(unreachable)}`);
        }
      }
    }
  }
}
