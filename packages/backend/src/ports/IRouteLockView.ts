/**
 * Port: IRouteLockView
 *
 * A read-only view onto currently-held route reservations, implemented by
 * `ReservationService`. `TopologyService` depends on this interface, not on
 * `ReservationService` directly, so it stays testable standalone — the same
 * injection style as `TopologyService`'s existing `onTopologyChanged`
 * callback. See D10 in docs/route-locking.md: the topology write-guard this
 * port exists for.
 */

import { BlockEdgeId, BlockId, LayoutId, PointId, RouteId } from '../domain/types';

export interface IRouteLockView {
  /** The route id holding `blockId` (an unreleased `block` hold), or null if unheld. */
  findRouteHoldingBlock(layoutId: LayoutId, blockId: BlockId): RouteId | null;
  /** The route id holding `pointId` (an unreleased `point` hold), or null if unheld. */
  findRouteHoldingPoint(layoutId: LayoutId, pointId: PointId): RouteId | null;
  /** The route id holding `edgeId` (an unreleased `edge` hold), or null if unheld. */
  findRouteHoldingEdge(layoutId: LayoutId, edgeId: BlockEdgeId): RouteId | null;
  /**
   * Any route holding anything at all in this layout, or null (#103, D-E).
   *
   * The per-target lookups above do not compose into this. A compiled graph is
   * a **whole-set replace** — every edge in the layout is deleted and rewritten,
   * and end labels are regenerated wholesale — so the question "is this specific
   * edge held" has no useful answer: the row it names may not survive the write,
   * and the label a live route recorded in its path may not exist afterwards.
   * The only safe admission test for a replace is that nothing is held at all.
   *
   * This is also what makes D8's accepted consequence safe. A compile renames
   * ends; nothing can be holding a stale string when it happens.
   */
  findAnyHeldRoute(layoutId: LayoutId): RouteId | null;
}
