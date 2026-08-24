/**
 * Live diagram state (#63, #82) — the pure half of the control view's overlay.
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
 * **2. A route is drawn as the locks it holds — and that drawing is a line
 * along the track.** This rule used to end "not as a fourth layer", and
 * forbade a route highlight outright: every block on a granted route carries
 * `lockedByRoute`, so a separate highlight would be a second mark for one
 * fact, competing for the same tiles as occupancy and the lock outline.
 *
 * The argument survives; the conclusion inverted (#129). The dashed outline
 * around a locked run is **gone**, replaced by a coloured line along the road
 * the route holds (`diagram/routePaths.ts`). Still one mark for one fact, and
 * still read off `lockedByRoute` — a step is drawn only while its block
 * reports this route's lock, so the new mark cannot disagree with the fact the
 * old one carried. What it adds is the answer to "held by *which*", which two
 * identical yellow outlines could never give.
 *
 * A route highlight drawn *in addition to* the outline would still be wrong,
 * for exactly the reason the original rule gave.
 *
 * **3. A point's road is drawn against `effectivePosition`, not the raw
 * commanded field.** `domain/pointConfirmation.ts#effectivePosition` (D7,
 * `docs/point-feedback.md`, mirrored here as `diagram/pointConfirmation.ts`)
 * is the single place that decides what a point's position is trusted to be:
 * a `'required'` point trusts only a confirmed reading, a `'none'` point
 * falls back to what was commanded — the same trust model the diagram used
 * for every point before #25. `roadSelection` reports
 * `'selected' | 'unselected' | 'indeterminate'` about that trusted position
 * and says nothing about blades.
 */

import {
  BlockState,
  LocoRecord,
  Occupancy,
  PointState,
  SensorObservationView,
  StateSnapshot,
  SystemStatus,
  TilePointRoad,
} from '../types';
import { effectivePosition } from './pointConfirmation';

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
  /**
   * #76: every registered sensor's current observation, keyed by id — the
   * annotation glyph's own channel (`diagram/encoding.ts#sensorGlyphStateOf`),
   * never the block tint (D-c, `docs/diagram-encoding.md`). Empty when the
   * sensor layer is toggled off — `ControlView` controls visibility by
   * choosing what it builds this from, not by a flag `TrackDiagram` reads.
   */
  sensors: ReadonlyMap<string, SensorObservationView>;
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

/**
 * Assembles the whole live layer from a snapshot. Pure; the freshness comes
 * from the caller.
 *
 * `showSensors` (#76) gates `sensors` at the SOURCE rather than leaving
 * `TrackDiagram` to decide whether to draw what it is given — an empty map
 * when the layer is off is indistinguishable from "no sensors are placed",
 * which is exactly the behaviour a caller that never passes `live.sensors`
 * (the Track Editor) already gets.
 */
export function buildLiveDiagramState(
  snapshot: StateSnapshot,
  locoRecords: readonly LocoRecord[],
  freshness: Freshness,
  showSensors = false,
): LiveDiagramState {
  return {
    blocks: buildLiveBlocks(snapshot.blocks, locoRecords),
    points: new Map(Object.entries(snapshot.points)),
    sensors: showSensors ? new Map(Object.entries(snapshot.sensors)) : new Map(),
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
    const position = state ? effectivePosition(state) : 'unknown';
    if (position === 'unknown') {
      sawUnknown = true;
      continue;
    }
    // A definite disagreement settles it: this road is not the set road, and
    // that is true regardless of what any other clause turns out to be.
    if (position !== clause.position) return 'unselected';
  }

  return sawUnknown ? 'indeterminate' : 'selected';
}

/*
 * `perimeterEdges` used to live here — the 4-connected outline of a block run,
 * which existed solely to draw a lock as a dashed box around the run. The lock
 * is a line along the track now (#129, rule 2 above) and nothing outlines a
 * run, so it is deleted rather than left as a helper nobody calls: a plausible
 * pure function sitting unused is an invitation to draw the thing the diagram
 * deliberately stopped drawing.
 */
