/**
 * Frontend half of #77's sub-block sensor position — see
 * `docs/sensor-position.md` for the decision record.
 *
 * One pure function, extracted from `ConfigPanel` so it can be tested without
 * a render. It is **affordance, not authorisation** (`App.tsx`'s `TABS_BY_ROLE`
 * records the same posture for roles): the backend is what decides whether a
 * position may be stored, and it deliberately accepts anchors this list would
 * not offer.
 */

import { BlockEdgeRecord, BlockRecord } from './types';

/**
 * The blocks the drawing joins `blockId` to, exactly once, in name order.
 *
 * "The boundary between *b* and *c*" is only a definite description when there
 * is one connection (D5). A block joined to its neighbour in **two** places is
 * excluded rather than offered and then silently ignored where the measurement
 * is consumed — an offer that resolves to nothing is worse than no offer.
 *
 * Counted over one direction only. The compiler emits a row per direction for
 * a bidirectional connection, so counting both would read every ordinary joint
 * as a duplicate and the list would always come back empty.
 *
 * Deliberately narrower than what the write path accepts: the backend takes an
 * anchor the drawing does not connect *yet*, because a beam may legitimately be
 * measured before the track justifying it is drawn (D5). This list exists to
 * stop an operator picking a neighbour that could never mean anything, not to
 * enforce a rule.
 */
export function anchorCandidates(
  blockId: string | null,
  blocks: readonly BlockRecord[],
  edges: readonly BlockEdgeRecord[],
): BlockRecord[] {
  if (!blockId) return [];

  const counts = new Map<string, number>();
  for (const edge of edges) {
    if (edge.fromBlockId !== blockId) continue;
    // A block shares no boundary with itself, and offering "toward itself"
    // would be a 400 the operator could not explain. `block_edges_not_self_loop`
    // makes a self-loop unreachable through the compiler, so this only ever
    // fires on a row that should not exist — which is exactly when a list built
    // from that row must not become an offer.
    if (edge.toBlockId === blockId) continue;
    counts.set(edge.toBlockId, (counts.get(edge.toBlockId) ?? 0) + 1);
  }

  return blocks
    .filter((b) => counts.get(b.id) === 1)
    .sort((a, b) => a.name.localeCompare(b.name));
}
