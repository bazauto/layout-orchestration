/**
 * AutomationService (#7 PR B)
 *
 * Gathers what `domain/automation.ts` needs to decide, applies the phase it
 * decides, and hands the decisions back. See `docs/automation.md` for the
 * decision record (A1–A13).
 *
 * **Planning and bookkeeping only.** No MQTT, no DCC, no timer, and it never
 * calls back into `LayoutService` — the same posture `ReservationService` and
 * `PointConfirmationService` document for themselves. `LayoutService` owns the
 * `IClock.setInterval` sweep that calls `sweep()`, and owns every command that
 * comes out of it.
 *
 * The one thing this service holds that nothing else can is the **run**: which
 * trains are under automation, what phase each is in, and which beam a berthing
 * one is watching. Two of those phases are indistinguishable from outside — a
 * train stopped because it has not departed and one stopped because it has
 * berthed look identical in `LocoState` — which is why the phase is stored
 * rather than derived.
 *
 * A run is keyed by **loco address, not route id** (A8). A route completes the
 * instant its destination block reads `occupied`, which is as the train's front
 * enters, long before a beam at the far end; the berthing crawl therefore
 * outlives its own reservation by design, and a route-keyed run would be
 * orphaned exactly when it is still needed.
 */

import {
  AutomationDecision,
  AutomationInput,
  AutomationPhase,
  decideAutomation,
} from '../domain/automation';
import { StoppingDistanceModel, scalarStoppingDistance } from '../domain/braking';
import { berthingBeamIn } from '../domain/sensorPosition';
import { LayoutStateManager } from '../domain/layoutState';
import { TrackGraph } from '../domain/graph';
import {
  BrakingProfile,
  LayoutId,
  LocoAddress,
  RouteId,
  RouteReservation,
  SensorId,
} from '../domain/types';
import { ILayoutRepository, LocoRecord } from '../ports/ILayoutRepository';

export interface AutomationServiceLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** One train under automation. Runtime state, never persisted — a restart revives routes as `suspended` (D9), which is not a state automation drives. */
export interface AutomationRun {
  locoAddress: LocoAddress;
  routeId: RouteId;
  phase: AutomationPhase;
  /** The beam a berthing run is watching, chosen once at brake time (A3). */
  berthSensorId: SensorId | null;
  /** When the crawl began, for A11's timeout. */
  crawlStartedAt: Date | null;
  /**
   * The last blocker reported for this run, so a config gap is logged once
   * rather than four times a second forever (A7). Cleared when the run makes
   * any other decision.
   */
  reportedBlocker: string | null;
}

/** A decision, and the run it was made for — already advanced to its next phase. */
export interface AutomationAction {
  run: AutomationRun;
  decision: AutomationDecision;
}

export interface AutomationSweepInput {
  layoutId: LayoutId;
  /** `null` when topology failed to load; the sweep does nothing at all without one. */
  graph: TrackGraph | null;
  /** `canIssueAutoCommand(status, mode)`. False and the sweep proposes nothing. */
  permitted: boolean;
  /** Locos whose braking ramp is still issuing steps, from `LayoutService`. */
  brakingRunsInFlight: ReadonlySet<LocoAddress>;
  now: Date;
}

export class AutomationService {
  private readonly runs = new Map<LocoAddress, AutomationRun>();
  /**
   * Routes automation has already taken once.
   *
   * **A route is adopted at most once**, and that is what makes `abandon` mean
   * something. Without it, every teardown is undone 250 ms later: an emergency
   * stop leaves the route `active` and the mode `auto`, so the next sweep would
   * find an unowned route and depart the train again — restarting a train the
   * operator has just halted. The same applies to a run dropped because a
   * command was refused, or because the operator took the train.
   *
   * Pruned to the currently-`active` set on every sweep, so a route that is
   * **suspended and then resumed** is picked up again. That is the one case
   * where re-adoption is wanted, and it is wanted precisely because resuming is
   * an explicit operator action (D8).
   */
  private readonly adopted = new Set<RouteId>();

  constructor(
    private readonly repo: ILayoutRepository,
    private readonly stateManager: LayoutStateManager,
    private readonly reservationsOf: (layoutId: LayoutId) => readonly RouteReservation[],
    private readonly getRoute: (layoutId: LayoutId, routeId: RouteId) => RouteReservation | null,
    private readonly log: AutomationServiceLogger,
    private readonly model: StoppingDistanceModel = scalarStoppingDistance,
  ) {}

  /**
   * One tick: adopt any `active`, `auto` route that has no run yet, then decide
   * for every run.
   *
   * **Returns before it reads the roster when there is nothing to do** (A13).
   * A layout with no automated route — which is every layout that has not opted
   * in — pays one map lookup every 250 ms and no database query.
   *
   * The phase each decision implies is applied here, not by the caller, because
   * it is this service's own bookkeeping. What the caller reports back is
   * *failure*: `abandon` drops a run whose command was refused, which is the
   * only case where the phase this sweep wrote turns out to have been wrong.
   */
  async sweep(input: AutomationSweepInput): Promise<AutomationAction[]> {
    if (!input.permitted || input.graph === null) return [];

    this.adoptNewRoutes(input.layoutId);
    if (this.runs.size === 0) return [];

    const locos = await this.repo.listLocos(input.layoutId);
    const actions: AutomationAction[] = [];

    for (const run of [...this.runs.values()]) {
      const reservation = this.getRoute(input.layoutId, run.routeId);
      const roster = rosterEntryFor(locos, run.locoAddress);
      const { decisionInput, berthOffsetMm } = this.buildInput(run, reservation, roster, input);

      const outcome = decideAutomation(decisionInput, berthOffsetMm, this.model);
      this.applyPhase(run, outcome.nextPhase, outcome.decision, input.now);

      if (outcome.decision.kind === 'retire') {
        this.runs.delete(run.locoAddress);
        continue;
      }
      if (outcome.decision.kind === 'hold') continue;
      if (outcome.decision.kind === 'blocked') {
        this.reportBlocker(run, outcome.decision);
        continue;
      }

      actions.push({ run, decision: outcome.decision });
    }

    return actions;
  }

  /** Every run currently in flight — what the operator surface reads (PR C) and what `LayoutService` iterates to stand automation down. */
  listRuns(): AutomationRun[] {
    return [...this.runs.values()];
  }

  runFor(locoAddress: LocoAddress): AutomationRun | null {
    return this.runs.get(locoAddress) ?? null;
  }

  /**
   * Drops one run. Called by `LayoutService` when a command it issued on this
   * service's behalf was refused, when an operator takes the train (A12), and
   * when a berth or a stand-down has been carried out.
   *
   * Deliberately does not stop the loco — this service has no DCC access, and
   * whichever caller decides a run is over owns that half.
   */
  abandon(locoAddress: LocoAddress, reason: string): boolean {
    const run = this.runs.get(locoAddress);
    if (!run) return false;
    this.runs.delete(locoAddress);
    this.log.info('[AutomationService] Automation run abandoned', {
      locoAddress,
      routeId: run.routeId,
      phase: run.phase,
      reason,
    });
    return true;
  }

  /** Drops every run — Safe-Stop, emergency stop, and service shutdown (A13). */
  abandonAll(reason: string): void {
    for (const locoAddress of [...this.runs.keys()]) this.abandon(locoAddress, reason);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Adopts every `active`, `auto`-authority route with no run yet.
   *
   * `manual` authority is deliberately never adopted (A12): a route whose whole
   * meaning is "the operator is driving this reserved road" is not one to send
   * commands into, and a protective brake is still a command. An operator who
   * wants automation's guarantees asks for an `auto` route.
   *
   * A `suspended` route is not adopted either — the system has already decided
   * not to trust it, and resuming stays the operator's explicit action (D8).
   */
  private adoptNewRoutes(layoutId: LayoutId): void {
    const active = this.reservationsOf(layoutId).filter((r) => r.status === 'active');

    // Forget routes that are no longer active, so a suspended-then-resumed one
    // can be taken up again. Everything else stays remembered and is never
    // re-adopted — see the field's doc comment.
    const activeIds = new Set(active.map((r) => r.id));
    for (const routeId of [...this.adopted]) {
      if (!activeIds.has(routeId)) this.adopted.delete(routeId);
    }

    for (const reservation of active) {
      if (reservation.authority !== 'auto') continue;
      if (this.adopted.has(reservation.id)) continue;
      if (this.runs.has(reservation.locoAddress)) continue;

      this.adopted.add(reservation.id);
      this.runs.set(reservation.locoAddress, {
        locoAddress: reservation.locoAddress,
        routeId: reservation.id,
        phase: 'awaiting-departure',
        berthSensorId: null,
        crawlStartedAt: null,
        reportedBlocker: null,
      });
      this.log.info('[AutomationService] Automation run adopted', {
        layoutId,
        locoAddress: reservation.locoAddress,
        routeId: reservation.id,
      });
    }
  }

  /**
   * Resolves the berth once per tick, and everything else the decision needs.
   *
   * The berth beam is looked up fresh rather than cached on the run, so a beam
   * going out of service or faulting between two sweeps withdraws it — the same
   * trust rule `berthingBeamIn` applies, applied continuously rather than once.
   * `berthSensorOccupied`, in contrast, is read from the run's **chosen** sensor
   * id: once a run is committed to a beam, that beam and no other is what ends
   * the crawl.
   */
  private buildInput(
    run: AutomationRun,
    reservation: RouteReservation | null,
    roster: LocoRecord | null,
    input: AutomationSweepInput,
  ): { decisionInput: AutomationInput; berthOffsetMm: number } {
    const graph = input.graph as TrackGraph;
    const confirmedBlockId = reservation?.path[reservation.confirmedIndex]?.blockId ?? null;
    const berth = reservation ? this.resolveBerth(reservation, graph) : null;

    const berthObservation = run.berthSensorId
      ? this.stateManager.getSensorObservation(run.berthSensorId)
      : null;

    return {
      berthOffsetMm: berth?.offsetMm ?? 0,
      decisionInput: {
        reservation,
        phase: run.phase,
        loco: this.stateManager.getLoco(run.locoAddress) ?? null,
        profile: roster ? toBrakingProfile(roster) : null,
        autoSpeedStep: roster?.autoSpeedStep ?? null,
        crawlSpeedStep: roster?.crawlSpeedStep ?? null,
        graph,
        brakingRunInFlight: input.brakingRunsInFlight.has(run.locoAddress),
        confirmedBlockObservations: confirmedBlockId
          ? this.stateManager.listSensorObservationsForBlock(confirmedBlockId)
          : [],
        berthSensorId: run.berthSensorId ?? berth?.sensorId ?? null,
        berthSensorOccupied: berthObservation?.lastReading === 'occupied',
        crawlStartedAt: run.crawlStartedAt,
        now: input.now,
      },
    };
  }

  /**
   * A3: the beam a train arriving from `path[destinationIndex - 1]` should be
   * brought to a stand at, or `null`.
   *
   * A single-step path has no previous block, so there is no boundary the train
   * arrives over and no berth — a route that starts in its own destination is
   * not one anything departs on anyway.
   */
  private resolveBerth(
    reservation: RouteReservation,
    graph: TrackGraph,
  ): { sensorId: SensorId; offsetMm: number } | null {
    const destinationIndex = reservation.path.length - 1;
    const destinationBlockId = reservation.path[destinationIndex]?.blockId;
    const arrivedFromBlockId = reservation.path[destinationIndex - 1]?.blockId;
    if (destinationBlockId === undefined || arrivedFromBlockId === undefined) return null;

    return berthingBeamIn(
      this.stateManager.listSensorObservationsForBlock(destinationBlockId),
      graph,
      destinationBlockId,
      arrivedFromBlockId,
      graph.blockLengthsMm.get(destinationBlockId),
    );
  }

  /**
   * Writes the decided phase onto the run, plus the two pieces of bookkeeping
   * that hang off a transition rather than off a decision.
   *
   * `crawlStartedAt` is stamped on the *transition into* `crawling`, not on
   * every tick spent there — A11's timeout measures the crawl, not the sweep.
   */
  private applyPhase(
    run: AutomationRun,
    nextPhase: AutomationPhase,
    decision: AutomationDecision,
    now: Date,
  ): void {
    if (decision.kind === 'brake') {
      run.berthSensorId = decision.berthSensorId;
    }
    if (nextPhase === 'crawling' && run.phase !== 'crawling') {
      run.crawlStartedAt = now;
    }
    if (decision.kind !== 'blocked') {
      run.reportedBlocker = null;
    }
    run.phase = nextPhase;
  }

  /**
   * A7: a config gap is reported, never faulted — halting a railway because a
   * column is unset would be its own bug.
   *
   * Logged **once per distinct blocker** rather than on every tick. A sweep runs
   * four times a second, and a route granted against a loco with no
   * `auto_speed_step` would otherwise fill the log for as long as it is held,
   * burying whatever the operator actually needs to see.
   */
  private reportBlocker(run: AutomationRun, decision: AutomationDecision): void {
    if (decision.kind !== 'blocked') return;
    if (run.reportedBlocker === decision.reason.kind) return;

    run.reportedBlocker = decision.reason.kind;
    this.log.warn('[AutomationService] Automation cannot depart this train', {
      locoAddress: run.locoAddress,
      routeId: run.routeId,
      blocker: decision.reason.kind,
    });
  }
}

function toBrakingProfile(loco: LocoRecord): BrakingProfile {
  return { locoAddress: loco.address, maxSpeed: loco.maxSpeed, brakingFactor: loco.brakingFactor };
}

/**
 * The roster row for an address, or `null`.
 *
 * **Two rows for one address resolve to `null`**, matching
 * `BrakingService.resolveProfile`'s `ambiguous-loco` refusal rather than
 * quietly taking the first: two `brakingFactor`s (or two line speeds) for one
 * train is not something to pick between. Here it surfaces as A7's
 * `not-in-roster` blocker, which is the honest reading — there is no single
 * roster entry for this train.
 */
function rosterEntryFor(locos: readonly LocoRecord[], address: LocoAddress): LocoRecord | null {
  const matches = locos.filter((l) => l.address === address);
  return matches.length === 1 ? matches[0] : null;
}
