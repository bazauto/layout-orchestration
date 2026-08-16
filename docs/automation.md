# Automation Engine — Decision Record (#7)

> **Status: PR A shipped (the model).** A1–A13 below are decided. PR A landed
> the pure half — the schema the operator configures automation with, the berth
> geometry, the ramp-to-a-crawl extension to `domain/braking.ts`, and
> `domain/automation.ts` itself. **Nothing is wired**: no sweep runs, no train
> moves, and the live layout behaves exactly as it did before. PR B is the
> engine that drives it; PR C is the operator surface.

Companion to `docs/braking.md`, `docs/route-locking.md`, `docs/pathfinding.md`
and `docs/sensor-position.md`. Those four decided, in order, how far a train
takes to stop, what track it is allowed on, how that track is chosen, and where
in a block it actually is. This document decides the only thing left: **when to
open the regulator and when to shut it**.

Same posture as the other decision records — not binding the way
`docs/mqtt-contract.md` is, but it explains *why*, so the next change does not
quietly undo a deliberate choice.

Read this before touching `domain/automation.ts`,
`services/AutomationService.ts`, or `LayoutService`'s automation sweep.

---

## A1 — What automation is, and the one invariant

**Automation drives a route with `authority: 'auto'`, from departure to a
berthed stop.** The operator grants the route and says which way the loco
faces; automation does the rest.

Everything in this document serves one invariant:

> **A train under automation never passes the end of its authority.**

That is the whole of "collision avoidance" on this railway, and it is a
stronger claim than it looks. Two trains cannot converge on one block, because
`planReservation` will not grant two routes over the same block (D2,
`docs/route-locking.md`) — exclusivity is settled at grant time and needs no
runtime avoidance. What was genuinely unprotected before #7 is the *end* of a
route: a train reaching its destination and simply carrying on into unreserved
track raised nothing at all. `onOccupancyChange` looks up the route holding the
block that changed, and an unreserved block has no holder, so nothing fired.
A9 closes that.

So #7's scope is not "steer trains around each other". It is "guarantee each
train stops inside what it holds" — and, because the reservation engine already
guarantees no two trains hold the same track, those are the same guarantee.

**The issue's framing of "approaching an occupied or unreserved block" is
therefore rewritten here rather than implemented literally.** A block on the
path cannot be occupied by anything else without that already being a D7 route
violation (cancel + Safe-Stop, built), and a block off the path is not
somewhere a route may go. Both halves are covered; neither needs a new
approach detector.

## A2 — The stop target is a beam, not a boundary

`docs/braking.md` B4 stops a braked run at the **entry boundary of the
destination block**, and records the consequence honestly: "an automated route
therefore does not berth *inside* its destination block — reaching a specific
spot within a block needs a second, slower 'creep' move, which is #7's
territory".

This is that creep move, and the operator's intent is what sets its shape.
Westgate Hollow's IR beams are being fitted **where a train should stand** —
alongside the platform, at the goods shed loading bank — not at block
boundaries. So:

**The target of an automated stop is the berthing beam in the destination
block.** Automation brakes so as to arrive at the beam, crawls the last part,
and stops when the beam breaks.

**This is the only closed loop in the system.** Everything else here is
open-loop dead reckoning (B7): a commanded speed step is the only speed
knowledge there is, and a predicted stopping distance is never confirmed. A
beam breaking is different in kind — it is a *measurement of arrival*, taken by
the railway, at the exact place the train was asked to stop. Every other part
of this model exists to get the train close enough for that measurement to be
the thing that stops it.

**A destination with no usable berthing beam degrades to B4's boundary stop.**
Not to a guess, and not to a refusal: the train halts short of the destination
block, exactly as `startRouteStop` does today, and the operator berths it. That
is what makes this feature arrive incrementally as beams are fitted — the same
coverage-not-model posture `docs/sensor-position.md` takes.

## A3 — Berth geometry reuses #77's anchor, and picks the nearest beam

A berthing beam is an ordinary `ir_position` sensor carrying #77's measured
pair — `positionTowardBlockId` and `positionOffsetMm`, "this sensor lies
`offsetMm` of track before the boundary its own block shares with that
neighbouring block". No new column, no new vocabulary, and an operator who has
already done #77 PR C's tape-measure pass has already configured berthing.

`berthingBeamIn(observations, graph, blockId, fromBlockId, blockLengthMm)`
resolves it, and **both anchor directions are accepted**, because which one an
operator naturally reaches for depends on the block:

| Beam measured toward | Distance past the entry boundary | Typical case |
|---|---|---|
| `fromBlockId` — the block the train is arriving from | `offsetMm` | a terminal block: the platform road, the goods shed. Its only neighbour *is* the block behind. |
| any other neighbour — the far end | `blockLengthMm - offsetMm` | a through block, where the near end is the natural thing to measure to |

The far-end form needs `blocks.length_mm`, so an unmeasured block has no
far-end berth. It falls through to A2's boundary stop rather than guessing —
`DEFAULT_BLOCK_LENGTH_MM` is no more admissible here than it is in B4, and for
the same reason: guessing a cost steers a search, guessing a stopping point is
a collision.

Three rules, all fail-safe:

- **The anchor must be unambiguous.** `isAnchorUnambiguous` (D5,
  `docs/sensor-position.md`) — two blocks joined in two places, or nowhere, and
  the offset does not describe a definite boundary. No berth.
- **The beam must be trusted.** `isContributingSensor` — out of service,
  faulted, or never having reported, and it is not something to stop a train
  on. No berth. A beam the system has stopped trusting for occupancy is not one
  to stop a train against either, which is exactly `positionFixFrom`'s rule at
  the other end of the route.
- **Several candidates take the minimum**, i.e. the beam nearest the entry
  boundary. Not the newest and not the furthest: a minimum needs no argument
  about which measurement supersedes which, and stopping at the first beam is
  the fail-safe pick under every ordering. Two beams in one block is an
  operator saying "stop here" twice; honouring the earlier one is the
  conservative reading.

**Unlike #77's lead term, a berth offset does not decay.** `creditedDistanceMm`
subtracts a travel allowance because a lead fix is an observation *of a moving
train* and goes stale the instant it is taken. A berth offset is the position
of a screwed-down piece of infrastructure. It is as true a minute later as it
was when the tape came off it. Ageing it would be ageing the wrong thing.

## A4 — The ramp ends at a crawl; the distance it must fit in does not change

`planBrakingSchedule` gained a `toSpeedStep`, defaulting to `0` so every
existing caller is byte-identical. A berthing run passes the loco's crawl speed
instead, and the schedule carries `endsAtSpeedStep` so an executor can tell a
ramp that ends stopped from one that ends crawling.

**`toSpeedStep` changes what the ramp commands, and deliberately not what it
requires.** The distance check is still B5's, against the full stop:

```
estimate  = model(fromSpeedStep)          // unchanged
required  = requiredDistanceMm(estimate)  // unchanged
refuse if required > available            // unchanged
```

That is stricter than the physics needs — a ramp that only has to reach crawl
speed needs `d(s₁) − d(s₂)`, not `d(s₁)` — and being stricter here is worth more
than being exact. Three reasons:

- **The question it asks stays the fail-safe one.** "Could this train have come
  to a complete stand in the track available?" is answerable without knowing
  anything about what happens after the ramp. A budget that assumed the crawl
  would be allowed to continue would be assuming the beam works.
- **The slack it leaves is exactly the crawl allowance.** `available - required`
  is track the ramp does not need, and the crawl is what spends it. So the
  allowance needs no constant of its own and cannot be tuned wrong: a longer
  approach simply yields a longer crawl.
- **It leaves B5 untouched**, so `insufficient-distance` means the same thing
  for an automated run as it does for the operator's B8 calibration stop.

Worth recording, because it is the arithmetic behind that slack:
`d(s₁) − d(s₂)` *is* the exact distance for a partial ramp under B1, and needs
no new calibration axis. B1 is quadratic in normalised speed precisely because
constant deceleration gives `d = v²/2a`, and under constant deceleration the
distance from `v₁` to `v₂` is `(v₁² − v₂²)/2a` — which is `d(v₁) − d(v₂)`
exactly. B2's `StoppingDistanceModel` seam is untouched; a measured per-loco
curve substitutes into both terms. Nothing uses it today, and the reason it is
written down is so the next person to reach for it knows it is available and
that not using it was a choice.

**A berthed train stands slightly past its beam**, by its stopping distance at
crawl speed — floored at `MIN_STOPPING_DISTANCE_MM`, so ~50 mm at worst, which
is a couple of centimetres of real track. That is not an error to correct in
software; it is what stopping is. Site the beam that far short of where the
train should stand.

## A5 — The crawl is what makes B4's conservatism usable

B4 measures available distance from the **exit boundary** of the confirmed
block, because a train confirmed in a block may be anywhere within it —
including hard against the exit. That is right, and it is also brutally
pessimistic in the ordinary case: a train that has *just* entered a block has
that whole block still ahead of it, and the model will not promise a millimetre
of it. #77's lead term rescues a block with a positioned beam in it; a block
without one still promises nothing.

Left alone, that means automation brakes far too early — often a whole block
early — and a train would stop short of its berth by an embarrassing margin.

**The crawl absorbs all of it.** The braking ramp only has to get the train
down to crawl speed *somewhere* before the beam; the crawl then covers whatever
distance the conservative model left on the table, and the beam — not the model
— is what stops the train. So the dead-reckoning half is allowed to be as
pessimistic as B4 makes it, and the closed-loop half still berths the train
where the operator put the beam.

This is the load-bearing insight of the whole design. **Do not "fix" B4's
conservatism to make automation stop more precisely.** Precision comes from the
beam. B4's job is to guarantee the train is *slow* by the time it gets there,
and being early at that is free.

The visible cost is time: a train may crawl for most of a block. That is a
speed-of-operation cost, not a safety one, and it shrinks as beams are fitted
(a lead fix in the confirmed block moves the braking point later).

## A6 — The trigger, and why the margin is one sweep of `MAX_CREDIBLE_SPEED`

Automation evaluates every `active`, `auto`-authority route on a sweep against
the injected `IClock` — `AUTOMATION_TICK_MS = 250`, the same cadence and the
same mechanism as #25's confirmation sweep. Not an event-driven hook on
occupancy changes, for a reason that only exists since #77: the available
distance **shrinks continuously**, because the lead term decays with the age of
its fix (D7, `docs/sensor-position.md`). The moment at which braking becomes
necessary can therefore fall between two occupancy events, and a purely
event-driven trigger would sail past it. A periodic sweep subsumes the
event-driven one; the reverse is not true.

The rule, per route:

```
available = remainingRouteDistanceMm(reservation, graph, targetIndex, lead, berthOffsetMm)
required  = requiredDistanceMm(estimate(commandedSpeed))
brake when available <= required + APPROACH_MARGIN_MM
```

`required` is the full-stop figure, per A4 — the crawl speed does not enter the
trigger any more than it enters the plan.

`APPROACH_MARGIN_MM = MAX_CREDIBLE_SPEED_MM_PER_S * AUTOMATION_TICK_MS / 1000`
= **125 mm**.

That is not a tuned number. It is the largest amount `available` can fall
between two consecutive sweeps — the lead term's decay is bounded by
`MAX_CREDIBLE_SPEED_MM_PER_S` by construction (D7), and the only other way
`available` moves is a `confirmedIndex` advance, which can only be observed on
a sweep anyway. So it is the **smallest margin that guarantees the trigger
fires while the plan is still grantable**. Any smaller and the first sweep to
notice would already be past the point `planBrakingSchedule` refuses at; any
larger is arbitrary.

Deriving it from the two constants rather than writing `125` is the point: if
either changes, the margin follows, and nobody has to remember that it should.

## A7 — Departure needs two things the system cannot derive, and refuses without either

**Direction is an operator input, not a derivable fact.** A route's path
carries `entryEnd`/`exitEnd` — the geometric direction of travel along the
track — but the DCC direction bit depends on which way round the loco is
sitting on the rails, and nothing in this system can know that. There is no
loco feedback channel and never will be (B7). So `route_reservations.direction`
is nullable, set by the operator when the route is granted, and **an
`auto`-authority route with a null direction never departs.**

Its two values are `'fwd'` and `'rev'` — `Direction` less `'stop'`, named
`TravelDirection` so the exclusion is derived rather than restated. `'stop'` is
inadmissible because this states orientation, not a commanded state, and the
shared vocabulary means the stored value drops straight into a `setSpeed` call.

It lives on the reservation rather than on the loco because it is a property of
*this journey* — the same loco runs forward out of the yard and reverse back
into it — and it sits beside `authority`, which is already "who drives this
route".

**Line speed and crawl speed are roster configuration.** `locos.auto_speed_step`
and `locos.crawl_speed_step`, both nullable integers on `[1, 126]`, beside
`max_speed` and `braking_factor` where the rest of a loco's driving character
already lives. A shunter's line speed is not a Britannia's, and a loco's
lowest reliably-moving step is a property of its decoder and mechanism.

Both nullable, and **null refuses rather than defaults**:

| Missing | Consequence |
|---|---|
| `direction` on the reservation | Automation never departs the train. The route is a pure interlocking, exactly as a `manual`-authority one is. |
| `auto_speed_step` | Automation never departs the train. **There is no fraction-of-`max_speed` fallback** — `max_speed` is advisory and unenforced everywhere else (B2), so deriving a speed anything actually moves at from it would be building on sand. |
| `crawl_speed_step` | No crawl phase, therefore no berthing (A2's degradation): the run targets the destination block's entry boundary and stops there. |

This is the same posture `blocks.length_mm` takes: an unconfigured value
refuses the automated action rather than being guessed at, and the live layout
is byte-identical the instant after the migration because nothing back-fills
any of the three.

No CHECK constraints, following DD9's call on `sensors.in_service` and B9's on
`blocks.length_mm` — a CHECK on an existing SQLite table forces a rebuild of a
table on a database deployed to a live layout. The Zod write schemas enforce
the ranges on every write path.

## A8 — The berthing crawl outlives the reservation, deliberately

A route completes the moment its destination block reads `occupied` (D5,
`docs/route-locking.md`) — which happens as the train's *front* enters, long
before it reaches a beam at the far end. So the reservation is `released`, and
its locks with it, while the train is still crawling.

Three ways out of that were considered; the third is taken.

- **Change `evaluateOccupancyChange` so a berthing route completes on the beam
  instead.** Rejected: it makes the reservation engine's completion rule depend
  on sensor configuration, and D5 is a rule about track, not about instruments.
- **Stop short of the destination and let the operator berth.** That is A2's
  degradation, not its intent — it gives up the thing #7 was asked for.
- **Let automation's own run outlive the reservation.** Taken.

An `AutomationRun` is keyed **by loco address**, not by route id, and carries
the berth sensor id and the phase. When the reservation releases, the crawl
continues against the run.

**That is not the authority hole it first looks like.** The train is crawling
inside a block it *occupies*, and an occupied block refuses every route that
would be planned through it — occupancy, not the lock, is what protects the
destination. The crawl is bounded at both ends: by the beam, and by A10's
timeout. And the run is torn down by everything that should tear it down — a
manual throttle command, an emergency stop, a Safe-Stop, the loco stopping.

The honest residue, recorded rather than closed: for the length of the crawl,
a train is moving under automation with no reservation naming it. Nothing can
be granted into its block, but nothing names it either.

## A9 — A berthed run's overrun expectation is the track *beyond* the route

B5 arms an overrun expectation at run start: the blocks at or beyond
`targetIndex`, and any of them reading `occupied` latches an `overrun` fault
and Safe-Stops. For a boundary stop that is exactly right — reaching the
destination block at all means the train went further than it was told.

For a **berthing** run it is exactly wrong: the train is *supposed* to enter
the destination block, and `path.slice(targetIndex)` contains it. Armed
unchanged, a perfect berthing arrival would Safe-Stop the layout the moment it
succeeded.

So a berthing run arms a different expectation:
`buildBerthExpectation(reservation, graph)` — every block the graph joins to the
destination block, **less the one the train arrived from**. That is "the track
beyond the end of the route", and a train reaching it has left its authority.

This is the check A1 said was missing, and it is worth being precise about what
it buys: before #7 nothing at all fired when a train ran out past its
destination, because no route held the block it ran into. Now something does.

**A terminal destination has no blocks beyond it, so the expectation is
empty** — a train that overruns the buffers at the end of the goods shed is
detected by nothing, because there is nothing past the buffers to detect it
with. Recorded as a limit, not solved: the answer to it is a beam, or a buffer
stop, not code.

## A10 — Faults are `BrakingFault`s, with two new kinds

No fifth latched collection. `SystemHealth.brakingFaults` is already keyed per
loco, latched, unarmed, and sitting in the right priority slot (B10) — between
point faults and route faults, on the cause-before-symptom rule. Everything
#7 can fault on is "this loco's automated stop did not go as promised", which
is what that collection means. `BrakingFaultKind` gains two members:

- **`unable-to-stop`** — the sweep reached the point where a stop was required
  and `planStopAtRouteBoundary` refused it: insufficient distance, unmeasured
  track, or a point that has not confirmed. The train is moving, under
  automation, with no plan that stops it inside its authority. The loco is
  stopped outright — not ramped, there is by definition no room to ramp — and
  the fault Safe-Stops the layout.
- **`berth-not-confirmed`** — the crawl ran for `CRAWL_TIMEOUT_MS` without the
  berth beam breaking. The loco is stopped and the fault latched.

Adding kinds rather than a collection also keeps the operator surface honest:
these appear in the same list, are acknowledged the same way, and hold
Safe-Stop by the same rule. An operator does not need to learn a second fault
vocabulary to find out their train did not stop where it should have.

**`unable-to-stop` should be unreachable in normal running**, and that is the
point of arming it. A6's margin exists so the trigger fires while the plan is
still grantable; if this fault ever latches, either a constant is wrong or the
world moved faster than `MAX_CREDIBLE_SPEED_MM_PER_S` says it can. Both are
things an operator must be told about rather than have smoothed over.

## A11 — `CRAWL_TIMEOUT_MS` is a safety net, and is honest about being a wall clock

The crawl is the one place #7 needs a timeout, and it is the one place B7's
objection to timeouts does not bite. B7 deferred temporal divergence detection
because comparing a sensor's arrival against a *prediction* needs a velocity
curve — a second calibration axis, 126 timed samples per loco, real work not to
be half-built. This is not that. It is a bound on a phase that should end in a
few seconds and whose only job is to stop a train that is crawling towards a
beam that is never going to break.

`CRAWL_TIMEOUT_MS = 120_000`, deliberately generous. A crawl can legitimately
have to cover most of a block (A5), at a speed step chosen to be the slowest
the loco reliably moves at, and a timeout that fires on a *working* berthing
run would be worse than none — it would train the operator to ignore it.

What it catches is a beam that has died, a train that has stalled on dirty
rail, and a crawl speed step set below what the loco actually moves at. All
three need a human, and all three otherwise leave a train sitting under power
indefinitely.

It is a wall-clock number and there is no distance behind it. That is stated
here rather than dressed up: the honest version of this bound needs the
velocity model B7 deferred, and until that exists this is a backstop, not a
measurement.

## A12 — Authority: D6 stands, unchanged

`docs/route-locking.md` D6 already says what happens when an operator takes a
train automation is driving: **a manual throttle command for a loco holding an
`auto`-authority route cancels that route.** Two authorities on one loco is
worse than a lost route.

#7 changes none of it, and adds exactly one line to the existing path: cancelling
the route also tears down the `AutomationRun`, so a crawl in progress does not
outlive the operator's decision to take over. The existing
`abortBrakingRun(..., { clearExpectation: true })` call already handles the
ramp.

`manual`-authority routes are untouched: automation neither drives nor guards
them. That is deliberate and it is the narrower reading of the issue's "respect
control authority" — a protective brake is still a command, and a route whose
whole meaning is "the operator is driving this reserved road" is not one to
send commands into. An operator who wants automation's guarantees asks for an
`auto` route.

`canIssueAutoCommand` is unchanged, and so is the meaning of `hybrid`:
`docs/gpt-review.md` §4's open question about hybrid mode is **not** settled
here. `auto` and `hybrid` both permit automated commands, which is all #7
needs; what distinguishes them is still undefined, and inventing a distinction
to fill a gap in a review document would be worse than leaving it recorded.

## A13 — Safe-Stop, and the sweep's own posture

The sweep **never** enters Safe-Stop directly (P8's rule, restated by B10 and
again here): every fault goes through `raiseBrakingFault` →
`evaluateAndApplySafeStop`.

Its own gating is the strictest in the system, because it is the only thing
here that starts a train rather than stopping one:

- Refuses unless `canIssueAutoCommand(status, mode)` — the same predicate every
  other automated command is gated on.
- Refuses unless the system is `online`, which `canIssueAutoCommand` already
  implies, and which is checked again by `startRouteStop` underneath.
- Acts only on routes that are `active` and `auto`. A `suspended` route is one
  the system has already decided not to trust; automation does not resume it,
  and resuming stays the operator's explicit action (D8).

A Safe-Stop mid-run tears down every `AutomationRun` alongside every braking
run, and for B6's reason: no scheduled callback may re-command a speed step
after `dcc.emergencyStop()` has gone out.

**The sweep does nothing at all when no `active` `auto` route exists**, which
is every layout that has not opted in — including Westgate Hollow until an
operator grants one. It returns before it reads the roster, so an idle layout
pays one map lookup every 250 ms and no database query.

---

## What this does not do

- **Schedule.** One route, one train, one destination, granted by an operator.
  Nothing here decides *where* a train should go, sequences two trains through
  a junction, or plans a timetable. That is a larger feature and is not #7.
- **Re-plan mid-ramp.** B6's rule stands: a schedule runs to completion or is
  aborted outright. The crawl is not a re-plan — it is a phase the schedule was
  planned to end in (A4).
- **Vary line speed en route.** A train departs at `auto_speed_step` and holds
  it until the brake trigger. No approach speed, no speed restriction per
  block, no acceleration ramp on departure.
- **Guard a `manual`-authority route** (A12).
- **Detect temporal divergence** (B7) — still deferred, still for want of a
  velocity model. A11's crawl timeout is a bound on one phase, not the general
  mechanism.
- **Settle what `hybrid` mode means** (A12).
- **Touch the MQTT contract.** Automation commands speeds through the existing
  `setSpeed` path and publishes the existing retained
  `layout/{id}/loco/{address}/state`, exactly as #6's ramp does (B9). No new
  topic and no new payload field.

## Limits recorded rather than closed

- **A train overrunning a terminal destination is detected by nothing** (A9).
  There is no block beyond the buffers to report it.
- **The crawl is open-loop until the beam breaks.** Between the ramp ending and
  the beam, the system knows the train is in the destination block and nothing
  more precise. `CRAWL_TIMEOUT_MS` bounds it in time, not in distance (A11).
- **A destination with no berthing beam gets no berth** (A2) — the train stops
  short of the block and the operator finishes the move. A limit of coverage,
  not of the model, exactly as `docs/sensor-position.md` records for the lead
  term. Fitting a beam fixes it; no code changes.
- **A crawling train has no reservation naming it** (A8) for the part of the
  crawl after the destination block reads occupied. Its block is protected by
  occupancy, but no route holds it.
- **`CRAWL_TIMEOUT_MS` is a wall-clock backstop with no distance behind it**
  (A11).
- **Automation does not know which way the loco faces** and cannot, so a
  reservation with the wrong `direction` will drive a train the wrong way up
  its own reserved road until a block it does not hold reads occupied and D7's
  unexpected-occupancy check cancels it. That check is what catches it; nothing
  earlier can.
