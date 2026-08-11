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
import { GridTileWriteInput } from './validation';

/** Thrown when `:layoutId` does not resolve to a layout. Mapped to 404. */
export class LayoutNotFoundError extends Error {
  constructor(readonly layoutId: LayoutId) {
    super(`Layout ${layoutId} not found`);
    this.name = 'LayoutNotFoundError';
  }
}

/**
 * Thrown when a tile's `metadata.blockId` / `metadata.pointId` names a record
 * that does not exist in this layout. Mapped to 400, not 422: this is a
 * malformed reference in an admin config write, not a topology proposal the
 * graph refused (which is what `TopologyRejectedError`/422 means).
 */
export class TileReferenceError extends Error {
  constructor(
    readonly kind: 'block' | 'point',
    readonly recordId: string,
  ) {
    super(`metadata.${kind}Id ${recordId} is not a ${kind} in this layout`);
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

  private async assertReferencesResolve(
    layoutId: LayoutId,
    metadata: GridTileMetadata,
  ): Promise<void> {
    if (metadata.blockId !== undefined) {
      const blocks = await this.repo.listBlocks(layoutId);
      if (!blocks.some((b) => b.id === metadata.blockId)) {
        throw new TileReferenceError('block', metadata.blockId);
      }
    }

    if (metadata.pointId !== undefined) {
      const points = await this.repo.listPoints(layoutId);
      if (!points.some((p) => p.id === metadata.pointId)) {
        throw new TileReferenceError('point', metadata.pointId);
      }
    }
  }
}
