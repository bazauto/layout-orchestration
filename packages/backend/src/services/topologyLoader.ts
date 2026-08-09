/**
 * Topology load path.
 *
 * Fetches blocks, points, and edges for a layout, validates the edge set
 * against them, and builds a `TrackGraph` when it is safe to do so. This is
 * the read-side counterpart to `TopologyService` (the write path) and the
 * thing `LayoutService.reloadTopology` calls on startup and after any edge
 * mutation.
 */

import { buildTrackGraph, TrackGraph } from '../domain/graph';
import { describeViolations, isFatalViolation, validateTopology } from '../domain/topology';
import { BlockEdge, LayoutId, NameBook, TopologyViolation } from '../domain/types';
import { ILayoutRepository } from '../ports/ILayoutRepository';
import { BlockEdgeRowInvalidError } from './validation';

export interface TopologyLoadResult {
  edges: BlockEdge[];
  graph: TrackGraph | null;
  violations: TopologyViolation[];
  fatal: boolean;
  reason: string | null;
}

/**
 * Loads and validates the topology for `layoutId`. Never throws for a data
 * problem — a fatal violation or an invalid `block_edges` row both come back
 * as `{ fatal: true, graph: null, reason }` for the caller to turn into a
 * Safe-Stop. Anything else (a repository failure, a programming error) is
 * not a topology problem and is left to propagate: catching it here would
 * hide it instead of failing safe.
 */
export async function loadTopology(
  repo: ILayoutRepository,
  layoutId: LayoutId,
  book?: NameBook,
): Promise<TopologyLoadResult> {
  try {
    const [blocks, points, edges] = await Promise.all([
      repo.listBlocks(layoutId),
      repo.listPoints(layoutId),
      repo.listBlockEdges(layoutId),
    ]);

    const context = {
      blockIds: new Set(blocks.map((b) => b.id)),
      pointIds: new Set(points.map((p) => p.id)),
    };

    const violations = validateTopology(layoutId, edges, context);
    const fatalViolations = violations.filter(isFatalViolation);
    const fatal = fatalViolations.length > 0;

    const graph = fatal ? null : buildTrackGraph(layoutId, edges);

    return {
      edges,
      graph,
      violations,
      fatal,
      reason: fatal ? describeViolations(fatalViolations, book) : null,
    };
  } catch (err) {
    // BlockEdgeRowInvalidError means a block_edges row failed schema
    // validation before it could even become a BlockEdge — that is a fatal
    // topology problem, so it converts to the same result shape as a fatal
    // violation list. Everything else is rethrown: a narrow catch is the
    // whole point (see #10) — we must not mask an unrelated repository or
    // programming error as a topology failure.
    if (err instanceof BlockEdgeRowInvalidError) {
      const reason = `Topology invalid: ${err.message}`;
      return { edges: [], graph: null, violations: [], fatal: true, reason };
    }
    throw err;
  }
}
