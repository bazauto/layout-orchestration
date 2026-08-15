/**
 * `effectivePosition` — the frontend mirror of the backend's
 * `domain/pointConfirmation.ts#effectivePosition` (#25, docs/point-feedback.md
 * D7). It is the single place a frontend consumer decides what a point's
 * position is trusted to be. Every consumer that used to read the pre-#25
 * `PointState.position` field goes through this — `diagram/liveState.ts`,
 * `diagram/pointKey.ts` and `diagram/routePaths.ts` — never
 * `commandedPosition` directly, and never `confirmedPosition` alone either,
 * both of which throw away exactly the distinction D7 exists to make.
 *
 * This is a fourth hand-maintained backend<->frontend duplicate, the kind
 * CLAUDE.md's "Open limits" already names three of (`findBlockRuns`/
 * `blockRuns.ts`, `TILE_LEGS`/`trackGeometry.ts`, `HEARTBEAT_INTERVAL_MS`). A
 * change to the backend rule wants this file changed too.
 *
 *  - `positionFeedback === 'required'` -> trust `confirmedPosition`, full
 *    stop. Nothing about `commandedPosition` may substitute for it — a point
 *    that timed out reads `'unknown'` even though it was commanded.
 *  - `positionFeedback === 'none'` -> `confirmedPosition` if it is not
 *    `'unknown'`, otherwise `commandedPosition ?? 'unknown'` — the same trust
 *    model every point on this system used before #25, preserved exactly for
 *    a point the operator has not opted in.
 */

import { PointPosition, PointState } from '../types';

export function effectivePosition(p: PointState): PointPosition {
  if (p.positionFeedback === 'required') {
    return p.confirmedPosition;
  }
  return p.confirmedPosition !== 'unknown' ? p.confirmedPosition : (p.commandedPosition ?? 'unknown');
}
