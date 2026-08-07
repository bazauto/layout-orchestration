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
}
