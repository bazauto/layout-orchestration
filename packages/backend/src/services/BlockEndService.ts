/**
 * BlockEndService — the write path for `block_ends` (#72).
 *
 * ## The problem this exists to solve
 *
 * `block_edges` is authored with free-text end labels. Authoring an edge meant
 * looking at the drawing, deciding that the left-hand end of Fiddle Yard 1 was
 * the one you previously called `north`, and typing it correctly — every time,
 * with no feedback if you got it wrong. A transposed pair produces a
 * valid-looking edge that connects the wrong ends, and the pathfinder plans
 * through it happily, because `(block, end entered by)` is its search state
 * and it has no independent notion of geometry.
 *
 * So labels are **derived by default and authored by exception**: generated as
 * 8-point cardinal directions from the drawing, with a manual override that
 * regeneration never overwrites.
 *
 * ## The invariant everything here protects
 *
 * **A label an edge already references is never renamed and never deleted by
 * anything automatic.** `block_edges.fromEnd`/`toEnd` are free text and are
 * the *only* link between an edge and a block end, so renaming an end silently
 * rewrites every edge referencing it — turning a naming tidy-up into a change
 * to the track graph. Hence: adoption pins every label an edge already uses,
 * regeneration skips pinned rows, and a rename or delete of a referenced label
 * is refused outright (409) rather than cascaded.
 *
 * That also means this needs no migration and no rename machinery. Westgate
 * Hollow's already-authored edges pin themselves the first time `generate`
 * runs.
 *
 * ## Posture
 *
 * Every rejection is an ordinary 4xx. Nothing here reaches `SystemHealth` —
 * this is an admin config surface, and an end label is a name. Nothing routes
 * on a name.
 */

import { ILayoutRepository } from '../ports/ILayoutRepository';
import { BlockEnd, BlockId, LayoutId } from '../domain/types';
import { parseTileMetadata } from './validation';
import {
  BlockOpening,
  Coordinate,
  EndLabelCollision,
  GeometryTile,
  generateBlockEnds,
} from './gridGeometry';
import { LayoutNotFoundError } from './GridService';

/** Thrown when `:endId` does not resolve to an end **of this layout**. Mapped to 404. */
export class BlockEndNotFoundError extends Error {
  constructor(readonly endId: string) {
    super(`Block end ${endId} not found`);
    this.name = 'BlockEndNotFoundError';
  }
}

/** Thrown when `blockId` is not a block of this layout. Mapped to 400 — a bad field in a config write, same as `TileReferenceError`. */
export class BlockEndBlockNotFoundError extends Error {
  constructor(readonly blockId: string) {
    super(`blockId ${blockId} is not a block in this layout`);
    this.name = 'BlockEndBlockNotFoundError';
  }
}

/** Thrown when the block already has an end by that label. Mapped to 409 — the state of the world conflicts, the request was well-formed. */
export class BlockEndLabelTakenError extends Error {
  constructor(readonly blockId: string, readonly label: string) {
    super(`Block ${blockId} already has an end labelled '${label}'`);
    this.name = 'BlockEndLabelTakenError';
  }
}

/**
 * Thrown when a rename or delete would orphan existing edges. Mapped to 409.
 *
 * Deliberately not a cascade. Rewriting `block_edges.fromEnd`/`toEnd` to
 * follow a rename is a change to the track graph made as a side effect of a
 * naming action, and the graph is what routes are planned on. The operator
 * edits the edges, or keeps the name.
 */
export class BlockEndReferencedError extends Error {
  constructor(readonly label: string, readonly edgeIds: readonly string[]) {
    super(
      `Block end '${label}' is referenced by ${edgeIds.length} edge(s); edit or remove them first`,
    );
    this.name = 'BlockEndReferencedError';
  }
}

/**
 * A stored end plus where it currently sits on the drawing.
 *
 * `geometry: null` is informative rather than an error: it means the drawing
 * no longer has an opening by that name. For a pinned end that is exactly the
 * mismatch #72 wanted made visible — a label edges reference, with nowhere
 * sensible on the diagram to put it.
 */
export interface BlockEndView extends BlockEnd {
  geometry: { x: number; y: number; terminated: boolean } | null;
}

export interface GenerateEndsSummary {
  /** Labels pinned because an existing edge already referenced them. */
  adopted: Array<{ blockId: BlockId; label: string }>;
  created: Array<{ blockId: BlockId; label: string }>;
  removed: Array<{ blockId: BlockId; label: string }>;
  /** Bearings the generator refused to name. The author resolves these by hand. */
  collisions: EndLabelCollision[];
}

export class BlockEndService {
  constructor(private readonly repo: ILayoutRepository) {}

  async list(layoutId: LayoutId): Promise<BlockEndView[]> {
    await this.assertLayoutExists(layoutId);
    const [ends, openings] = await Promise.all([
      this.repo.listBlockEnds(layoutId),
      this.currentOpenings(layoutId),
    ]);

    const byKey = new Map(openings.map((o) => [`${o.blockId} ${o.label}`, o]));
    return ends.map((end) => {
      const opening = byKey.get(`${end.blockId} ${end.label}`);
      return {
        ...end,
        geometry: opening
          ? { x: opening.at.x, y: opening.at.y, terminated: opening.terminated }
          : null,
      };
    });
  }

  /**
   * Regenerates every block's unpinned ends from the current drawing.
   *
   * **On demand, never on a grid write** — the decision from #72's open
   * question 1. Redrawing a corner of the layout must not silently change
   * names underneath authored edges, and the whole value of a generated label
   * is that you can see when it changed.
   *
   * Adoption runs *first*, deliberately. Pinning every edge-referenced label
   * before anything is deleted is what makes the operation safe to run on a
   * layout whose ends have never been generated: Westgate Hollow's existing
   * edges pin their own labels on the first run rather than being clobbered by
   * geometry that disagrees.
   */
  async generate(layoutId: LayoutId): Promise<GenerateEndsSummary> {
    await this.assertLayoutExists(layoutId);

    const adopted = await this.adoptEdgeReferencedLabels(layoutId);

    const before = await this.repo.listBlockEnds(layoutId);
    const { openings, collisions } = await this.generatedEnds(layoutId);

    const labelsByBlock = new Map<BlockId, string[]>();
    for (const opening of openings) {
      const list = labelsByBlock.get(opening.blockId);
      if (list) list.push(opening.label);
      else labelsByBlock.set(opening.blockId, [opening.label]);
    }

    // Every block, not just the drawn ones: a block whose tiles have been
    // erased should lose its generated ends, and only iterating the openings
    // would leave them behind forever.
    const blocks = await this.repo.listBlocks(layoutId);
    for (const block of blocks) {
      await this.repo.replaceGeneratedBlockEnds(
        layoutId,
        block.id,
        labelsByBlock.get(block.id) ?? [],
      );
    }

    const after = await this.repo.listBlockEnds(layoutId);
    const key = (e: { blockId: string; label: string }) => `${e.blockId} ${e.label}`;
    const beforeKeys = new Set(before.map(key));
    const afterKeys = new Set(after.map(key));

    return {
      adopted,
      created: after
        .filter((e) => !beforeKeys.has(key(e)))
        .map((e) => ({ blockId: e.blockId, label: e.label })),
      removed: before
        .filter((e) => !afterKeys.has(key(e)))
        .map((e) => ({ blockId: e.blockId, label: e.label })),
      collisions,
    };
  }

  /** Creates an end by hand. Pinned by definition — you only do this to name something geometry got wrong or cannot see. */
  async create(layoutId: LayoutId, blockId: BlockId, label: string): Promise<BlockEnd> {
    await this.assertLayoutExists(layoutId);

    const blocks = await this.repo.listBlocks(layoutId);
    if (!blocks.some((b) => b.id === blockId)) {
      throw new BlockEndBlockNotFoundError(blockId);
    }

    const existing = await this.repo.listBlockEnds(layoutId);
    if (existing.some((e) => e.blockId === blockId && e.label === label)) {
      throw new BlockEndLabelTakenError(blockId, label);
    }

    return this.repo.createBlockEnd({ layoutId, blockId, label, pinned: true });
  }

  /**
   * Renames an end and pins it.
   *
   * Refuses (409) when the *current* label is referenced by an edge — see
   * `BlockEndReferencedError`. Renaming to a label the block already carries
   * is also a 409 rather than a silent merge: two ends becoming one is a
   * topology change, and the operator should say so explicitly by deleting
   * one.
   */
  async rename(layoutId: LayoutId, endId: string, label: string): Promise<BlockEnd> {
    await this.assertLayoutExists(layoutId);
    const end = await this.requireEnd(layoutId, endId);

    if (end.label === label) {
      // A no-op rename still pins: it is how an operator says "this generated
      // name is the right one, stop regenerating it".
      return this.repo.updateBlockEnd(endId, { pinned: true });
    }

    await this.assertNotReferenced(layoutId, end);

    const siblings = await this.repo.listBlockEnds(layoutId);
    if (siblings.some((e) => e.blockId === end.blockId && e.label === label && e.id !== endId)) {
      throw new BlockEndLabelTakenError(end.blockId, label);
    }

    return this.repo.updateBlockEnd(endId, { label, pinned: true });
  }

  /** Deletes an end. Refused (409) while any edge references it, for the same reason a rename is. */
  async remove(layoutId: LayoutId, endId: string): Promise<void> {
    await this.assertLayoutExists(layoutId);
    const end = await this.requireEnd(layoutId, endId);
    await this.assertNotReferenced(layoutId, end);
    await this.repo.deleteBlockEnd(endId);
  }

  /**
   * Pins every `(block, label)` pair an edge already references, creating the
   * row if it is missing.
   *
   * Idempotent, and the reason no migration was needed for this feature.
   */
  private async adoptEdgeReferencedLabels(
    layoutId: LayoutId,
  ): Promise<Array<{ blockId: BlockId; label: string }>> {
    const [edges, ends] = await Promise.all([
      this.repo.listBlockEdges(layoutId),
      this.repo.listBlockEnds(layoutId),
    ]);

    const referenced = new Map<string, { blockId: BlockId; label: string }>();
    for (const edge of edges) {
      referenced.set(`${edge.fromBlockId} ${edge.fromEnd}`, {
        blockId: edge.fromBlockId,
        label: edge.fromEnd,
      });
      referenced.set(`${edge.toBlockId} ${edge.toEnd}`, {
        blockId: edge.toBlockId,
        label: edge.toEnd,
      });
    }

    const byKey = new Map(ends.map((e) => [`${e.blockId} ${e.label}`, e]));
    const adopted: Array<{ blockId: BlockId; label: string }> = [];

    for (const [k, ref] of referenced) {
      const existing = byKey.get(k);
      if (!existing) {
        await this.repo.createBlockEnd({ ...ref, layoutId, pinned: true });
        adopted.push(ref);
      } else if (!existing.pinned) {
        await this.repo.updateBlockEnd(existing.id, { pinned: true });
        adopted.push(ref);
      }
    }

    return adopted;
  }

  private async currentOpenings(layoutId: LayoutId): Promise<BlockOpening[]> {
    return (await this.generatedEnds(layoutId)).openings;
  }

  private async generatedEnds(
    layoutId: LayoutId,
  ): Promise<{ openings: BlockOpening[]; collisions: EndLabelCollision[] }> {
    const tiles = await this.repo.listGridTiles(layoutId);
    return generateBlockEnds(toGeometryTiles(tiles));
  }

  private async requireEnd(layoutId: LayoutId, endId: string): Promise<BlockEnd> {
    const end = await this.repo.getBlockEnd(endId);
    // Scoped by layout, not by id alone — the same rule `deleteBlock` and
    // `GridService` follow: an id is not authority to touch another layout's
    // records.
    if (!end || end.layoutId !== layoutId) throw new BlockEndNotFoundError(endId);
    return end;
  }

  private async assertNotReferenced(layoutId: LayoutId, end: BlockEnd): Promise<void> {
    const edges = await this.repo.listBlockEdges(layoutId);
    const referencing = edges
      .filter(
        (e) =>
          (e.fromBlockId === end.blockId && e.fromEnd === end.label) ||
          (e.toBlockId === end.blockId && e.toEnd === end.label),
      )
      .map((e) => e.id);

    if (referencing.length > 0) throw new BlockEndReferencedError(end.label, referencing);
  }

  private async assertLayoutExists(layoutId: LayoutId): Promise<void> {
    const layout = await this.repo.getLayout(layoutId);
    if (!layout) throw new LayoutNotFoundError(layoutId);
  }
}

/**
 * Turns stored tile rows into the shape the geometry works on.
 *
 * Metadata is parsed tolerantly (`parseTileMetadata`): a tile whose blob
 * predates #70's closed schema reads as `{}` and takes no part in run
 * detection, rather than making the whole screen 500. The diagnostics report
 * it separately so it is visible rather than merely survived.
 */
export function toGeometryTiles(
  rows: readonly { x: number; y: number; tileType: string; metadata: string }[],
): GeometryTile[] {
  return rows.map((row) => ({
    x: row.x,
    y: row.y,
    tileType: row.tileType as GeometryTile['tileType'],
    metadata: parseTileMetadata(row.metadata).metadata,
  }));
}

export type { Coordinate };
