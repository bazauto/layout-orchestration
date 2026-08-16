/**
 * The automation engine's decision layer (#7). See `docs/automation.md` for the
 * decision record (A1–A13) this module implements.
 *
 * Pure — no clock, no I/O, no mutation. `now` arrives as an argument for the
 * same reason it does in `domain/sensorPosition.ts`: the caller reads the clock
 * and this module only subtracts, which is what keeps the whole state machine
 * exercisable under `ManualClock` without a real timer.
 *
 * **This module decides; it never commands.** `decideAutomation` answers "what
 * should happen to this train right now, and what phase is it in afterwards" —
 * `services/AutomationService.ts` gathers the inputs and `LayoutService`
 * executes the answer against DCC. That is the same split
 * `domain/pointConfirmation.ts` / `PointConfirmationService` / `LayoutService`
 * already draws, and it is what makes every transition below testable without a
 * layout attached to it.
 *
 * **It decides *when*, never *whether it is possible*.** The trigger below
 * computes a distance to find the moment braking becomes necessary; whether a
 * plan can actually be granted at that moment stays `BrakingService`'s
 * question, answered by `planStopAtRouteBoundary` and its refusals. The
 * duplicated arithmetic is deliberate and is not duplicated *policy*: this
 * module owns the moment, `docs/braking.md` owns the physics, and a refusal at
 * the moment this module picked is what A10's `unable-to-stop` fault is.
 */

import {
  BrakingProfile,
  LocoState,
  RouteReservation,
  SensorId,
  SensorObservation,
  TravelDirection,
} from './types';
import { TrackGraph } from './graph';
import {
  StoppingDistanceModel,
  describeBrakingRefusal,
  remainingRouteDistanceMm,
  requiredDistanceMm,
  scalarStoppingDistance,
} from './braking';
import { MAX_CREDIBLE_SPEED_MM_PER_S, leadDistanceMm } from './sensorPosition';

// ─── Constants (A6, A11) ───────────────────────────────────────────────────────

/**
 * How often the engine re-evaluates every automated route (A6).
 *
 * Matches #25's confirmation sweep, and for the same structural reason rather
 * than by coincidence: a periodic pure predicate is exercisable by
 * `ManualClock`, and per-event hooks are not. It is a *sweep* rather than a hook
 * on occupancy changes because the available distance shrinks continuously —
 * #77's lead term decays with the age of its fix — so the moment braking becomes
 * necessary can fall between two occupancy events. A sweep subsumes an
 * event-driven trigger; the reverse is not true.
 */
export const AUTOMATION_TICK_MS = 250;

/**
 * How much earlier than the point of no return the brake trigger fires (A6).
 *
 * **Derived, not tuned.** It is the largest amount the available distance can
 * fall between two consecutive sweeps: the lead term's decay is bounded by
 * `MAX_CREDIBLE_SPEED_MM_PER_S` by construction (#77 D7), and every other way
 * the figure moves is only observable on a sweep anyway. So it is the smallest
 * margin that guarantees the trigger fires while the plan is still grantable.
 * Smaller and the first sweep to notice would already be past the point
 * `planBrakingSchedule` refuses at; larger is arbitrary.
 *
 * Written as the expression rather than as `125` on purpose: if either constant
 * moves, this follows, and nobody has to remember that it should.
 */
export const APPROACH_MARGIN_MM = (MAX_CREDIBLE_SPEED_MM_PER_S * AUTOMATION_TICK_MS) / 1000;

/**
 * How long a berthing crawl may run before it is given up on (A11).
 *
 * Deliberately generous. A crawl can legitimately have to cover most of a block
 * — that is A5's whole point, the crawl absorbing B4's conservatism — at a speed
 * step chosen to be the slowest the loco reliably moves at. A timeout that fired
 * on a *working* berthing run would be worse than none, because it would train
 * the operator to ignore it.
 *
 * It is a wall-clock number with no distance behind it, and that is stated
 * rather than dressed up: the honest version needs the velocity model
 * `docs/braking.md` B7 deferred. What it catches is a dead beam, a train stalled
 * on dirty rail, and a crawl step set below what the loco actually moves at —
 * all three need a human, and all three otherwise leave a train under power
 * indefinitely.
 */
export const CRAWL_TIMEOUT_MS = 120_000;

// ─── Vocabulary ────────────────────────────────────────────────────────────────

/**
 * Where a train is in its automated journey.
 *
 * Held per loco by `AutomationService` rather than derived, because two of these
 * are indistinguishable from the outside: a train stopped because it has not
 * departed and a train stopped because it has berthed look identical in
 * `LocoState`.
 */
export type AutomationPhase =
  | 'awaiting-departure'
  | 'running'
  | 'braking'
  | 'crawling'
  | 'berthed';

/** Why automation is not departing a train. Not faults — an unconfigured route is a config gap, and halting a railway over one would be its own bug (A7). */
export type AutomationBlocker =
  | { kind: 'no-direction' }
  | { kind: 'no-auto-speed' }
  | { kind: 'not-in-roster' }
  /** A7: the route cannot be stopped at from where the train stands, so it is never started. Carries the arithmetic, because 'not enough room' is only actionable if you know how much short. */
  | { kind: 'no-stopping-distance'; detail: string };

export type AutomationDecision =
  /** Nothing to do this tick. */
  | { kind: 'hold' }
  /** The run is finished with; `AutomationService` drops it. */
  | { kind: 'retire' }
  /** Something an operator must fix before this train moves. Reported, never faulted. */
  | { kind: 'blocked'; reason: AutomationBlocker }
  | { kind: 'depart'; speedStep: number; direction: TravelDirection }
  /**
   * Start a braking run now. `berthSensorId` is `null` for a boundary stop and
   * carries the beam's identity for a berthing one — the same beam whose offset
   * is already folded into `availableMm`, so the crawl cannot end up watching a
   * different one (A3).
   */
  | {
      kind: 'brake';
      targetIndex: number;
      toSpeedStep: number;
      berthOffsetMm: number;
      berthSensorId: SensorId | null;
      availableMm: number;
      requiredMm: number;
    }
  /** The beam broke: stop, the train is where it was asked to be. */
  | { kind: 'berth' }
  /** A11's backstop fired: stop, and latch `berth-not-confirmed`. */
  | { kind: 'crawl-timeout'; sensorId: SensorId }
  /**
   * A crawl was interrupted rather than finished: **stop the train**, then
   * retire. Distinct from `retire`, which drops a run that is not moving under
   * automation's own command.
   *
   * A crawling train is the one phase whose speed automation itself put there
   * and that nothing else is guaranteed to take away — a completed route
   * releases no throttle, and a mode change to `manual` suspends routes without
   * touching a train whose route already completed. Retiring the run without
   * stopping it would leave a train crawling under nobody's authority.
   */
  | { kind: 'stand-down'; reason: string };

export interface AutomationOutcome {
  decision: AutomationDecision;
  nextPhase: AutomationPhase;
}

/**
 * Everything `decideAutomation` needs about one automated train, gathered by
 * `AutomationService` from the repository, `LayoutStateManager` and the clock.
 */
export interface AutomationInput {
  /**
   * The route this run belongs to, or `null` once it has left `active`.
   *
   * `null` is a normal, expected state and not an error: a route completes the
   * instant its destination block reads `occupied`, which is as the train's
   * *front* enters — long before it reaches a beam at the far end. The berthing
   * crawl therefore outlives its own reservation by design (A8), and this is
   * where that shows up.
   */
  reservation: RouteReservation | null;
  phase: AutomationPhase;
  /** `null` when the loco has never been commanded, or a restart lost it. Never assume speed 0 (B6). */
  loco: LocoState | null;
  /** `null` when the loco is not in the roster. */
  profile: BrakingProfile | null;
  autoSpeedStep: number | null;
  crawlSpeedStep: number | null;
  graph: TrackGraph;
  /** True while a braking ramp for this loco is still issuing steps. */
  brakingRunInFlight: boolean;
  /** Observations for the train's confirmed block — #77's lead term. */
  confirmedBlockObservations: readonly SensorObservation[];
  /** The beam this run is berthing against, chosen once at brake time. */
  berthSensorId: SensorId | null;
  /** Whether that beam currently reads `occupied` — the arrival measurement (A2). */
  berthSensorOccupied: boolean;
  /** When the crawl phase began, for A11's timeout. */
  crawlStartedAt: Date | null;
  now: Date;
}

// ─── The decision ──────────────────────────────────────────────────────────────

/**
 * One automated train, one tick.
 *
 * The ordering below is the state machine, and the two checks in front of it
 * are the ones that must come first whatever phase the train is in:
 *
 *  1. **A crawl outlives its route** (A8), so a missing reservation retires
 *     every phase except `crawling`, which carries on against the beam.
 *  2. **A berthed train is done.**
 *
 * `berthOffsetMm` is resolved by the caller (`AutomationService`) rather than
 * here, because resolving it needs `berthingBeamIn` against the destination
 * block's observations *and* its measured length, and threading the beam's
 * identity out of a decision function that also has to return a phase would
 * make this signature the wrong shape for the one thing it is good at.
 */
export function decideAutomation(
  input: AutomationInput,
  berthOffsetMm: number,
  model: StoppingDistanceModel = scalarStoppingDistance,
): AutomationOutcome {
  const { reservation, phase } = input;

  if (phase === 'berthed') return { decision: { kind: 'retire' }, nextPhase: 'berthed' };

  // A8's rule, and the one distinction it turns on: a route that **completed**
  // is not a route that was **taken away**.
  //
  // A completed route is the normal case — it releases the instant its
  // destination block reads `occupied`, which is as the train's front enters,
  // long before a beam at the far end. The crawl outliving it is the design.
  //
  // A cancelled or suspended route is an interruption, and a crawl is the one
  // phase whose speed automation itself commanded and that nothing else
  // reliably takes away. So an interrupted crawl stands the train down rather
  // than quietly dropping the run and leaving it moving.
  const status = reservation?.status ?? null;
  const interrupted = status === 'cancelled' || status === 'suspended';

  if (phase === 'crawling') {
    if (interrupted) {
      return {
        decision: { kind: 'stand-down', reason: `route is ${status}` },
        nextPhase: 'berthed',
      };
    }
  } else if (status !== 'active') {
    return { decision: { kind: 'retire' }, nextPhase: phase };
  }

  switch (phase) {
    case 'awaiting-departure':
      return decideDeparture(input, berthOffsetMm, model);
    case 'running':
      return decideApproach(input, berthOffsetMm, model);
    case 'braking':
      return decidePostRamp(input);
    case 'crawling':
      return decideCrawl(input);
  }
}

/**
 * A7: two things automation cannot derive, and refuses without either.
 *
 * A train already moving in this phase is not blocked on anything — it has been
 * departed and the sweep simply has not caught up — so it advances to `running`
 * without re-commanding a speed. Re-issuing `depart` at line speed to a train
 * already at line speed would be harmless today and would become a way to
 * override a ramp the moment anything else commanded this loco.
 *
 * **A missing `LocoState` does not block a departure**, which is a deliberate
 * asymmetry with `docs/braking.md` B6's `unknown-loco-state` refusal and not an
 * oversight. B6 refuses because a braking plan needs the current commanded
 * speed as an *input to a calculation* — without it there is no stopping
 * distance to compute, and assuming zero would be assuming the train is
 * stopped, which D9 exists to forbid. A departure computes nothing from it: it
 * *sets* the speed, replacing an unknown with a known.
 *
 * Refusing here would also make automation unusable from a cold start, since
 * nothing gives a loco a `LocoState` until something commands it — and the one
 * thing an operator could do to establish one, opening the throttle, cancels
 * the very route they are trying to automate (D6).
 */
function decideDeparture(
  input: AutomationInput,
  berthOffsetMm: number,
  model: StoppingDistanceModel,
): AutomationOutcome {
  const { loco, autoSpeedStep, reservation, profile } = input;

  if (profile === null) return blocked({ kind: 'not-in-roster' }, 'awaiting-departure');
  if (loco !== null && loco.speed > 0) return { decision: { kind: 'hold' }, nextPhase: 'running' };

  const direction = reservation?.direction ?? null;
  if (direction === null) return blocked({ kind: 'no-direction' }, 'awaiting-departure');
  if (autoSpeedStep === null) return blocked({ kind: 'no-auto-speed' }, 'awaiting-departure');

  // A7: **do not start a journey that cannot be stopped at the end of it.**
  //
  // This is the one check that looks at the whole route before moving, and it
  // exists because the alternatives are both bad. Without it, a route with an
  // unmeasured block in it departs and then never brakes — `remainingRouteDistanceMm`
  // refuses for as long as the block stays unmeasured, and A6's trigger has
  // nothing to fire on. And a route whose destination is the very next block
  // with no berthing beam departs and faults `unable-to-stop` a quarter of a
  // second later, halting the layout to say something that could have been said
  // before anything moved.
  //
  // A *blocker*, not a fault, for A7's reason: it names a layout that has not
  // been measured or beamed yet, which is an operator's job to finish and not a
  // reason to halt a railway.
  const stoppable = canPlanAStop(input, autoSpeedStep, berthOffsetMm, model);
  if (!stoppable.ok) {
    return blocked({ kind: 'no-stopping-distance', detail: stoppable.detail }, 'awaiting-departure');
  }

  return {
    decision: { kind: 'depart', speedStep: autoSpeedStep, direction },
    nextPhase: 'running',
  };
}

/**
 * Whether a stop at `targetIndex` could be planned from where the train stands
 * now, at the speed it is about to be given.
 *
 * Deliberately the *same* two computations A6's trigger and `BrakingService`
 * both use, rather than an approximation of them — asked early, against the
 * departure speed, so the answer means "this journey is supervisable" rather
 * than "this journey is over".
 */
function canPlanAStop(
  input: AutomationInput,
  speedStep: number,
  berthOffsetMm: number,
  model: StoppingDistanceModel,
): { ok: true } | { ok: false; detail: string } {
  const { reservation, profile, graph } = input;
  if (reservation === null || profile === null) return { ok: true };

  const targetIndex = reservation.path.length - 1;
  const available = remainingRouteDistanceMm(
    reservation,
    graph,
    targetIndex,
    undefined,
    berthOffsetMm,
  );
  if (!available.ok) {
    return { ok: false, detail: describeBrakingRefusal(available.reason) };
  }

  const estimate = model(profile, { commandedSpeedStep: speedStep, direction: 'fwd' });
  if (!estimate.known) return { ok: false, detail: 'the braking model cannot estimate a distance' };

  const requiredMm = requiredDistanceMm(estimate.distanceMm);
  if (available.distanceMm < requiredMm) {
    return {
      ok: false,
      detail: `${Math.round(available.distanceMm)}mm of measured track to the stopping point, and a stop from speed step ${speedStep} needs ${Math.round(requiredMm)}mm`,
    };
  }
  return { ok: true };
}

/**
 * A6's trigger: brake when the guaranteed remaining distance has fallen to
 * within one sweep's worth of worst-case travel of what a full stop needs.
 *
 * Every way of not being able to answer the question **holds rather than
 * brakes**, which deserves justifying because it is the opposite of this
 * codebase's usual reflex. A `hold` here is not "carry on regardless": the train
 * is running under a route whose track is reserved and clear, and the sweep asks
 * again in 250 ms. Braking on an unanswerable question would mean stopping
 * trains mid-section every time a block length was missing — while the thing
 * that actually protects the train, `unmeasured-track` refusing the *plan*, is
 * already built and already Safe-Stops through A10. So the failure direction
 * here is "keep asking", and the failure direction one layer down is "refuse and
 * fault".
 */
function decideApproach(
  input: AutomationInput,
  berthOffsetMm: number,
  model: StoppingDistanceModel,
): AutomationOutcome {
  const { reservation, loco, profile, graph, crawlSpeedStep } = input;
  if (reservation === null || loco === null || profile === null) {
    return { decision: { kind: 'hold' }, nextPhase: 'running' };
  }

  // A train that has stopped without automation asking it to has been stopped by
  // something else — an emergency stop, a rejected command. Nothing to brake.
  if (loco.speed === 0) return { decision: { kind: 'hold' }, nextPhase: 'running' };

  const targetIndex = reservation.path.length - 1;
  const berthSensorId = berthOffsetMm > 0 ? input.berthSensorId : null;

  const available = remainingRouteDistanceMm(
    reservation,
    graph,
    targetIndex,
    { observations: input.confirmedBlockObservations, now: input.now },
    berthOffsetMm,
  );
  // A moving train whose remaining distance cannot be computed is one this
  // engine cannot keep its promise about, so it is stood down rather than held.
  //
  // Holding was the first instinct and it is wrong: the causes are not
  // transient. `unmeasured-track` stays refused for as long as the block stays
  // unmeasured, so a train that met it would coast to the end of its authority
  // while the sweep politely asked again four times a second. A7's departure
  // check is what makes this branch rare — the whole route is proved
  // supervisable before anything moves — so reaching it means the layout
  // changed under a running train, which is exactly when to stop it.
  if (!available.ok) {
    return standDown(`remaining distance cannot be computed: ${describeBrakingRefusal(available.reason)}`);
  }

  const estimate = model(profile, {
    commandedSpeedStep: loco.speed,
    direction: loco.direction,
  });
  if (!estimate.known) {
    return standDown('the braking model cannot estimate a stopping distance for this loco');
  }

  const requiredMm = requiredDistanceMm(estimate.distanceMm);
  const lastChance = isLastChanceToPlan(input, targetIndex, available.distanceMm, requiredMm);

  if (!lastChance && available.distanceMm > requiredMm + APPROACH_MARGIN_MM) {
    return { decision: { kind: 'hold' }, nextPhase: 'running' };
  }

  // A2/A7: no beam, or no crawl step configured for this loco, and there is no
  // berthing to do — the ramp runs to a stand at the destination's entry
  // boundary, which is `docs/braking.md` B4 unchanged.
  const berthing = berthSensorId !== null && crawlSpeedStep !== null && crawlSpeedStep < loco.speed;

  return {
    decision: {
      kind: 'brake',
      targetIndex,
      toSpeedStep: berthing ? crawlSpeedStep : 0,
      berthOffsetMm: berthing ? berthOffsetMm : 0,
      berthSensorId: berthing ? berthSensorId : null,
      availableMm: available.distanceMm,
      requiredMm,
    },
    nextPhase: 'braking',
  };
}

/**
 * A6's second trigger: **is this the last moment a viable plan can be made?**
 *
 * The distance trigger alone is not enough, because the *ability to plan* runs
 * out before the distance does. Available distance falls in steps as the train
 * is confirmed further along — each block it enters stops being intermediate
 * track and starts being track it may already be at the far end of — and a
 * route completes outright the instant its destination reads `occupied`, after
 * which `remainingRouteDistanceMm` refuses and nothing can plan anything. A
 * train that crosses one boundary too many is a train nothing will ever brake.
 *
 * So the question asked here is not "is it close" but "will I still be able to
 * do this next time I look":
 *
 * - **The next step is the target.** There is no next confirmation to wait for;
 *   the route ends. Brake unless a position fix says the train cannot reach the
 *   boundary before the next sweep — which is `lead <= APPROACH_MARGIN_MM`,
 *   the same margin answering the same question it always answers: how far can
 *   this train get before I look again. Without a fix the lead is `0`, so
 *   braking begins on entry to the last block.
 *
 * - **Otherwise**, project the worst case one confirmation ahead: the train
 *   enters the next block with no fix in it, so what remains is today's figure
 *   less this block's lead and less the whole of the block being entered. If
 *   *that* would not cover a stop, this is the last usable moment and the train
 *   brakes now.
 *
 * That second branch is what keeps the no-beam case working. Without a berth,
 * available distance from the second-to-last block is zero — B4's adjacent-target
 * case exactly — so braking has to begin a block earlier, and this is what
 * notices.
 */
function isLastChanceToPlan(
  input: AutomationInput,
  targetIndex: number,
  availableMm: number,
  requiredMm: number,
): boolean {
  const { reservation, graph } = input;
  if (reservation === null) return false;

  const confirmedIndex = reservation.confirmedIndex;
  const nextIndex = confirmedIndex + 1;
  const confirmedBlockId = reservation.path[confirmedIndex]?.blockId;
  const nextBlockId = reservation.path[nextIndex]?.blockId;
  if (confirmedBlockId === undefined || nextBlockId === undefined) return false;

  const leadMm = leadDistanceMm(
    input.confirmedBlockObservations,
    graph,
    confirmedBlockId,
    nextBlockId,
    input.now,
  );

  if (nextIndex >= targetIndex) return leadMm <= APPROACH_MARGIN_MM;

  // An unmeasured next block cannot be projected past. `remainingRouteDistanceMm`
  // has already refused on it above and this branch is unreachable, but treating
  // the unknown as contributing nothing keeps the arithmetic honest either way.
  const nextBlockLengthMm = graph.blockLengthsMm.get(nextBlockId) ?? 0;
  const availableAfterNextStep = availableMm - leadMm - nextBlockLengthMm;
  return availableAfterNextStep < requiredMm;
}

/**
 * The ramp has stopped issuing steps. Where that leaves the train depends
 * entirely on what the ramp was planned to end at (A4's `endsAtSpeedStep`,
 * carried here as "is there a beam we are berthing against").
 *
 * Reaching speed step 0 is a *command*, not a confirmation that the train
 * stopped (B5) — which is why a boundary stop goes to `berthed` and retires
 * rather than asserting anything about where the train is. B5's own overrun
 * expectation, armed by `LayoutService` and outliving the ramp, is what still
 * watches for it having gone too far.
 */
function decidePostRamp(input: AutomationInput): AutomationOutcome {
  if (input.brakingRunInFlight) return { decision: { kind: 'hold' }, nextPhase: 'braking' };

  if (input.berthSensorId === null) {
    return { decision: { kind: 'retire' }, nextPhase: 'berthed' };
  }
  return { decision: { kind: 'hold' }, nextPhase: 'crawling' };
}

/**
 * A2's closed loop, and A11's backstop behind it.
 *
 * The beam is checked before the timeout, so a berthing run that succeeds on the
 * very tick the timeout would have fired berths rather than faulting. That is
 * not a niceness: the two are decided from the same `now`, and preferring the
 * arrival is the only ordering under which a working railway cannot be told it
 * failed.
 */
function decideCrawl(input: AutomationInput): AutomationOutcome {
  const sensorId = input.berthSensorId;
  if (sensorId === null) return { decision: { kind: 'retire' }, nextPhase: 'berthed' };

  if (input.berthSensorOccupied) {
    return { decision: { kind: 'berth' }, nextPhase: 'berthed' };
  }

  const startedAt = input.crawlStartedAt;
  if (startedAt !== null && input.now.getTime() - startedAt.getTime() >= CRAWL_TIMEOUT_MS) {
    return { decision: { kind: 'crawl-timeout', sensorId }, nextPhase: 'berthed' };
  }

  return { decision: { kind: 'hold' }, nextPhase: 'crawling' };
}

function blocked(reason: AutomationBlocker, phase: AutomationPhase): AutomationOutcome {
  return { decision: { kind: 'blocked', reason }, nextPhase: phase };
}

/** Stop the train and give the run up. `berthed` is the terminal phase for every run that ends, however it ends. */
function standDown(reason: string): AutomationOutcome {
  return { decision: { kind: 'stand-down', reason }, nextPhase: 'berthed' };
}

/** Human-readable summary of a blocker, for log lines and the operator surface — mirrors `describeBrakingRefusal`. */
export function describeAutomationBlocker(reason: AutomationBlocker): string {
  switch (reason.kind) {
    case 'no-direction':
      return 'the route states no direction — automation cannot know which way round the loco sits';
    case 'no-auto-speed':
      return 'the loco has no automation speed step configured';
    case 'not-in-roster':
      return 'the loco is not in the roster';
    case 'no-stopping-distance':
      return `this route cannot be stopped at, so it is not started: ${reason.detail}`;
  }
}
