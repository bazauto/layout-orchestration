/**
 * Connection-health constants (#82, D5–D7, see docs/liveness.md).
 *
 * `HEARTBEAT_INTERVAL_MS` is how often `transport/websocket/index.ts` sends a
 * `HEARTBEAT` `ServerMessage` to every open client. `STALE_AFTER_MISSED_HEARTBEATS`
 * is how many of those a client may miss before it treats itself as stale —
 * one threshold, not tuned per entity (D6). `STALE_AFTER_MS` is derived from
 * the two rather than a separately-tuned number, which is what makes it
 * impossible for a client's staleness threshold to drift out of step with
 * the server's actual send interval: change `HEARTBEAT_INTERVAL_MS` here and
 * both numbers move together.
 *
 * The backend owns these values. The frontend has no shared workspace
 * package to import them from (see CLAUDE.md's module-system note), so
 * `packages/frontend/src/types.ts` mirrors them with a comment pointing back
 * here — the usual posture for every other type mirrored across the wire in
 * this codebase.
 */

export const HEARTBEAT_INTERVAL_MS = 5000;

export const STALE_AFTER_MISSED_HEARTBEATS = 3;

export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * STALE_AFTER_MISSED_HEARTBEATS;
