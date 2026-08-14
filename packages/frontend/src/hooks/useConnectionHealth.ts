/**
 * useConnectionHealth (#82)
 *
 * Turns "when did we last hear anything" into the one word the diagram
 * degrades on: `live`, `stale`, or `disconnected`.
 *
 * ## Why this needs a timer of its own
 *
 * Staleness is the *absence* of messages, and an absence produces no React
 * render. Without a tick, a socket that froze at 12:00 would keep reporting
 * `live` forever — the component would simply never re-evaluate. So this hook
 * re-checks on an interval; that interval is the only thing standing between a
 * frozen mimic and a mimic that looks exactly like a quiet layout.
 *
 * The tick is `HEARTBEAT_INTERVAL_MS`, so the worst case is one interval of
 * over-reporting freshness beyond `STALE_AFTER_MS` — 20s of a 15s threshold.
 * Ticking faster would buy precision nobody can act on; the threshold is
 * already three missed heartbeats precisely so it is not tripped by jitter.
 *
 * See `docs/liveness.md` for why this is a connection-level property and not
 * a per-entity one.
 */

import { useEffect, useState } from 'react';
import { HEARTBEAT_INTERVAL_MS, STALE_AFTER_MS } from '../types';
import { ConnectionState } from './useLayoutSocket';
import { Freshness } from '../diagram/liveState';

export function connectionFreshness(
  connectionState: ConnectionState,
  lastMessageAt: number | null,
  now: number,
): Freshness {
  // A socket that is not open is not a staleness question. Say the plainer,
  // more alarming thing.
  if (connectionState !== 'connected') return 'disconnected';

  // Connected but nothing has arrived yet — including the opening
  // STATE_SNAPSHOT the server sends unconditionally. Something is wrong
  // enough that "live" would be a claim, not an observation.
  if (lastMessageAt === null) return 'stale';

  return now - lastMessageAt > STALE_AFTER_MS ? 'stale' : 'live';
}

export function useConnectionHealth(
  connectionState: ConnectionState,
  lastMessageAt: number | null,
): Freshness {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // `lastMessageAt` moving is itself a render, so freshness recovers the
  // moment a message lands rather than waiting for the next tick. The tick
  // only has to catch the silent direction.
  return connectionFreshness(connectionState, lastMessageAt, Math.max(now, lastMessageAt ?? 0));
}
