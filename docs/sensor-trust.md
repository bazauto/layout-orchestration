# Sensor trust and liveness (#28)

> **Status: shipped.** The contract amendment, the freshness model, the trust
> sweep and the seven scenario cases all landed together. The **firmware side is
> outstanding**: nothing on the layout re-asserts yet, so on real hardware every
> sensor-backed block reads `unknown` until `bazauto/esp-layout-controller`
> publishes on a 30 s timer. That is the honest state and the correct direction
> to be wrong in — see D12.

A retained message tells you what was last published. It tells you nothing about
whether the publisher is still alive. This document is about the difference, and
about why the two `reading` topics in `docs/mqtt-contract.md` have opposite
retention.

## The problem, in one paragraph

`sensor/{sensorId}/reading` is retained, and the stated reason was restart
recovery: a backend that has just booted learns the layout's occupancy from the
broker's retained copies without waiting for a train to move. But a retained
`"clear"` is replayed on **every** subsequent subscribe, including from a
controller that died a week ago. The backend then believes that block is empty on
the word of a board that is not powered on. Before this change it did exactly
that: `handleSensorReading` consulted the RETAIN flag only inside the
already-faulted branch, and on a healthy sensor a retained `"clear"` fell straight
through to `deriveBlockOccupancy`, whose clause 2 lets a `block_detection` sensor
assert `clear` outright. The dangerous window is precisely start-of-session, when
the operator is deciding whether it is safe to move at all — and since #7,
"deciding whether it is safe to move" is something automation now does unattended.

## The rule the whole design falls out of

> **Telemetry may be retained only where the publisher is contractually obliged to
> re-assert it, and a retained delivery is never trusted on its own.**

Both retention decisions follow from that one sentence, so they stop being two
ad-hoc calls with an apparent inconsistency between them:

- **`sensor/*/reading` — retained.** A block detector observes a *present*
  physical property and can re-assert it every 30 s for the cost of a `millis()`
  comparison. The retained copy is a bootstrap for a value that is about to be
  reconfirmed.
- **`point/*/reading` — not retained** (`docs/point-feedback.md` D1). A point's
  position can change while its controller is offline — hand-thrown during a
  shutdown, power lost mid-travel, a linkage dropped — so there is no
  re-assertion that would mean anything after a gap. A retained point position is
  an archived belief with nothing behind it. Recovery is a live `query` instead.

Write that rule down once and every future retention decision is already made.

---

# Design decisions

### D1 — Liveness comes from mandated re-assertion, not from a Last Will and Testament

LWT was the obvious candidate and loses on every axis that matters.

- **An MQTT client gets exactly one Will.** A controller with eight block
  detectors has one connection and therefore one Will, so an LWT can only ever be
  *controller*-scoped, never sensor-scoped. Using it would need a controller
  identity model that does not exist: a `sensors.controller_id` column, a
  migration against a live layout, a Configure UI field, a `controller/{id}/status`
  topic, and a policy for every sensor whose `controller_id` is still `NULL`
  afterwards.
- **It detects strictly less.** A Will fires when the MQTT *connection* drops. It
  does not fire when the sensor-reading task has crashed while the keepalive
  continues, or when a detector board has lost power behind a controller that is
  still perfectly online. Re-assertion catches all of those, because the re-assert
  is produced by the same code path that produces a real reading.
- **Re-assertion needs no schema change at all.** Freshness is per-sensor, in
  memory, keyed by `sensors.id`, which already exists.

Firmware cost: one `millis()` comparison in `loop()` and a re-publish of a value
already in a variable. Traffic cost: twenty sensors at one message per 30 s is
40 messages a minute, each rewriting a retained value the broker already holds.
Immaterial.

### D2 — Re-asserts are published with `retain: true`, exactly like a change

One code path in the firmware, one in the backend. The retained copy on the broker
is then always the sensor's genuine *last reading* rather than its last *change*,
so a subscriber that connects and dies immediately still saw a real value. There
is no reason to make the firmware distinguish the two cases and every reason not
to ask it to.

### D3 — The RETAIN flag is the discriminator, and it is spec-guaranteed

MQTT 3.1.1 is explicit in both directions:

- **[MQTT-3.3.1-8]** — the server MUST set RETAIN to 1 when a message is sent as
  a result of a **new subscription**.
- **[MQTT-3.3.1-9]** — the server MUST set RETAIN to 0 when a message is sent
  because it matches an **established subscription**, regardless of how the
  publisher set it.

So "arrived because I subscribed" and "arrived because it was just published" are
distinguishable at the wire level with no cooperation from the device.

This half was **already built**, by #25: `MqttMessageHandler` is
`(payload, topic, retained) => void`, `MqttAdapter` reads `packet.retain`, and
`SimulatedMqttAdapter` replays retained values with `true` while fanning live ones
out with `false`. #28 consumes it rather than introducing it.

**Implementation constraint, commented at the `subscribe` call site:** the backend
must never subscribe with the MQTT 5 *Retain As Published* option (`rap: true`) or
a non-default *Retain Handling* option. Either one collapses the distinction and
silently disables this entire mechanism.

### D4 — Freshness is measured on the backend's receipt clock; `updatedAt` stays advisory

The obvious alternative — a staleness threshold on the payload's `updatedAt` —
fails for two independent reasons, recorded so it is not proposed again.

1. **It is self-certified liveness.** The timestamp is supplied by the very device
   whose death is in question. An ESP with a skewed or free-running clock either
   makes every reading look stale (nuisance `unknown`) or makes a dead sensor's
   retained message look fresh forever — the original bug, now with a false air of
   rigour. Under a fail-safe posture, a device's own assertion must never vouch
   for that device's liveness.
2. **On an event-driven topic, silence is normal.** Before D1 a quiet block
   legitimately produced no message for hours, so any `updatedAt` threshold would
   fire constantly. The threshold becomes meaningful only *because* re-assertion
   is mandated — at which point the backend's own receipt clock is a strictly
   better source for the same information, with no clock-sync dependency in the
   firmware.

`updatedAt` therefore stays **optional** in `sensorReadingSchema` (it already was;
the contract's payload table said otherwise and has been corrected) and is
recorded for logs and diagnostics only.

### D5 — Trust is a stored verdict on the observation, not a clock passed to every reader

`isContributingSensor` is the one predicate that decides whether an observation may
be used at all, and it has three consumers: `deriveBlockOccupancy`,
`positionFixFrom` and `berthingBeamIn` (#77). The choice was between making it take
`(now, timeoutMs)` — rippling a clock into `domain/sensorPosition.ts`,
`BrakingService` and `AutomationService` — or storing the answer.

**Stored, on `SensorObservation`, as `trusted`.** Three reasons:

1. It is **symmetric with `faulted`**, which is already exactly this: a latched
   verdict written by `LayoutService`, read clock-free by `isContributingSensor`,
   with the policy for flipping it living in the service. A second mechanism for
   the same shape of fact would be the thing this issue is about.
2. Passing a clock into `BrakingService` would meet #77's *optional and inert*
   `IClock`, forcing a "what if there is no clock" answer in a module where the
   fail-safe direction is not obvious.
3. The verdict becomes **observable**. A boolean on the record is something a log
   line, a test and a future diagnostics surface can all read; a value recomputed
   inside a predicate is not.

The cost is that `trusted` is only as current as the last sweep — see D8, which
bounds it.

### D6 — Two fields, because evidence and verdict are different facts

`SensorObservation` gains both:

- `lastLiveReadingAt: Date | null` — receipt time of the last **live**
  (non-retained) reading. `null` means one has never arrived.
- `trusted: boolean` — the verdict D5 stores.

`lastReadingAt` (which already existed) keeps its meaning: the last reading of
*any* provenance. The three together express the whole state without an enum —
retained-only is `lastReadingAt` set with `lastLiveReadingAt` null; stale is
`lastLiveReadingAt` set and old; fresh is `lastLiveReadingAt` set and recent. An
explicit `provenance: 'none' | 'retained' | 'live'` field was considered and
dropped: it would be derivable from the two timestamps and therefore able to
disagree with them.

### D7 — A retained reading is recorded, contributes nothing, and stamps no rising edge

A retained delivery still calls `recordSensorReading`, so `lastReading` and
`lastReadingAt` move and the value is available to logs and diagnostics. What it
does **not** do is set `lastLiveReadingAt`, so `trusted` stays false and
`isContributingSensor` filters the observation out. The block falls through
`deriveBlockOccupancy`'s clause 3 to `unknown` — no new clause, no change to the
existing three.

It also stamps **no `lastRisingEdgeAt`** (#77 D6). A retained `occupied` is not an
observation of a train arriving now; it is an archived copy of one that arrived at
an unknown time. Crediting braking distance from it is exactly the kind of guess
`docs/sensor-position.md` D6 exists to prevent.

One consequence worth naming, because it looks like a bug: a retained `occupied`
followed by a live `occupied` produces **no rising edge at all**, because the
transition test sees `occupied → occupied`. That is correct. The train was already
standing there before the backend was watching, so the system genuinely does not
know when it arrived, and no fix is better than a fix stamped at the wrong instant.

A retained delivery also **never demotes** a sensor that is already trusted.
Trust is a property of the *device*, not of the connection: a sensor heard from
live two seconds before a broker blip is still fresh two seconds after it, and a
reconnect that flapped every block to `unknown` would be a nuisance degrade — the
kind operators learn to click through. Nothing special is needed for a *long*
outage either, because the sweep runs on its own clock regardless of connection
state, so everything ages out during the outage and the replay on reconnect
restores none of it. Both halves are pinned by case 7 of the scenario test.

### D8 — A sweep timer, not lazy evaluation on read

Freshness expiry has no triggering message — that is the entire point of it.
Evaluating lazily would leave a block that went stale at 02:00 still reported
`clear` to the operator until something unrelated happened to query it, and the
operator UI is push-based over WebSocket, so "something unrelated" may be never.

The sweep recomputes trust for every registered sensor and calls `recomputeBlock`
only for blocks whose trust actually changed, so a quiet layout publishes nothing.
It runs on the injected `IClock`, never a bare `setInterval` — the same seam
`ManualClock` drives for the point-confirmation sweep (`docs/point-feedback.md`
D5) and the automation sweep (`docs/automation.md`).

This is what bounds D5's staleness: `trusted` can lag the truth by at most one
sweep interval (5 s) against a 90 s window.

### D9 — `deriveBlockOccupancy` is extended by one conjunct, and its clauses are untouched

**#28's original plan specified the opposite**, and this is the one place the
shipped work departs from it deliberately. That plan's D5 gave a four-clause
rule in which *any* untrusted sensor poisoned its block to `unknown`. Refused,
for a reason that did not exist when it was written: it predates #34, which
built the derivation that shipped and had already answered the same question for
a **faulted** sensor — it contributes nothing and poisons nothing, because a
`block_detection` sensor is a whole-block monitor entitled to assert the block is
empty on its own.

Making *silence* poison while a device *actively publishing garbage* does not
would be an inconsistency pointing the wrong way. So an untrusted sensor is
ineligible in exactly the way a faulted or out-of-service one is, and the change
is one term in `isContributingSensor`:

```
o.inService && !o.faulted && o.trusted && o.lastReading !== null
```

An untrusted sensor is simply not eligible, exactly as an out-of-service or
faulted one is not, and the existing three ordered clauses then produce the right
answer with no new branch. That matters because clause 2 is load-bearing and
subtle — only a `block_detection` sensor may assert `clear`, which is what makes
an IR `clear` a no-op (#34 D3, re-refused by #77 D8). A flat "occupied wins, any
untrusted poisons, any clear clears" rewrite would have quietly regressed it.

The same one-term change gives #77's two consumers the right behaviour for free,
and both already documented that they wanted it: `positionFixFrom` says "a sensor
the system has stopped trusting for occupancy is not one to trust for position
either", and `berthingBeamIn` says "not one to stop a train against either".

### D10 — Degrade, do not Safe-Stop; and a malformed payload is still a Safe-Stop

A stale sensor degrades **its own blocks** to `unknown`. It does not halt the
layout. `unknown` is already treated as occupied by `isBlockEffectivelyOccupied`,
so no route can be granted over it and a live route holding it is suspended — the
failure is scoped to the track the dead device actually observes, and a layout
that is otherwise fully observed keeps running.

**A malformed payload is different and stays different.** It remains Fail-Safe
Trigger 3 in `docs/mqtt-contract.md`: a system-wide Safe-Stop, on the first
message, with no tolerance (#27, and the 2026-08-07 scope correction on #28 which
removed the original plan's proposal to soften it).

The distinction is not cosmetic:

| | Failure | Response |
|---|---|---|
| #27 | A device **lying** — its output cannot be trusted *now* | Immediate, sharp, system-wide |
| #28 | A device **dying** — its output is *stale* | A freshness window, scoped to its own blocks |

Degrading prevents new routes but does **not** stop a train already moving under
automation. Safe-Stop does. Trading that away for a device actively publishing
garbage is a real reduction in the system's response, and nothing here needs it.

A malformed payload does, however, fail to refresh liveness — it is discarded
before `recordSensorReading` — so a persistently malformed sensor also ages out
under D8 on its own. That is a free consequence, not a substitute.

### D11 — Timings

| | Value | Why |
|---|---|---|
| Firmware re-assert interval | **30 s** | A contract obligation, not an optimisation. Stated in `docs/mqtt-contract.md`. |
| `SENSOR_FRESHNESS_TIMEOUT_MS` | **90 s** | 3 × the interval. Tolerates two consecutive lost messages before degrading — enough that ordinary WiFi packet loss does not flap a block to `unknown`, short enough that a genuinely dead sensor is caught inside two minutes. |
| `SENSOR_TRUST_SWEEP_MS` | **5 s** | Matches the heartbeat cadence but on its own timer. Do **not** fold the sweep into `startHeartbeat` — that would make the heartbeat interval load-bearing for a safety deadline. |

Boundary, stated so it is not re-litigated in review: an age strictly greater than
the timeout is stale; **exactly equal is fresh**.

Lowering the timeout below twice the firmware interval will flap blocks to
`unknown` on ordinary packet loss. `.env.example` says so at the setting.

### D12 — Until the firmware re-asserts, every sensor-backed block reads `unknown`

Stated plainly because it is a visible behaviour change on the live layout and
will look like a regression.

It is not one. It is the honest state: today nothing in the system can tell a live
detector from a dead one, so every `clear` it has ever believed has been believed
on no evidence. Manual driving is unaffected (`canIssueManualCommand` does not
consult occupancy); what is refused is route granting and automation over track
nothing is currently observing, which is the correct direction to be wrong in.

The fix is ten lines of firmware, batched with #9 and #50 into one flash-and-test
cycle. `USE_SIMULATOR=true` sees no change at all — nothing generates sensor
traffic there, so those blocks read `unknown` before and after.

### D13 — No schema change, no migration

Stated explicitly because D1's rejected LWT design would have needed one. Trust is
in-memory per-sensor runtime state keyed by the existing `sensors.id`, rebuilt from
nothing on every start — which is precisely what liveness is. Nothing here touches
`schema.ts`, so nothing here can go wrong on a live layout that cannot be reset.

### D14 — Closed by #76: observations are now on the WebSocket snapshot

At the time #28 landed, DD10 (`docs/sensor-fault-recovery.md`, since superseded —
see that document's D10) kept per-sensor observations off `STATE_SNAPSHOT`, and #28
deliberately did not change that — it would have pre-empted #76, which owned the
question and had its own volume argument to settle.

That gap is closed. #76 supersedes DD10 and adds `StateSnapshot.sensors` plus a
`SENSOR_STATE` delta, pushed only when a sensor's contributed value moves — so a
healthy sensor re-asserting every 30 s inside this document's own freshness window
pushes nothing, and the volume argument collapses rather than needing measurement.

The ergonomic gap this closes was real: before #76 the operator saw the
*consequence* of staleness (a block turning `unknown`, with its existing yellow
rendering and its `BLOCK_STATE` event) and not the *cause*. "Unknown because nothing
has reported in 90 s" and "unknown because two detectors disagree" are now
distinguishable from the monitor — `SensorObservationView.trusted` carries exactly
that distinction, and only the first of the two is fixed with a screwdriver.

---

## Known gaps

- **No operator "declare block clear" override.** A real need — an operator who
  can see the track is the best sensor in the building — but it is an authority
  question (who may assert it, does it expire, does it survive a restart) that
  belongs with the reservation semantics in `docs/route-locking.md`, not bolted
  onto sensor ingestion.
- ~~**Sensor health has no dedicated surface.**~~ — **closed by #76** (D14):
  `StateSnapshot.sensors` and `SENSOR_STATE` are the surface, on the monitor's
  sensor layer.
- **One global re-assert interval**, not per-sensor. It stays that way until a
  sensor exists that cannot meet it.
- **Nothing on the layout re-asserts yet.** The firmware obligation is written
  into the contract and is unbuilt; see D12 and #9/#50.
