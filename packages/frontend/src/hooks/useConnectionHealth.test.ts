/**
 * The pure half of #82's liveness derivation.
 *
 * `connectionFreshness` is deliberately separable from the hook that ticks it
 * so the thresholds can be asserted without a fake clock and a render loop —
 * the decision this encodes (`docs/liveness.md` D6/D7) is what matters, and it
 * is one comparison.
 */

import { describe, expect, it } from 'vitest';
import { connectionFreshness } from './useConnectionHealth';
import { STALE_AFTER_MS } from '../types';

const NOW = 1_760_000_000_000;

describe('connectionFreshness', () => {
  it('is live while messages are arriving inside the threshold', () => {
    expect(connectionFreshness('connected', NOW - 1000, NOW)).toBe('live');
  });

  it('goes stale once the threshold is passed', () => {
    expect(connectionFreshness('connected', NOW - STALE_AFTER_MS - 1, NOW)).toBe('stale');
  });

  it('is still live exactly at the threshold — the boundary is inclusive', () => {
    expect(connectionFreshness('connected', NOW - STALE_AFTER_MS, NOW)).toBe('live');
  });

  it('reports a closed socket as disconnected, not stale', () => {
    // These are different things and the operator can act on them
    // differently. A socket that is down says so plainly; a socket that is up
    // and silent is the subtler and more dangerous case.
    expect(connectionFreshness('disconnected', NOW, NOW)).toBe('disconnected');
    expect(connectionFreshness('connecting', NOW, NOW)).toBe('disconnected');
  });

  it('reports a connected socket that has delivered nothing as stale', () => {
    // The server sends a STATE_SNAPSHOT unconditionally on connect, so an
    // open socket with no messages is already wrong. Calling that "live"
    // would be a claim rather than an observation.
    expect(connectionFreshness('connected', null, NOW)).toBe('stale');
  });

  it('does not go stale from a quiet layout alone, only from silence', () => {
    // The distinction #82 exists for: a heartbeat arriving every interval
    // keeps the display live no matter how long nothing on the railway
    // changes. Entity age is never consulted (D6).
    expect(connectionFreshness('connected', NOW - 1, NOW)).toBe('live');
  });
});
