# #7 — Automation engine: running order

Decision record: `docs/automation.md` (A1–A13). This file is the delivery plan
and the record of what differed from it.

Sequencing rationale: #6 shipped the braking mechanism and left the trigger
unbuilt on purpose ("nothing decides *when* to brake" — B12 names
`startRouteStop` as the seam this issue drives). #77 then closed B4's
adjacent-target refusal, which the operator promoted ahead of this issue on
2026-08-16 precisely because that refusal made #7's central move refuse in the
common case.

The operator's call on 2026-08-16 settled the two scope questions the issue text
left open:

- **Automation drives.** Not a guard over an operator-driven train — it departs,
  runs, and stops an `auto`-authority route itself. D6's manual-throttle-cancels
  rule stands unchanged (A12).
- **The stop target is a berthing beam**, not a block boundary: "If the
  destination block has an IR sensor at the end opposite where the train enters,
  that position should be the target. Brake anticipating to stop at it, down to
  crawl and then stop when the IR sensor is triggered. My intent is to place the
  IR sensors at the position where the train would stop alongside whatever is in
  that block like the platform in the goods shed." That is A2, and it is what
  makes A5 — the crawl absorbing B4's conservatism — the load-bearing idea of the
  whole design.

---

## PR A — The model (`feat/7-automation-model`)

**Shipped.**

Everything pure, plus the three columns an operator configures automation with.
**Nothing is wired**: no sweep runs, no train moves, and the live layout is
byte-identical after the migration because nothing back-fills any column.

- `locos` gains `auto_speed_step` and `crawl_speed_step`;
  `route_reservations` gains `direction`. All three nullable, all three
  refusing rather than defaulting (A7). No CHECK constraints, per B9/DD9.
- `domain/sensorPosition.ts#berthingBeamIn` — the berth geometry (A3), both
  anchor directions, nearest-beam-wins, no decay.
- `domain/braking.ts` — `planBrakingSchedule` gains `toSpeedStep` (default `0`,
  so every existing caller is unchanged); `remainingRouteDistanceMm` gains its
  optional `berth` term beside #77's `lead`; `buildBerthExpectation` (A9).
- `domain/automation.ts` — the pure decision layer: `AutomationPhase`,
  `AutomationDecision`, `decideAutomation`, `APPROACH_MARGIN_MM`,
  `AUTOMATION_TICK_MS`, `CRAWL_TIMEOUT_MS`.
- `BrakingFaultKind` gains `unable-to-stop` and `berth-not-confirmed` (A10),
  with `describeBrakingRefusal`'s vocabulary extended to match.
- Unit tests for all of the above.

## PR B — The engine (`feat/7-automation-engine`)

**Shipped.**

`services/AutomationService.ts` — planning and run bookkeeping only, mirroring
`PointConfirmationService`'s posture exactly (no MQTT, no DCC, no timer, never
calls back into `LayoutService`). `LayoutService` drives the sweep against
`IClock.setInterval` and executes what comes back: departure, the brake
trigger, the crawl, the stop on the beam, and the two new faults.

Scenario tests for #7's four stated acceptance cases, rewritten against what
this system can actually express (A1):

- two trains converging on one block — refused at grant, not avoided at runtime;
- a train losing position mid-approach — the block reads `unknown` and the
  existing route-occupancy path Safe-Stops, taking the run with it;
- an operator taking manual control of an automated loco — D6 cancels the route
  and tears down the run (A12);
- an emergency stop during an active automated movement — every run torn down
  before the broadcast (A13/B6).

## PR C — The operator surface (`feat/7-automation-surface`)

`GET .../automation` and an `AUTOMATION_STATE` event; the three new fields in
the Config UI; the automation phase on the monitor. Docs and `CLAUDE.md`.

---

## Shipped, with notes

### PR A

- **`remainingRouteDistanceMm`'s signature took a fourth positional argument
  rather than an options object.** `lead` was already positional (#77 PR B), and
  a mixed convention reads worse than a long signature. Both are optional and
  both default to "contribute nothing", so every existing call is unchanged.
- **`berthingBeamIn` returns the sensor id, not just a distance.** The plan
  originally had it return a number, mirroring `leadDistanceMm`. That is wrong
  here: the beam that sets the stopping distance must be the same beam the crawl
  watches for arrival, and returning only the distance would have let PR B pick a
  different one. Selecting once and carrying the identity is the only version
  that cannot disagree with itself.

### PR B

Everything in this section was **found by wiring the engine up**, not by
designing it. All three are recorded in `docs/automation.md` alongside the
first draft they replaced, because a decision record that only shows the answer
is worth less than one that shows what was wrong with the obvious thing.

- **The distance trigger alone lets a train sail past the point of no return.**
  A route completes the instant its destination reads `occupied`, and
  `remainingRouteDistanceMm` refuses once `confirmedIndex` reaches `targetIndex`
  — so a train can cross one boundary too many and find that nothing can plan
  anything for it, at line speed, with its run quietly retired. A6 gained
  `isLastChanceToPlan`: a one-step look-ahead asking not "is it close" but "will
  I still be able to do this next time I look". The first version of it was
  narrower (a "planning horizon" that only looked at the last block) and broke
  the no-beam case, where available distance from the second-to-last block is
  zero and braking has to begin a block earlier still.
- **Automation refused to depart any loco that had never been commanded**,
  because the first draft copied B6's `unknown-loco-state` refusal. That is
  circular: nothing gives a loco a `LocoState` until something commands it, and
  the one thing an operator could do to establish one — open the throttle —
  cancels the route they are trying to automate (D6). B6's refusal is about
  needing the speed as an *input to a calculation*; a departure *sets* it.
- **Nothing stopped automation starting a journey it could not finish.** A7
  gained `canPlanAStop`, asked once before departure against the line speed. It
  turns two Safe-Stops into config-gap reports: a route over unmeasured track
  (which would otherwise depart and then never brake) and a route to the
  adjacent block with no berthing beam (which would depart and fault
  `unable-to-stop` a quarter of a second later).
- **A run is adopted at most once.** Without that, every teardown is undone
  250 ms later — an emergency stop leaves the route `active` and the mode
  `auto`, so the next sweep would find an unowned route and *depart the train
  again*. `adopted` is pruned to the currently-active set, so a
  suspended-then-resumed route is picked up again, which is the one case where
  re-adoption is wanted.
- **The scenario fixture needs reverse edges.** `berthingBeamIn` resolves its
  anchor through `isAnchorUnambiguous`, which counts edges *from* the beam's own
  block — so a one-directional fixture silently declines every berth. The real
  compiler emits a row per direction, so the fixture was wrong, not the rule.
