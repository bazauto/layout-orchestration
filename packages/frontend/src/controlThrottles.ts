/**
 * Which throttle cards are open on the control plane, per layout (#165).
 *
 * Two separate preferences, deliberately in two separate entries:
 *
 * - **which locos have a card** — this module, one list per layout;
 * - **where each card sits and whether it is expanded** — `useFloatingPlacement`,
 *   one entry per card.
 *
 * Splitting them is what lets a card be closed and re-opened without losing the
 * corner the operator put it in. Merging them would mean either dropping the
 * placement on close, or keeping a growing record of placements for cards that
 * no longer exist.
 *
 * Pure, and separate from the component, so the rules below can be asserted
 * without rendering anything.
 *
 * ## What it refuses to load
 *
 * A card is opened by address, and the address is what gets sent to a
 * locomotive. So an entry that is not a plain positive integer is dropped
 * rather than coerced — `Number("3junk")` is `NaN`, but `parseInt` would give
 * `3`, and a hand-edited or truncated localStorage entry must never be the
 * thing that decides which train a slider drives. The rest of the list still
 * loads: one bad entry is not a reason to lose an operator's whole desk.
 */

import { RouteReservation } from './types';

/** DCC's long-address ceiling — the same range `isValidLocoAddress` enforces on the backend. */
const MAX_ADDRESS = 10239;

/** How many cards may be open at once. */
export const MAX_THROTTLE_CARDS = 8;

export const openThrottlesKey = (layoutId: string) =>
  `layout-orchestrator:controlThrottles:${layoutId}`;

/** One entry per card, so placement survives the card being closed and re-opened. */
export const throttleCardKey = (layoutId: string, address: number) =>
  `layout-orchestrator:controlThrottleCard:${layoutId}:${address}`;

export function parseOpenThrottles(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<number>();
    for (const entry of parsed) {
      if (typeof entry !== 'number' || !Number.isInteger(entry)) continue;
      if (entry < 1 || entry > MAX_ADDRESS) continue;
      seen.add(entry);
    }
    return [...seen].slice(0, MAX_THROTTLE_CARDS);
  } catch {
    return [];
  }
}

export function loadOpenThrottles(layoutId: string | null): number[] {
  if (!layoutId) return [];
  try {
    return parseOpenThrottles(window.localStorage.getItem(openThrottlesKey(layoutId)));
  } catch {
    return [];
  }
}

export function saveOpenThrottles(layoutId: string | null, addresses: readonly number[]): void {
  if (!layoutId) return;
  try {
    window.localStorage.setItem(openThrottlesKey(layoutId), JSON.stringify(addresses));
  } catch {
    /* a convenience, not worth surfacing */
  }
}

/**
 * Adds a card, or returns the list unchanged.
 *
 * Unchanged — not moved to the end — when the loco already has a card: the
 * cards are placed by the operator, and re-ordering the list would re-cascade
 * the defaults of every card that has not been dragged yet.
 */
export function addThrottle(open: readonly number[], address: number): number[] {
  if (open.includes(address)) return [...open];
  if (open.length >= MAX_THROTTLE_CARDS) return [...open];
  return [...open, address];
}

export function removeThrottle(open: readonly number[], address: number): number[] {
  return open.filter((a) => a !== address);
}

/**
 * The auto-authority route a manual throttle command would cancel, or `null`.
 *
 * Mirrors `ReservationService.routeHoldingLoco` — `active` and `suspended`,
 * never `released` or `cancelled` — narrowed to `auto`, which is the authority
 * `LayoutService.handleThrottleCommand` cancels on (D6). A `manual`-authority
 * route is left alone there and so is left alone here: that route *is* the
 * operator driving their own reserved road, and warning them off their own
 * throttle would be nonsense.
 *
 * One of the hand-maintained backend↔frontend duplicates. If the statuses
 * `routeHoldingLoco` considers ever change, this changes with them; the cost of
 * being wrong is a card that arms when it should not, or worse, does not arm
 * when it should.
 */
export function autoRouteHoldingLoco(
  routes: Record<string, RouteReservation>,
  address: number,
): string | null {
  for (const route of Object.values(routes)) {
    if (route.locoAddress !== address) continue;
    if (route.authority !== 'auto') continue;
    if (route.status !== 'active' && route.status !== 'suspended') continue;
    return route.id;
  }
  return null;
}
