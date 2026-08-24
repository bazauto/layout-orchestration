/**
 * The control plane's stored desk (#165).
 *
 * What is worth asserting here is not the storage round-trip but the two rules
 * that decide what a slider is wired to: a stored address that is not a plain
 * positive integer is **dropped, never coerced**, and the auto-authority
 * predicate matches `ReservationService.routeHoldingLoco` exactly. Getting the
 * first wrong drives the wrong train; getting the second wrong cancels an
 * automated run without warning, or fails to warn that it will.
 */

import { describe, expect, it } from 'vitest';
import {
  addThrottle,
  autoRouteHoldingLoco,
  MAX_THROTTLE_CARDS,
  parseOpenThrottles,
  removeThrottle,
} from './controlThrottles';
import { RouteReservation } from './types';

function route(overrides: Partial<RouteReservation>): RouteReservation {
  return {
    id: 'r-1',
    layoutId: 'layout-1',
    locoAddress: 3,
    authority: 'auto',
    status: 'active',
    path: [],
    holds: [],
    confirmedIndex: 0,
    reason: null,
    createdAt: '2026-08-24T10:00:00.000Z',
    updatedAt: '2026-08-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('parseOpenThrottles', () => {
  it('reads a stored list of addresses', () => {
    expect(parseOpenThrottles('[3, 12, 4]')).toEqual([3, 12, 4]);
  });

  it('returns nothing for absent, corrupt, or non-array storage', () => {
    expect(parseOpenThrottles(null)).toEqual([]);
    expect(parseOpenThrottles('')).toEqual([]);
    expect(parseOpenThrottles('[3, 4')).toEqual([]);
    expect(parseOpenThrottles('{"a":1}')).toEqual([]);
  });

  it('drops an entry that is not a plain positive integer rather than coercing it', () => {
    // The string "3junk" is the case that matters: `parseInt` would make this
    // loco 3, and a truncated or hand-edited entry must never be the thing
    // that decides which train a slider drives.
    expect(parseOpenThrottles('["3junk", 3.5, 0, -2, null, 4]')).toEqual([4]);
  });

  it('keeps the rest of the list when one entry is bad', () => {
    expect(parseOpenThrottles('[3, "x", 7]')).toEqual([3, 7]);
  });

  it('de-duplicates and caps the list', () => {
    expect(parseOpenThrottles('[3, 3, 3]')).toEqual([3]);
    const many = JSON.stringify(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(parseOpenThrottles(many)).toHaveLength(MAX_THROTTLE_CARDS);
  });
});

describe('addThrottle / removeThrottle', () => {
  it('adds a card', () => {
    expect(addThrottle([3], 4)).toEqual([3, 4]);
  });

  it('leaves the list untouched for a loco that already has one', () => {
    // Not moved to the end: the cards are placed by hand, and re-ordering
    // would re-cascade the default corner of every card not yet dragged.
    expect(addThrottle([3, 4], 3)).toEqual([3, 4]);
  });

  it('refuses to grow past the cap', () => {
    const full = Array.from({ length: MAX_THROTTLE_CARDS }, (_, i) => i + 1);
    expect(addThrottle(full, 999)).toEqual(full);
  });

  it('removes a card', () => {
    expect(removeThrottle([3, 4], 3)).toEqual([4]);
    expect(removeThrottle([3], 9)).toEqual([3]);
  });
});

describe('autoRouteHoldingLoco', () => {
  it('finds an active auto-authority route for the loco', () => {
    expect(autoRouteHoldingLoco({ 'r-1': route({}) }, 3)).toBe('r-1');
  });

  it('counts a suspended route too', () => {
    // `routeHoldingLoco` considers both, so a suspended auto route is still a
    // route a manual throttle command would cancel.
    expect(autoRouteHoldingLoco({ 'r-1': route({ status: 'suspended' }) }, 3)).toBe('r-1');
  });

  it('ignores a released or cancelled route', () => {
    expect(autoRouteHoldingLoco({ 'r-1': route({ status: 'released' }) }, 3)).toBeNull();
    expect(autoRouteHoldingLoco({ 'r-1': route({ status: 'cancelled' }) }, 3)).toBeNull();
  });

  it('ignores a manual-authority route', () => {
    // That route IS the operator driving their own reserved road — warning
    // them off their own throttle would be nonsense.
    expect(autoRouteHoldingLoco({ 'r-1': route({ authority: 'manual' }) }, 3)).toBeNull();
  });

  it('ignores a route for another loco', () => {
    expect(autoRouteHoldingLoco({ 'r-1': route({ locoAddress: 9 }) }, 3)).toBeNull();
  });
});
