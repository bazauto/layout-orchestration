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

`services/AutomationService.ts` — planning only, returning decisions, mirroring
`PointConfirmationService`'s posture exactly (no MQTT, no DCC, no timer, never
calls back into `LayoutService`). `LayoutService` drives the sweep against
`IClock.setInterval` and executes what comes back: departure, the brake
trigger, the crawl, the stop on the beam, and the two new faults.

Scenario tests for #7's four stated acceptance cases, rewritten against what
this system can actually express (A1):

- two trains converging on one block — refused at grant, not avoided at runtime;
- a train losing position mid-approach — the lead term decays, the train brakes
  *earlier*, and an `unknown` block Safe-Stops;
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
