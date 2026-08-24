# Point Position Feedback — Decision Record

This document records the design behind point position confirmation (#25): the
`point/{pointId}/reading` / `point/{pointId}/query` amendment to
`docs/mqtt-contract.md`, the `PointConfirmation` / `PointFault` vocabulary this
introduces to `domain/types.ts`, the confirmation state machine
(`domain/pointConfirmation.ts`), `points.position_feedback`, and the
`SystemHealth.pointFaults` latch it feeds.

Same posture as `docs/topology.md`, `docs/route-locking.md`, and
`docs/sensor-fault-recovery.md` — not binding the way `docs/mqtt-contract.md`
is, but it explains *why*, not just *what*, so the next change doesn't
accidentally undo a deliberate choice.

## The situation this closes

`docs/route-locking.md` D11 named the gap plainly: a point lock guarantees
"no other authority will command this point," never that the point is
physically in the required position. `IDccController.setPoint` resolves on
send; there was no channel by which a controller could report back what it
actually did. A servo stall, a disconnected wire, a mechanical bind, or a dead
controller was — before this — indistinguishable from a point that threw
correctly. This decision record closes that gap for any point the operator
configures as requiring it; D11 in `docs/route-locking.md` is updated to point
here rather than restate it (that update lands with PR B, see below).

## Status

| | |
|---|---|
| Contract amendment (`docs/mqtt-contract.md`) | **Shipped** — `b2b6641` |
| PR A — the channel | **Shipped** 2026-08-15 |
| PR B — route interaction (D8) | **Shipped** 2026-08-15 |
| Controller liveness (D11, D12 — #167) | **Shipped** 2026-08-24 |
| Feedback node (`bazauto/layout-feedback#15`) | Designed, unblocked by D11 — `docs/point-position-feedback.md` there |

Nothing on the live layout has feedback hardware fitted, so every point on
Westgate Hollow is `positionFeedback: 'none'` and behaves exactly as it did
before PR A. The feature is opt-in per point, from the Configure screen's
Points tab.

## Scope: two PRs

**PR A — the channel.** The contract amendment, `positionFeedback` config,
the `PointState` re-shape, ingestion, the confirmation timeout, latched
`SystemHealth.pointFaults` with acknowledge, the simulator twin, and UI. PR A
is safe on its own: a latched `PointFault` enters system Safe-Stop, and
Safe-Stop already suspends every active route with locks retained
(`docs/route-locking.md` D8) via `ReservationService.suspendAll`.

**PR B — route interaction.** Naming *which* route a failed point invalidated
(a new `RouteFaultKind`), the resume precondition, and tightening #4's
acceptance criterion back to "a point that fails to confirm invalidates the
route," qualified to points configured `positionFeedback: 'required'`. D8
below is PR B's decision; everything else here is PR A.

---

## D1 — `point/{pointId}/reading` inbound, `point/{pointId}/query` outbound, neither retained

The backend's existing direction rule stays mechanically checkable in one
sentence: it **publishes** `*/command`, `*/state`, `*/query`, and
**subscribes** only to `*/reading`. Reusing `sensor/{sensorId}/reading`'s verb
for the point controller's report keeps that rule stateable without a special
case.

**Retention is the load-bearing choice, and the asymmetry with
`sensor/*/reading` is deliberate, not an oversight.** `sensor/*/reading` is
retained because occupancy is continuously re-asserted by a live sensor and
self-corrects on the next train movement — a stale retained sensor reading is
quickly overwritten by reality. **A point's position is re-asserted by
nothing.** It can change while its controller is offline entirely: hand-thrown
during a shutdown, power lost mid-travel, a linkage dropped by someone leaning
on it. A retained point reading is therefore a confident assertion with no
correction path, and believing a stale one is the direct mechanism of a
wrong-route movement — the exact failure this feature exists to prevent.
`point/*/reading` and `point/*/query` are both **NOT retained**. This argument
is carried into `docs/mqtt-contract.md`'s retention blockquote verbatim,
because #28 (the sensor-side liveness question) cites it as precedent.

`query` exists because the retention decision would otherwise leave every
instrumented point `unknown` after every restart until an operator manually
throws it. A query recovers position **live**, from the device, rather than
from a broker cache — which is the only kind of recovery consistent with D1's
retention argument. The backend must remain correct if nothing ever answers a
query: answering is a quality-of-service obligation on the firmware, not a
correctness one the backend depends on (see D6).

A `reading` arriving with the MQTT `retain` flag set (a firmware bug — the
contract says retain false) is **dropped with a structured warn**. It confirms
nothing and arms nothing towards a fault clearing. It is deliberately not
faulted on its own: the point then simply times out on its own schedule, which
is self-announcing and correct without a special case for this one malformed
condition.

## D2 — Startup belief: every point `unreported`, position `unknown`

Nothing about confirmation persists across a restart. A database row asserting
a point's last-known position is a retained message with better durability,
and it recreates exactly the staleness hazard D1 rejects for the MQTT layer —
persisting it would just move the same mistake one layer down. **On startup
every point is `unreported`, `confirmedPosition: 'unknown'`,
`commandedPosition: null`.** For a `positionFeedback: 'none'` point this is
byte-for-byte today's behaviour, so the live layout does not regress. A
`query` is published for every `'required'` point at the end of the backend's
`start()`, and again on every MQTT reconnect — the same two moments a
retained-cache alternative would have relied on a broker replay for.

## D3 — `commanded` and `confirmed` are separate fields; `position` is removed

The single `PointState.position` field the pre-#25 code carried meant two
different things depending on context — "what we told it to be" and "what it
is" — and that conflation is the defect this issue exists to remove. It is
replaced with two fields plus a status:

- `commandedPosition: 'normal' | 'reverse' | null` — the last position the
  backend commanded this session. `null` means never commanded. **Not a
  confirmation of anything physical.**
- `confirmedPosition: 'normal' | 'reverse' | 'unknown'` — the last position
  the controller reported. `'unknown'` until a reading lands, and again after
  a confirmation timeout.
- `confirmation` — one of `'unreported'`, `'pending'`, `'confirmed'`,
  `'mismatch'`, `'indeterminate'`, `'timed-out'`.

`mismatch` is kept deliberately distinct from `timed-out`: on a mismatch the
position is *known and wrong*, which is more actionable than silence, and the
reported value is authoritative — `confirmedPosition` reflects what actually
came back, not the commanded position.

**A `driver`-sourced reading on a `'required'` point yields `indeterminate`,
never `confirmed`.** This is the entire purpose of the `source` field (see
below): a controller that drove the servo and has no independent sensor is
reporting a delivery acknowledgement, not a position confirmation, and the
operator configured this specific point as needing the latter. Accepting a
`driver` reading as `confirmed` on a `'required'` point would let a firmware
author who reports `"sensor"` out of optimism — or who never wired the
feedback switch at all — silently defeat the whole feature. On a
`positionFeedback: 'none'` point, by contrast, a `driver` reading IS accepted
as `confirmed`: nothing stronger was ever claimed for that point in the first
place.

Nothing outside this repository subscribes to `point/*/state`, so the field
rename is a clean break rather than a versioned one — reflected as the
"Breaking change" callout in `docs/mqtt-contract.md`.

## D4 — Point faults are latched in `SystemHealth`, keyed by point, and every kind Safe-Stops

Faults reuse #34's shape exactly: `SystemHealth.pointFaults: Record<PointId,
PointFault>`, required rather than optional-defaulting-to-`{}`, one latched
fault per point so acknowledging a fault the operator can see never silently
clears one they were never told about. Fault kinds: `timeout`, `mismatch`,
`indeterminate`, `malformed-payload`, `id-mismatch`. On a re-fault of the same
point, first cause wins — only the confirmation counter resets — via the same
generic oldest-fault-wins helper #34 introduced.

**All five kinds Safe-Stop the whole system, including a fault on a point no
route currently holds.** An earlier version of this design (recorded, then
rejected, in the original issue thread) argued that a hand-thrown siding point
with no route on it should not halt the layout — but `positionFeedback` is
opt-in per point specifically to give that argument somewhere better to live:
if a point's feedback is unreliable, or the operator does not care about
confirming it, flipping it to `'none'` clears any latched fault immediately —
the same escape hatch `sensors.in_service` provides. Given that hatch, a
two-tier "some point faults Safe-Stop, some don't" model buys nothing and
costs a `SystemHealth` collection whose entries would not all mean the same
thing. The safety argument for treating every fault the same is structural,
not about any one route: a point whose position is unknown makes every edge
gated on it untraversable, not merely the edges a route happens to be using
right now — the pathfinder for the *next* route would silently avoid it, but a
manually-driven train has no such protection.

**Priority slot:** MQTT, DCC, topology, sensor faults, **point faults**, route
faults, recovered routes. Above route faults on cause-before-symptom — a point
that failed to confirm is *why* a route gets suspended, not a peer fact. Below
sensor faults because a sensor fault is the more systemic failure (an entire
class of block-detection evidence going untrustworthy, versus one point).

**Arming and acknowledge, one rule, no per-kind branching.** The confirmation
counter increments on a reading that is well-formed, non-retained, and
confirms the point at its `commandedPosition` — or, if the point was never
commanded this session, is a `sensor`-sourced reading that is not
`'unknown'`. Anything else resets the counter to zero. The threshold,
`pointFaultClearAfterConfirmations`, defaults to **1**, deliberately lower
than #34's sensor default of 3: a sensor publishes continuously, so demanding
three good readings costs nothing, but a point publishes only on change or
query, and demanding three confirmations would demand three physical throws
just to arm an acknowledge. The real gate here is the human acknowledge, not
the counter — a point that faulted may have thrown late, under a train.

## D5 — Confirmation timeout is 8000 ms, evaluated as a pure predicate over a 250 ms sweep on an injected clock

Westgate Hollow's point motors are Cobalt/Tortoise-style slow-action stall
motors (roughly 1–3 s of physical travel) and servos (1–2 s); solenoids, where
fitted, are under 100 ms. 8 seconds is roughly 3× the worst-case physical
travel time plus MQTT round trip and firmware debounce — long enough that a
genuine throw is never mistaken for a fault, short enough that it is still far
inside "an operator would have noticed something was wrong" territory. If one
specific motor genuinely needs longer, the extension point is a nullable
`points.confirm_timeout_ms` column, not raising the global default — a longer
global timeout is added latency on a safety-relevant state transition, paid by
every point on the layout for the sake of one slow one.

A per-command `setTimeout` cannot be exercised by the scenario-test harness
(real timers are forbidden there), and a pure lazy predicate alone is wrong in
the other direction — nothing would *emit* the transition on its own, so no
operator would ever learn a timeout had occurred until they happened to look.
Both are needed: `evaluateTimeout(point, now, policy)` is a pure function that
answers "has this point timed out" without side effects; a 250 ms sweep
(driven by an injected `IClock`, never a bare `setInterval`) applies it and
publishes the result. Worst-case 250 ms of detection lateness against an 8 s
deadline does not matter to anyone.

The sweep timer itself lives in `LayoutService`, not in the confirmation
sub-service — the same rule `ReservationService` already follows: a
sub-service returns pure outcomes, `LayoutService` performs the I/O
(publishing, Safe-Stop) and owns the timer, and the sub-service never calls
back into anything.

## D6 — A **command** starts the confirmation deadline; a **query** does not

If a `query` armed the same deadline as a `command`, then simply fitting
feedback to an already-thrown point and restarting the backend while its
controller happened to be powered off would Safe-Stop the layout at boot,
before an operator had done anything at all. Instead, an unanswered `query`
leaves the point at `unreported`: position `unknown`, every edge gated on it
untraversable, but **no fault, no Safe-Stop**.

The organizing principle: **unknown-at-startup is the same safe default the
system already uses for block occupancy; a fault means something the backend
*commanded* did not happen as promised.** A block reading `unknown` at boot
does not Safe-Stop the system either — it merely refuses to be used until it
resolves. Point position at boot is symmetric with that.

## D7 — `effectivePosition` is the single place that decides what is trusted

```ts
// domain/pointConfirmation.ts
export function effectivePosition(p: PointState): PointPosition;
export function buildPointPositionMap(
  points: ReadonlyMap<PointId, PointState>
): Map<PointId, PointPosition>;
```

- `positionFeedback === 'required'` → trust `confirmedPosition`, full stop.
  Nothing about `commandedPosition` may substitute for it.
- `positionFeedback === 'none'` → `confirmedPosition` if it is not
  `'unknown'`, otherwise fall back to `commandedPosition ?? 'unknown'` — the
  same trust model the system used before this feature existed for every
  point, preserved exactly for a point the operator has not opted in.

This function is consumed by the UI and by any road-confirmation check —
**not** by the pathfinder. `domain/graph.ts` is unchanged, and `findPath`
continues to deliberately ignore point *positions* when searching
(`docs/pathfinding.md` P3): setting the road is what granting a route means,
so the search must not treat an unthrown point as a reason a path doesn't
exist. Do not "fix" that as part of this feature.

## D8 — Route interaction (PR B, shipped)

`requestRoute` continues to return `granted: true` immediately as it does
today, the route goes `active`, and any `'required'` point it holds goes
`pending`. Blocking the HTTP response for up to 8 seconds while a point
confirms would be unacceptable, and an operator must be able to cancel a
route while a confirmation is still outstanding. Confirmation is therefore
asynchronous to granting; its consequences arrive later, through the fault
path below.

When a held point transitions to `timeout`, `mismatch`, or `indeterminate`
while an `active` or `suspended` reservation holds it:

- **Suspend the route, never cancel it.** Releasing its locks would make the
  track look free while a train may still be standing on it — the same
  reasoning `docs/route-locking.md` D8 already applies to a Safe-Stop.
- **Stop that route's loco unconditionally** — not conditionally on
  `authority === 'auto'` — matching `handleRouteOccupancyUnknown`'s existing
  behaviour for an unknown-occupancy route fault. This costs a manually
  driven route one throttle nudge from the operator to resume; that is a
  cheap price for not moving a train past a point whose position is no longer
  known.
- **Latch both a `PointFault` and a `RouteFault`** of a new kind,
  `'point-not-confirmed'` (suspend semantics, matching `'occupancy-unknown'`).
  Two separate acknowledgements is deliberate, not redundant: "this point
  motor is dead" and "route R's road is no longer known to be set" are
  different facts an operator may resolve at different times, by different
  actions (fix the point vs. re-verify and resume the route).

**Resume precondition.** `LayoutService.resumeRoute` refuses, before ever
calling `reservations.resume`, if any point the route holds carries a
latched, unacknowledged `PointFault`. The check is against the *fault*, not
against `confirmation === 'pending'` — checking the transient `pending` state
would deadlock, because resuming a route re-commands every held point and
thereby makes each of them `pending` again as an unavoidable side effect of
the resume itself. This lives in `LayoutService`, never in
`ReservationService`, because `ReservationService` has no `SystemHealth`
access and must not gain any (the same boundary `docs/route-locking.md`
already draws around it).

## D9 — The simulator is a fake ESP, not a fake DCC callback

`SimulatedDccAdapter` has no MQTT connection of its own; bolting a
confirmation callback directly onto it would invent a second, private
confirmation channel that is not the one in the contract, and testing against
it would prove nothing about the real firmware path.
`SimulatedPointController` instead subscribes to `point/+/query` on the
`IMqttAdapter` port and publishes `point/{id}/reading` after a delay on the
injected `IClock` — a genuine simulated twin of the ESP, exercising the real
contract end to end, the same posture every other adapter in this system
takes. It ships in the simulator binary whenever either simulator mode is
active, because `USE_SIMULATOR=true` being a first-class mode (CLAUDE.md
safety rule 5) means point feedback must be testable without hardware too.

Because the backend commands points over DCC EX serial, and has never
published `point/*/command` over MQTT (see the asymmetry section below), the
simulator needs an in-process hook, `noteCommanded(pointId, position)`, wired
directly from `index.ts` rather than learning of commands over MQTT. Actually
publishing point commands over MQTT would be a real behaviour change on a
live layout, and is explicitly out of scope here — see below.

Failure modes the simulator must support, because the required scenario tests
depend on being able to select each one, globally or per point:
`mode: 'confirm' | 'silent' | 'wrong-position' | 'indeterminate' |
'driver-only'` — `silent` models a stalled servo or dead controller
(exercises the timeout path), `wrong-position` models a mechanical bind or
crossed wiring (exercises `mismatch`), `indeterminate` models both
microswitches reading open at once, and `driver-only` models feedback fitted
in name only — a controller wired with no independent sensor that always
reports `source: "driver"`.

## D10 — Schema: one plain column, no CHECK, nothing about confirmation persisted

`points.position_feedback TEXT NOT NULL DEFAULT 'none'`, added as a plain
`ALTER TABLE ADD COLUMN`. **Deliberately no CHECK constraint**, following
#34's recorded deviation for `sensors.in_service`: a CHECK added to an
*existing* SQLite table forces drizzle-kit to emit a table-rebuild migration
rather than a plain column add, on a database that is deployed to a live
layout and cannot be reset. The payoff — guarding a column `parsePointRow`
already validates on every read — does not justify that risk. The half that
IS worth having, and lands with this column, is the full-row Zod validation
`points` currently lacks (`parsePointRow`, modelled exactly on
`parseSensorRow`/`parseBlockEdgeRow`).

`dcc_address` reaches the same conclusion by the same route (#152,
`docs/dcc-link.md` D16): the accessory-address bound `[1, 2044]` sits on
`pointRowSchema` and both write schemas, and not in a CHECK constraint. That
is `parsePointRow` earning the deviation twice — a row schema that carries
every bound a CHECK would is what makes "no CHECK on this table" a position
rather than a gap.

Default `'none'` means every point on the live layout behaves identically,
the instant after the migration runs, to how it behaved the instant before —
no point silently starts demanding confirmation it was never configured to
require.

**Nothing about a confirmation — `confirmedPosition`, `confirmation`,
`lastReadingAt`, `lastReadingSource`, any of it — is written to the
database.** Only the operator's *configuration* choice (`positionFeedback`)
persists; the live confirmation state is rebuilt from scratch, to
`unreported` / `unknown`, every time the process starts (D2). This is the
same conclusion `docs/route-locking.md` D9 reached for reservations, reasoned
from a different angle: a database is exactly a retained message with better
durability, and persisting a point's last-known position would recreate the
identical staleness hazard D1 rejects for MQTT retention. The two decisions
have to agree, because they are the same argument at two different layers.

---

## D11 — A point controller must re-assert every 30 s; silence degrades the point, and only that point

**#167, decided 2026-08-24.** Chosen from four candidate shapes: periodic
re-assert (this one), a periodic backend query, a controller-level heartbeat,
and accepting the gap knowingly.

Before this, nothing anywhere checked that a point controller was still alive.
Three decisions, each correct on its own, composed into the hole: a
`point/*/reading` is not retained (D1), it had no periodic re-assert, and the
confirmation deadline arms on a **command** and deliberately not on a **query**
(D6). So no clock anywhere expected to hear from a point controller again, and a
controller that died quietly left its last `confirmedPosition` standing
indefinitely while the layout went on setting roads over it.

The contract now requires a `positionFeedback: 'required'` point's controller to
re-publish its observed position at least every **30 s**, matching
`sensor/*/reading` exactly. A point from which no reading arrives inside
`POINT_FRESHNESS_TIMEOUT_MS` (default 90 s = 3 × the interval, the same tolerance
and the same reasoning as `DEFAULT_SENSOR_FRESHNESS_TIMEOUT_MS`) degrades to
`confirmation: 'stale'`, `confirmedPosition: 'unknown'`.

**Why the re-assert and not the periodic query.** The query shape keeps the
controller dumb and the policy in one place, which is genuinely attractive — but
it would have had to make an *unanswered* query into evidence, and D6 exists
precisely to stop a query meaning anything. Reworking what a query means, on the
one path that recovers position at boot, to gain a liveness check that a timer in
the publish loop already provides, is a poor trade. A controller-level heartbeat
is cheaper on the wire again and proves less: that the node is running, not that
any particular point's sensing path is intact. Six points at one message per 30 s
is not a traffic problem worth designing around.

**Why this is sharper here than on the sensor side.** Command and feedback are
two unrelated devices on two transports. The Cobalt iP motors are commanded over
DCC accessory addresses and have no feedback mechanism of their own; position is
read from their `S2` changeover contacts by a separate MQTT node. There is no
shared component whose failure shows up in both, so a DCC accessory command —
fire and forget — keeps succeeding long after the feedback node has stopped. The
usual reassurance that silence after a command is at least *suspicious* does not
apply, because the commanded device is not the reporting device.

**Staleness is a degrade, not a fault.** It latches no `PointFault` and does not
Safe-Stop, which puts it on the opposite side of the line from every kind in D4.
That is #28 D10's split applied unchanged: a malformed payload is a device
**lying** — immediate, sharp, system-wide; an unrefreshed reading is a device
**dying** — a freshness window and a scoped degrade. It is also D6's organising
principle read forward: a fault means something the backend *commanded* did not
happen as promised, and nothing commanded a controller to keep talking.

**Three narrowings, each load-bearing:**

- **Only `positionFeedback: 'required'`.** A `'none'` point has nothing reporting
  on it and would otherwise go stale immediately and permanently. All six points
  on Westgate Hollow are `'none'` today, so this decision changes live behaviour
  by exactly nothing until feedback hardware is fitted and a point is opted in —
  the same rollout property D10's `DEFAULT 'none'` was chosen for.
- **Only from `confirmed`.** That is the one state in which a reading is actually
  being *trusted*. `unreported` must stay `unreported` or a `'required'` point
  whose controller was powered off at boot would degrade into a different-looking
  state for no new reason (D6's boot case). `pending` is owned by the 8 s
  confirmation deadline, which fires an order of magnitude sooner. `mismatch`,
  `indeterminate` and `timed-out` are already latched faults and already
  untrusted; re-labelling one of them `stale` would replace a sharp fact with a
  vaguer one.
- **`stale` is a seventh `PointConfirmation`, not a reuse of `unreported`.**
  "Never heard from" and "heard, then went quiet" are different facts about the
  hardware and lead an operator to different places — the first is ordinary at
  boot, the second means a node died. Collapsing them would throw away the only
  evidence that distinguishes them.

## D12 — A stale point suspends the routes holding it, but latches no point fault, and resume is the test

A stale point does two things, and the split matters.

**To itself:** `confirmedPosition` goes `'unknown'`, so `effectivePosition` (D7)
returns `'unknown'` for a `'required'` point, every edge through it is
untraversable, and no new route can be set over it. No fault is latched.

**To routes already holding it:** each `active`/`suspended` reservation holding
that point gets its loco stopped and a `RouteFault` of the existing kind
`'point-not-confirmed'`. This is the same shape D8 gives a `timeout`/`mismatch`/
`indeterminate`, minus the `PointFault` — and it is exactly the precedent the
sensor side already sets. `runSensorTrustSweep` degrades a stale sensor's blocks
and touches no fault, and the route-level consequence arrives through
`recomputeBlock`'s existing `occupancy-unknown` path: loco stopped, `RouteFault`
latched, no `SensorFault`. A stale point is the same event on the other channel,
and answering it differently would be an inconsistency with no argument behind
it.

**The resume precondition needs no special case, because resume tests the
staleness.** D8's precondition refuses a resume while any held point carries a
latched, unacknowledged `PointFault` — and a stale point has none, so a resume
proceeds. That is correct rather than a hole: `LayoutService.resumeRoute`
re-commands every point the route holds, which puts each `'required'` one back to
`pending` and arms the 8 s deadline. A controller that has recovered answers and
the point confirms; a controller that is genuinely dead does not, the point times
out, a `PointFault` latches, and the route re-suspends. The operator's resume is
therefore a live probe of the thing that was in doubt, and it resolves in 8 s
rather than in a freshness window.

Adding a staleness clause to the precondition would have blocked that probe and
left the operator holding a route that could not be resumed until a device that
may already be healthy happened to speak again.

---

## The commanded-over-serial / confirmed-over-MQTT asymmetry

This is worth stating as its own fact because it is easy to assume symmetry
where none exists: **the backend commands a point over DCC EX serial and
learns whether that command was confirmed over MQTT.** These are two
different transports, carrying two different halves of the same physical
action, and there is no plan to unify them. Publishing `point/*/command` over
MQTT — which would let the ESP controller be the thing that actually drives
the motor, rather than DCC EX hardware — is contract-legal today (the topic
already exists) but has never been implemented, and turning it on is a real
behaviour change on a live layout that deserves its own issue, not a side
effect of adding feedback. That is exactly why the simulator needs the
in-process `noteCommanded` hook (D9) instead of learning commands over MQTT
the way a real ESP controller eventually might: the simulator has to stand in
for a controller that receives its commands over a wire the simulator cannot
see.

---

## Open questions

1. **May an automated route be granted over a `positionFeedback: 'none'`
   point? — decided: yes** (2026-08-15, with PR A). `planReservation` is
   untouched and gains no new rejection: `positionFeedback` decides *what a
   confirmation means*, never *whether a route may be granted*. Refusing would
   have made automation impossible until every point on the layout carries a
   sensor, which is a standard nobody set and the live layout does not meet.
   The reduced guarantee is not hidden behind that: it is stated per point
   where an operator reads position — the Layout panel's "no feedback" marker
   and the monitor's point key — because the honest statement of this
   feature's guarantee has always been per point, not per system. The
   consequence to keep in view when #6 and #7 start driving trains: an
   automated route over a `'none'` point is running on commanded position,
   exactly as every route did before this feature existed.
2. **Firmware `pointId` ↔ hardware mapping.** The firmware must publish this
   repository's `points.id` (a UUID) on `point/{pointId}/reading`. A
   compile-time lookup table in the firmware is acceptable for now;
   provisioning that mapping over MQTT or HTTP is a separate design question,
   to be raised in the firmware repository (`bazauto/esp-layout-controller`),
   not here.
3. **#28's sensor-side mirror — settled, in both directions.** This document
   wrote the retention asymmetry (D1) into `docs/mqtt-contract.md`, which was
   #28's minimum requirement; #28 then answered its own half with the 30 s
   re-assert and `isSensorFresh`. The *point*-side equivalent was never posed at
   the time, because the only point controller then contemplated was one that
   would also command the motors — the case where silence after a command is at
   least suspicious. `bazauto/layout-feedback#15` made it a separate device on a
   separate transport, and #167 answered it in D11/D12 above.

## Deferred, and stated so nobody has to ask

- **Publishing `point/*/command` over MQTT** — contract-legal, never
  implemented; see the asymmetry section above.
- **Persisting confirmed position** — rejected outright in D2/D10, not merely
  deferred.
- **Per-point `points.confirm_timeout_ms`** — additive and cheap to add
  later; not needed until a specific motor demonstrates it needs longer than
  8 s (D5).
- **A `fault` diagnostic field on the `reading` payload** — optional and
  backward-compatible to add later; `position: "unknown"` plus the timeout
  already carries everything safety-relevant.
- **Loco position/movement feedback of any kind.** There is none today and
  none is planned; this document is about point position only.
- Repo-wide clock injection beyond what this feature needs (`layoutState.ts`'s
  remaining bare `new Date()` calls, the heartbeat `setInterval`) — out of
  scope for #25.
- Frontend unit tests — tracked separately as #8, not reopened here.
