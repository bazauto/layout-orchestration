/**
 * The point key — the table that says what the abbreviations on the diagram
 * mean, and what each point is currently doing.
 *
 * ## Why a key exists at all
 *
 * `shortPointLabel` draws `P1` where the point is called `P1 - Fiddle Yard`,
 * and `Yard Th…` where it does not follow that convention (#93). That is the
 * right trade on a 40px tile — an abbreviated label is ambiguous only until you
 * hover it, an overlapping one is unreadable for both points — but hovering is
 * not available to someone reading a wall display from across a room. The key
 * resolves every abbreviation at once, without the diagram having to carry the
 * full names.
 *
 * It grew past a key on the way: the same row can carry the point's commanded
 * position and whether a route holds it, which is what an operator actually
 * wants when they look a point up. So this is a key *and* a status table, and
 * the diagram stays uncluttered because of it rather than in spite of it.
 *
 * ## Two degradations, both deliberate
 *
 * **A point with no live state reads `unknown`, not "normal".** Absence of a
 * position is not evidence of a position, and `unknown` is the fail-safe
 * reading everywhere else in this system — `roadSelection` makes a whole road
 * indeterminate on one unknown clause for the same reason.
 *
 * **A live point with no roster record still gets a row**, named by its raw id.
 * That is `docs/naming.md` D8's degradation: a missing name falls back to the
 * identifier rather than to nothing, because a point the layout is reporting on
 * and the table silently omits is worse than an ugly row.
 */

import { PointPosition, PointRecord, PointState } from '../types';
import { shortPointLabel } from './pointLabels';

export interface PointKeyRow {
  pointId: string;
  /** Exactly what the diagram draws on the tile, so the two can be matched by eye. */
  short: string;
  /** The full operator-facing name, or the raw id if there is no record. */
  name: string;
  /** Commanded, never confirmed — there is no feedback channel until #25. */
  position: PointPosition;
  /** The route holding this point, or `null`. */
  lockedByRoute: string | null;
}

/**
 * Sorts by name, numerically aware, so `P2` precedes `P10` instead of following
 * it. A key is read by scanning it, and a scan fails on lexicographic digits.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Builds the key from the roster and the live snapshot.
 *
 * The union of both, not just the roster: a point present in one and not the
 * other is exactly the case worth showing. Pure — no hook, no socket — so the
 * table's content is testable without rendering anything.
 */
export function buildPointKey(
  points: readonly PointRecord[],
  states: ReadonlyMap<string, PointState>,
): PointKeyRow[] {
  const byId = new Map(points.map((p) => [p.id, p]));
  const ids = new Set<string>([...byId.keys(), ...states.keys()]);

  const rows: PointKeyRow[] = [];
  for (const id of ids) {
    const name = byId.get(id)?.name ?? id;
    const state = states.get(id);
    rows.push({
      pointId: id,
      short: shortPointLabel(name),
      name,
      position: state?.position ?? 'unknown',
      lockedByRoute: state?.lockedByRoute ?? null,
    });
  }

  return rows.sort((a, b) => collator.compare(a.name, b.name));
}
