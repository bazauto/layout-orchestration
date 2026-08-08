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
import { BrakingProfile, BrakingRefusal, LayoutId, LocoAddress, LocoState, RouteReservation } from '../domain/types';
import { ILayoutRepository, LocoRecord } from '../ports/ILayoutRepository';

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

    const distance = remainingRouteDistanceMm(reservation, graph, resolvedTargetIndex);
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
