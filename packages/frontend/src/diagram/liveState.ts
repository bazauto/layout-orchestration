/**
 * Live diagram state (#63, #82) — the pure half of the monitor overlay.
 *
 * `TrackDiagram` (#75) draws the railway from the drawing alone. This module
 * builds the *second* layer it can be given: what the layout is doing right
 * now. Everything here is a pure function of a `StateSnapshot` plus the
 * drawing's own derived model, so it is testable without a socket, a canvas,
 * or a browser.
 *
 * ## Three rules this module exists to hold
 *
 * **1. The occupant model is a list, not a loco address.** `BlockState`
 * carries a single nullable `locoAddress`, and an occupied block with a `null`
 * address — a rake of coaches standing in a siding — is a real and common
 * state the system can observe but not identify. Rolling stock is not
 * modelled at all yet (#39 is the route to it), so `occupants` is a list that
 * is frequently *shorter* than the truth. Shaping it as a list now costs
 * nothing and means #39 populates it rather than reshaping every consumer.
 *
 * **2. A route is drawn as the locks it holds, not as a fourth layer.** Every
 * block on a granted route carries `lockedByRoute`, so a separate route
 * highlight would be a second mark for one fact, competing for the same tiles
 * as occupancy and the lock outline. `docs/diagram-encoding.md` already
 * assigns occupancy the fill and the lock the outline; a third area treatment
 * would have nowhere legible to go.
 *
 * **3. Every point position on this diagram is commanded, not confirmed.**
 * There is no feedback channel until #25. `roadSelection` therefore reports
 * `'selected' | 'unselected' | 'indeterminate'` about the *commanded* road and
 * says nothing about blades. The view states that once, prominently, rather
 * than qualifying each point — see `docs/liveness.md`.
 */

import {
  BlockState,
  LocoRecord,
  Occupancy,
  PointState,
  StateSnapshot,
  SystemStatus,
  TilePointRoad,
} from '../types';

// ─── Occupants ────────────────────────────────────────────────────────────────

/**
 * Something the system believes is standing in a block.
 *
 * `kind` is present from the start so #39's RFID-identified vehicles are a new
 * member rather than a new field on every consumer. Today there is exactly one
 * source, and it can only ever produce a loco.
 */
export interface ObservedVehicle {
  kind: 'loco';
  address: number;
  /** From the loco roster. Absent if the record has not loaded or was deleted. */
  name?: string;
}

export interface LiveBlock {
  occupancy: Occupancy;
  lockedByRoute: string | null;
  /** May be empty on an occupied block — see rule 1 above. */
  occupants: ObservedVehicle[];
}

/**
 * What the diagram is given to draw on top of the drawing.
 *
 * `freshness` sits here rather than beside it because staleness is a property
 * of *all* of it at once (`docs/liveness.md` D6): a stale snapshot is not a
 * set of individually-stale entities, it is one display that has stopped being
 * a display of now.
 */
export interface LiveDiagramState {
  blocks: ReadonlyMap<string, LiveBlock>;
  points: ReadonlyMap<string, PointState>;
  freshness: Freshness;
  systemStatus: SystemStatus;
  safeStopReason: string | null;
}

/**
 * How much the drawn state can be trusted.
 *
 * Deliberately not per-entity. On a quiet layout nothing changes for long
 * periods and that is normal, so an entity's `lastUpdated` age carries no
 * information about whether this client is still receiving anything. The
 * heartbeat carries all of it — `docs/liveness.md` D6.
 */
export type Freshness = 'live' | 'stale' | 'disconnected';

/** Builds the per-block live layer, resolving loco addresses to roster names. */
export function buildLiveBlocks(
  blocks: Readonly<Record<string, BlockState>>,
  locoRecords: readonly LocoRecord[],
): Map<string, LiveBlock> {
  const names = new Map(locoRecords.map((l) => [l.address, l.name]));
  const out = new Map<string, LiveBlock>();

  for (const [blockId, state] of Object.entries(blocks)) {
    const occupants: ObservedVehicle[] =
      state.locoAddress === null
        ? []
        : [
            {
              kind: 'loco',
              address: state.locoAddress,
              // Falls back to no name rather than to the raw address — the
              // caller renders `#12` from `address` either way, so a missing
              // roster record degrades to the address alone rather than to a
              // second rendering of it (docs/naming.md D8).
              ...(names.has(state.locoAddress) ? { name: names.get(state.locoAddress)! } : {}),
            },
          ];

    out.set(blockId, {
      occupancy: state.occupancy,
      lockedByRoute: state.lockedByRoute,
      occupants,
    });
  }

  return out;
}

/** Assembles the whole live layer from a snapshot. Pure; the freshness comes from the caller. */
export function buildLiveDiagramState(
  snapshot: StateSnapshot,
  locoRecords: readonly LocoRecord[],
  freshness: Freshness,
): LiveDiagramState {
  return {
    blocks: buildLiveBlocks(snapshot.blocks, locoRecords),
    points: new Map(Object.entries(snapshot.points)),
    freshness,
    systemStatus: snapshot.systemStatus,
    safeStopReason: snapshot.safeStopReason,
  };
}

// ─── Point roads ──────────────────────────────────────────────────────────────

/**
 * Whether a drawn road is the one the points are currently commanding.
 *
 * `indeterminate` is a third answer rather than a falsy second one, and the
 * distinction is load-bearing: a road whose points are *known* to be set the
 * other way and a road whose points the system cannot determine are different
 * states, and the fail-safe one must not be drawn as the ordinary one. A
 * `when` clause naming a point with no live state, or one whose position is
 * `unknown`, makes the whole road indeterminate — a road is only selected if
 * *every* clause holds, so one unknown is enough to spoil it (#83: `when` is a
 * list precisely so a slip or three-way needs several).
 */
export type RoadSelection = 'selected' | 'unselected' | 'indeterminate';

export function roadSelection(
  road: TilePointRoad,
  points: ReadonlyMap<string, PointState>,
): RoadSelection {
  // An empty `when` asserts nothing, so nothing can confirm it.
  if (road.when.length === 0) return 'indeterminate';

  let sawUnknown = false;

  for (const clause of road.when) {
    const state = points.get(clause.pointId);
    if (!state || state.position === 'unknown') {
      sawUnknown = true;
      continue;
    }
    // A definite disagreement settles it: this road is not the set road, and
    // that is true regardless of what any other clause turns out to be.
    if (state.position !== clause.position) return 'unselected';
  }

  return sawUnknown ? 'indeterminate' : 'selected';
}

// ─── Run geometry ─────────────────────────────────────────────────────────────

/** One side of one cell, in grid coordinates. */
export interface PerimeterEdge {
  x: number;
  y: number;
  side: 'n' | 'e' | 's' | 'w';
}

const SIDE_DELTAS: ReadonlyArray<{ side: PerimeterEdge['side']; dx: number; dy: number }> = [
  { side: 'n', dx: 0, dy: -1 },
  { side: 'e', dx: 1, dy: 0 },
  { side: 's', dx: 0, dy: 1 },
  { side: 'w', dx: -1, dy: 0 },
];

/**
 * The outline of a set of cells: every cell side whose neighbour is not also
 * in the set.
 *
 * Used to draw a block's lock as an outline **around the run** rather than
 * around each of its tiles. Per-tile boxes on a nine-tile block read as a
 * hatched region rather than as one locked block, which is precisely the
 * distinction the outline exists to make.
 *
 * 4-connected on purpose, unlike `findBlockRuns`'s 8-connected grouping: a
 * diagonal neighbour shares no *edge*, so it cannot close a gap in an outline.
 * A 45° run therefore draws a stepped outline, which is what it looks like.
 */
export function perimeterEdges(cells: Iterable<{ x: number; y: number }>): PerimeterEdge[] {
  const present = new Set<string>();
  const list: { x: number; y: number }[] = [];
  for (const c of cells) {
    const k = `${c.x},${c.y}`;
    if (present.has(k)) continue;
    present.add(k);
    list.push(c);
  }

  const out: PerimeterEdge[] = [];
  for (const c of list) {
    for (const { side, dx, dy } of SIDE_DELTAS) {
      if (!present.has(`${c.x + dx},${c.y + dy}`)) {
        out.push({ x: c.x, y: c.y, side });
      }
    }
  }
  return out;
}
