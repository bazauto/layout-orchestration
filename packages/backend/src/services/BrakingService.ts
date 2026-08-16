/**
 * BrakingService
 *
 * Turns roster/runtime data into a `BrakingProfile` and delegates to
 * `domain/braking.ts` for the actual plan. Planning only — no DCC, no MQTT,
 * no timers, and it never calls back into `LayoutService` — the same posture
 * `ReservationService` documents for itself. `LayoutService` (PR B) is what
 * executes a granted `BrakingPlan`'s schedule against a real `IClock` and
 * issues the `setSpeed` commands.
 *
 * See `docs/braking.md` for the decision record (B1–B10) this implements.
 */

import {
  BrakingPlan,
  StoppingDistanceModel,
  planBrakingSchedule,
  remainingRouteDistanceMm,
  scalarStoppingDistance,
} from '../domain/braking';
import { TrackGraph } from '../domain/graph';
import { LayoutStateManager } from '../domain/layoutState';
import { effectivePosition } from '../domain/pointConfirmation';
import { BrakingProfile, BrakingRefusal, LayoutId, LocoAddress, LocoState, RouteReservation } from '../domain/types';
import { ILayoutRepository, LocoRecord } from '../ports/ILayoutRepository';
import { IClock } from '../ports/IClock';

export interface BrakingServiceLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

type ProfileResolution =
  | { ok: true; profile: BrakingProfile; locoState: LocoState }
  | { ok: false; reason: BrakingRefusal };

export class BrakingService {
  constructor(
    private readonly repo: ILayoutRepository,
    private readonly stateManager: LayoutStateManager,
    private readonly log: BrakingServiceLogger,
    private readonly model: StoppingDistanceModel = scalarStoppingDistance,
    /**
     * #77's lead term needs a "now" to age a position fix against
     * (`docs/sensor-position.md` D7). Injected rather than read from a global,
     * for the same reason the ramp's timers are.
     *
     * **Optional, and an absent clock means no lead term at all** — never a
     * default `SystemClock`, and never a refusal. That mirrors #103's inert
     * `IGraphCompletenessView`: an unwired service has been told nothing about
     * sub-block position, so it promises nothing extra and behaves exactly as
     * it did before #77. The failure direction of a missed wiring is therefore
     * a run refused that could have been granted, not one granted that should
     * not have been.
     */
    private readonly clock?: IClock,
  ) {}

  /**
   * B8's unconstrained calibration/assistive stop: a full ramp from the
   * loco's current commanded speed with no distance limit
   * (`availableDistanceMm: null`) and no overrun expectation, because there
   * is no route to have one against. This is what
   * `POST .../locos/:address/brake` (PR B) issues.
   */
  async planStop(layoutId: LayoutId, locoAddress: LocoAddress): Promise<BrakingPlan> {
    const resolved = await this.resolveProfile(layoutId, locoAddress);
    if (!resolved.ok) {
      return this.refuse(layoutId, locoAddress, resolved.reason);
    }

    return planBrakingSchedule(
      {
        profile: resolved.profile,
        fromCommandedSpeedStep: resolved.locoState.speed,
        direction: resolved.locoState.direction,
        availableDistanceMm: null,
      },
      this.model,
    );
  }

  /**
   * Plans a stop at the entry boundary of `reservation.path[targetIndex]`
   * (B4) — `targetIndex` defaults to the route's destination step, so an
   * omitted argument halts just short of arrival rather than inside it.
   *
   * Refuses outright for a route that is not `active` or that has `manual`
   * authority (B6) — braking is an automation action, and D6/D7's manual-wins
   * posture (`docs/route-locking.md`) means this service has no business
   * planning a stop against track an operator, not the system, is driving.
   */
  async planStopAtRouteBoundary(
    layoutId: LayoutId,
    reservation: RouteReservation,
    graph: TrackGraph | null,
    targetIndex?: number,
  ): Promise<BrakingPlan> {
    if (reservation.status !== 'active') {
      return this.refuse(layoutId, reservation.locoAddress, {
        kind: 'route-not-active',
        routeId: reservation.id,
        status: reservation.status,
      });
    }
    if (reservation.authority === 'manual') {
      return this.refuse(layoutId, reservation.locoAddress, {
        kind: 'manual-authority',
        routeId: reservation.id,
      });
    }

    const unconfirmedPoint = this.firstUnconfirmedPointHold(reservation);
    if (unconfirmedPoint) {
      return this.refuse(layoutId, reservation.locoAddress, unconfirmedPoint);
    }

    const resolved = await this.resolveProfile(layoutId, reservation.locoAddress);
    if (!resolved.ok) {
      return this.refuse(layoutId, reservation.locoAddress, resolved.reason);
    }

    const resolvedTargetIndex = targetIndex ?? reservation.path.length - 1;

    if (graph === null) {
      // A null graph means topology failed to load and the system is
      // already Safe-Stopped (`services/topologyLoader.ts`) — this branch is
      // defence in depth, not a path this service expects to exercise in
      // practice. There is no edge list to consult, so the first remaining
      // edge (into the next unconfirmed block) is the best available name
      // for "what we can't measure".
      const firstRemainingEdgeId = reservation.path[reservation.confirmedIndex + 1]?.edgeId ?? null;
      return this.refuse(layoutId, reservation.locoAddress, {
        kind: 'unknown-edge',
        edgeId: firstRemainingEdgeId ?? '',
      });
    }

    // #77 D9: the confirmed block may contribute the distance between a
    // sub-block position fix and the boundary the train is about to cross —
    // where B4 alone can promise nothing, because a train confirmed in a block
    // may be anywhere within it. Every way of not having a usable fix
    // contributes zero and falls through to the B4 sum, so this can only ever
    // hand back distance the old model refused to promise.
    const confirmedBlockId = reservation.path[reservation.confirmedIndex]?.blockId;
    const lead =
      this.clock && confirmedBlockId !== undefined
        ? {
            observations: this.stateManager.listSensorObservationsForBlock(confirmedBlockId),
            now: this.clock.now(),
          }
        : undefined;

    const distance = remainingRouteDistanceMm(reservation, graph, resolvedTargetIndex, lead);
    if (!distance.ok) {
      return this.refuse(layoutId, reservation.locoAddress, distance.reason);
    }

    return planBrakingSchedule(
      {
        profile: resolved.profile,
        fromCommandedSpeedStep: resolved.locoState.speed,
        direction: resolved.locoState.direction,
        availableDistanceMm: distance.distanceMm,
      },
      this.model,
    );
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * B7's precondition, built once #25 gave the system something to confirm
   * against: the first point hold this route still owns whose
   * **`effectivePosition`** is not the position the plan assumes, or `null`
   * when every held point checks out.
   *
   * A point that did not actually throw means the train is taking a
   * different road than the plan assumes, and every distance computed below
   * is measured along track it may not be on — so this refuses rather than
   * planning against it.
   *
   * `effectivePosition` (D7, `domain/pointConfirmation.ts`) is the only thing
   * consulted, never `confirmedPosition` directly. That is what keeps this
   * check inert on a `positionFeedback: 'none'` point — it falls back to the
   * commanded position, exactly the trust model the whole system used before
   * #25 — so this refusal can only fire on a point an operator has opted in
   * to feedback for. Nothing about Westgate Hollow's behaviour changes until
   * one is fitted.
   *
   * A hold with a `null` `requiredPosition` is skipped: it asserts no road,
   * only exclusivity.
   */
  private firstUnconfirmedPointHold(reservation: RouteReservation): BrakingRefusal | null {
    const points = this.stateManager.getState().points;

    for (const hold of reservation.holds) {
      if (hold.kind !== 'point' || hold.released || hold.requiredPosition === null) continue;

      const pointState = points.get(hold.targetId);
      // An unknown point is not a "nothing to check" case: the reservation
      // and the running config have drifted apart, which is exactly the kind
      // of uncertainty a braking plan must not be measured through.
      const actual = pointState ? effectivePosition(pointState) : 'unknown';
      if (actual !== hold.requiredPosition) {
        return {
          kind: 'point-not-confirmed',
          pointId: hold.targetId,
          requiredPosition: hold.requiredPosition,
          effectivePosition: actual,
        };
      }
    }

    return null;
  }

  /**
   * Shared roster/state resolution for both entry points: the roster entry
   * via `repo.listLocos` (`unknown-loco` if absent, `ambiguous-loco` if more
   * than one row shares the address — two `brakingFactor`s for one train is
   * not something to pick between), then the commanded speed/direction via
   * `stateManager.getLoco` (`unknown-loco-state` if the loco has never been
   * commanded, or a restart lost it — never assume speed 0, per D9).
   */
  private async resolveProfile(layoutId: LayoutId, locoAddress: LocoAddress): Promise<ProfileResolution> {
    const locos = await this.repo.listLocos(layoutId);
    const matches = locos.filter((l) => l.address === locoAddress);

    if (matches.length === 0) {
      return { ok: false, reason: { kind: 'unknown-loco', locoAddress } };
    }
    if (matches.length > 1) {
      return { ok: false, reason: { kind: 'ambiguous-loco', locoAddress, count: matches.length } };
    }

    const locoState = this.stateManager.getLoco(locoAddress);
    if (!locoState) {
      return { ok: false, reason: { kind: 'unknown-loco-state', locoAddress } };
    }

    return { ok: true, profile: toBrakingProfile(matches[0]), locoState };
  }

  private refuse(layoutId: LayoutId, locoAddress: LocoAddress, reason: BrakingRefusal): BrakingPlan {
    this.log.warn('[BrakingService] Stop plan refused', { layoutId, locoAddress, reason });
    return { ok: false, reason };
  }
}

function toBrakingProfile(loco: LocoRecord): BrakingProfile {
  return { locoAddress: loco.address, maxSpeed: loco.maxSpeed, brakingFactor: loco.brakingFactor };
}
