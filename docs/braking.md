# Per-Loco Braking Model — Decision Record (#6)

Companion to `docs/pathfinding.md` and `docs/route-locking.md`. Those documents
decided how track is reserved and how the road is set; driving the train along
a granted route — deciding when to slow it and by how much — was explicitly
left to #6/#7. This document is that model's design record: B1–B10.

Same posture as the other decision records — not binding the way
`docs/mqtt-contract.md` is, but it explains *why*, not just *what*, so the next
change doesn't accidentally undo a deliberate choice.

**The model is strictly open-loop dead reckoning.** A commanded DCC speed
step is the only speed knowledge the system has — there is no loco feedback
channel and never will be (see `LocoState.speed`'s doc comment). Block sensor
transitions are the only position ground truth. A stopping distance produced
by this model is an *estimate*, computed once when a braking run starts, and
it is never confirmed against what actually happens. Everything below follows
from taking that limit seriously rather than pretending a closed loop exists.

Read this before touching `domain/braking.ts`, `services/BrakingService.ts`,
or (once PR B lands) `LayoutService`'s braking-run and overrun-check methods.

---

## B1 — What `brakingFactor` means dimensionally

The `locos.braking_factor` column is `real notNull default 0.5` and had no
defined meaning anywhere before this. `ILayoutRepository.LocoRecord` documents
only "1.0 = stops immediately; lower values = longer braking". The seed data
has a Class 08 at 0.7 and a Britannia at 0.4.

**Choice:** dimensionless *braking effectiveness* on `[0, 1]`, scaling a
layout-wide reference distance:

```
d(s) = REFERENCE_STOPPING_DISTANCE_MM * (1 - brakingFactor) * (s / maxSpeed)^2
REFERENCE_STOPPING_DISTANCE_MM = 1000
floored at MIN_STOPPING_DISTANCE_MM = 50 for any s > 0
```

**Why:** it is the only reading consistent with the meaning already recorded
in `ILayoutRepository.ts` and with the seed data, so no existing row becomes
wrong under it. It needs exactly one number an operator can obtain with a
ruler — no rate, no curve, no calibration rig. The relationship is quadratic
in normalised speed because that is what both constant deceleration
(`d = v²/2a`) and a fixed-rate speed ramp give — see B3, whose ramp shape this
constant does not otherwise touch.

The floor exists because `brakingFactor = 1.0` is representable and would
otherwise assert a train stops in zero distance, which is false for any real
loco. Rounding the distance *up* at the extreme is the fail-safe direction.

Worked examples at full speed: `brakingFactor 0.5` → 500 mm; `0.7` → 300 mm;
`0.4` → 600 mm. Plausible figures for OO gauge.

## B2 — The seam a measured curve replaces

Callers depend on a **function type**, not the scalar formula directly:

```ts
export type StoppingDistanceModel = (
  profile: BrakingProfile,
  query: StoppingDistanceQuery,
) => StoppingDistanceEstimate;
```

`scalarStoppingDistance` (B1's formula) is one value of that type.
`BrakingService` takes the model as an injected, defaulted constructor
argument, never hard-codes it. A per-loco measured curve — sampled distance
against commanded speed step, once that data exists — is a second value of
the same type and touches no caller.

The query carries `direction` even though the scalar model ignores it —
forward and reverse stopping distances genuinely differ for a real loco
(pulling versus propelling), and having the field in the signature now is
what lets a future curve vary by it without a signature change later.

The field is named **`commandedSpeedStep`**, never `speedStep` — see B7 for
why that name matters.

**Refusals, not clamps.** A query with `commandedSpeedStep > maxSpeed` is
refused (`speed-exceeds-max`), not silently clamped to `maxSpeed`.
`maxSpeed` is advisory and unenforced everywhere else in the system, so a
commanded speed above it means the roster configuration is wrong — and a
clamped answer would be an *under*-estimate of the stopping distance, which is
the unsafe direction to be wrong in.

## B3 — The profile is a pure schedule; a service executes it

`domain/braking.ts#planBrakingSchedule` is pure: it takes a starting speed and
returns a `BrakingSchedule` — an array of `{ atOffsetMs, speedStep, direction }`
steps, offsets relative to the first step, always ending at
`{ speedStep: 0, direction: 'stop' }`. It calls no clock and starts no timer.
`LayoutService` (PR B) is what executes the schedule against an injected
`IClock`, issuing each step's `setSpeed` command as its offset elapses.

**Shape: linear step-down.** `BRAKING_STEP_DECREMENT = 8` DCC speed steps per
`BRAKING_TICK_MS = 250` ms tick. From speed step 126 that is 16 commands over
3.75 s. Two shapes were rejected:

- **An abrupt single stop.** That already exists — it is `stopLoco` — and
  commanding it as a "braking run" achieves nothing but the exact overrun risk
  this feature exists to avoid.
- **Exponential decay.** Asymptotic, so it needs an arbitrary cutoff anyway,
  and integer DCC speed steps make the tail a long series of 1-step crawls
  that add ramp time without adding predictability.

**The ramp shape is loco-independent.** `brakingFactor` predicts *distance*;
it does not shape *how* the ramp is commanded. Commanding a steeper ramp than
a decoder's momentum CV allows achieves nothing — the decoder's own
acceleration/deceleration curve is what actually governs how the loco
responds to a speed step change, and the system has no visibility into it.
The one lever the system genuinely has is *when to start braking*, which is
what B4/B5 are about. This is also what makes calibration (B8) meaningful at
all: the ramp is a fixed, reproducible stimulus, so a measured distance means
the same thing run to run.

## B4 — Worst-case distance; unmeasured track refuses outright

Occupancy is block-level, not sub-block: a train confirmed in block *c* may be
anywhere within it. So available distance is measured conservatively, from
the **exit end of the confirmed block** — the sum of `lengthMm` over the
route's edges from `confirmedIndex + 1` up to `targetIndex`. Blocks
themselves carry no length; edges carry all distance, so there is no
double-counting, and the train is credited with none of the confirmed block's
own length even though part of it is very likely still ahead.

**Any edge in that stretch with `lengthMm === null` refuses outright**
(`unmeasured-track`), naming the edge. `schema.ts` and `docs/topology.md`
already describe a NULL `lengthMm` as "unsafe for automated braking"; this is
what keeps that promise rather than merely repeating it in a comment.

**`DEFAULT_EDGE_LENGTH_MM` (the pathfinder's 1000 mm guess, P2 in
`docs/pathfinding.md`) must NOT be reused here.** Guessing a *cost* to steer a
search toward a reasonable answer is fine — the worst outcome is a
sub-optimal route. Guessing a *stopping distance* is not a sub-optimal
answer, it is a collision if the guess is short.

**Target semantics.** `targetIndex` names the path step whose **entry
boundary** the train is asked to stop at; the default target is the
destination step, so a braked run halts *just short of* its destination
block, not inside it. Recorded limit: an automated route therefore does not
berth *inside* its destination block — reaching a specific spot within a
block needs a second, slower "creep" move, which is #7's territory, not this
one's.

## B5 — Margin, and the overrun check

The distance estimate is **never confirmed** — restated from the top of this
document because it is the reason a margin exists at all, not a decoration on
top of the model:

```
requiredMm = max(estimate * (1 + BRAKING_SAFETY_MARGIN),
                 estimate + BRAKING_SAFETY_FLOOR_MM)
BRAKING_SAFETY_MARGIN = 0.25    BRAKING_SAFETY_FLOOR_MM = 100
```

The absolute floor exists because a purely proportional margin vanishes
towards zero at low commanded speed — exactly the regime where the estimate
is least trustworthy in the first place (stiction, dirty rail, a decoder's
own minimum-speed behaviour).

A braking run **arms an overrun expectation** the moment it starts: the set of
block ids at or beyond `targetIndex` on the route. If any of those blocks
reads `occupied` while the expectation is armed, that latches a `BrakingFault`
of kind `overrun` and Safe-Stops the system.

**Without this check, a train that overruns straight into its destination
block reads as a successful arrival** through `evaluateOccupancyChange`'s
`complete` branch (`docs/route-locking.md` D5) — the reservation engine has no
way to distinguish "arrived as planned" from "overran the stopping point and
happened to end up in the next reserved block". That is the hole this check
closes, and it is why an overrun is a latched fault, not a rounding error to
shrug off.

The expectation is a **snapshot taken at run start**, not a live query
against the reservation. That means the overrun check needs no reservation
lookup at the moment it fires and cannot race the release path in
`recomputeBlock` — by the time a block at or beyond the target is read
`occupied`, the run that armed the expectation is either still in flight or
has already finished, and either way the snapshot is what was promised when
braking began.

## B6 — Fail-safe behaviour

| Condition | Behaviour |
|---|---|
| No `LocoState` (never commanded, or a restart lost it) | **Refuse** (`unknown-loco-state`). Do not assume speed 0 — D9 (`docs/route-locking.md`) exists precisely because a backend restart does not stop trains. |
| `LocoState.speed === 0` | Refuse (`already-stopped`). |
| Any remaining edge unmeasured | Refuse (`unmeasured-track`). |
| `requiredMm > availableMm` | Refuse (`insufficient-distance`, reporting both figures). A refusal, **not** a fault — nothing has moved yet. |
| System not `online` | Refuse. A ramp's *first* command is a non-zero speed step; starting one while Safe-Stopped would be a ghost movement. |
| `manual`-authority route, or a system mode that is not auto-capable | Refuse (`manual-authority` / `auto-not-permitted`). |
| `setSpeed` rejected on step 0 | Latch a `BrakingFault` (Safe-Stop) **and** return `started: false`. The train is still moving at its pre-braking speed and is now uncommandable — that is the hazard, not merely a failed API call. |
| `setSpeed` rejected mid-ramp | Abort the run, latch a `BrakingFault`, Safe-Stop — the existing machinery broadcasts `emergencyStop()` and suspends every route with locks retained (D8). Deliberately **not** the `point-command-rejected` posture of cancel-and-release: a moving train the system cannot command is the last thing you release track underneath. |
| Emergency stop / Safe-Stop mid-ramp | Abort **every** in-flight run *before* calling `dcc.emergencyStop()`, so no pending timer re-commands a non-zero speed step after the emergency stop has gone out. |
| Manual throttle for a loco with a run in flight | Abort the run, clear its overrun expectation; the operator's command stands. Manual wins (D6, `docs/route-locking.md`). |
| Route cancelled mid-ramp | Abort every run associated with that route. |

## B7 — Open-loop is structural in the vocabulary

The field is `commandedSpeedStep`, never `speedStep`, everywhere this model's
types appear. `BrakingProfile` carries no observed-state field at all. There
is deliberately no "read the loco's actual speed" seam anywhere for a future
change to be tempted into using — the vocabulary itself is the safeguard, not
just a code comment. `LocoState.speed`'s doc comment is amended to read
**"Commanded, never confirmed — there is no loco feedback channel
(docs/braking.md B7)."**

**Divergence detection is deferred, on purpose.** The one signal the system
does have — a sensor transition arriving earlier or later than predicted —
needs a predicted arrival *time* to compare against, and that needs velocity
per speed step: a second calibration axis this PR does not open. A stopping
*distance* is one number an operator gets with a ruler; a velocity *curve*
needs a ruler, a stopwatch, and on the order of 126 timed samples. That is
real future work, not something to half-build here.

*Spatial* divergence, in contrast, is already caught by two existing
mechanisms and needs nothing new: `evaluateOccupancyChange`'s
`unexpected-occupancy` (D7) catches a train showing up somewhere the route
did not expect it, and B5's overrun check catches it showing up too far along
the route it did expect. Temporal divergence — the same train, on the same
track, but arriving at the wrong *time* — is what #7 is for.

**Forward reference (#25, point position confirmation).** When a confirmed
point-position feedback channel exists, `planStopAtRouteBoundary` gains one
new precondition: refuse if any point hold on the remaining path is not
*confirmed* at its required position. A point that did not actually throw
means the train is taking a different road than the plan assumes, and every
distance this model computes is measured along track it may not be on. Do not
attempt to build for this now — there is nothing to confirm against yet.

## B8 — Calibration is a documented procedure, not automation

The Config UI already has a `brakingFactor` field; an automated on-layout
calibration run is explicitly **deferred**, not attempted here. What this PR
ships is the standard ramp itself (B3) as an operator-facing trigger, because
the calibration procedure needs a fixed, reproducible stimulus to measure
against:

`POST /api/layouts/:layoutId/locos/:address/brake` — an unconstrained
standard stop from the loco's current commanded speed (`availableDistanceMm:
null`, B4's "no route context" case), returning the computed schedule and its
predicted stopping distance. It issues the same ramp `planStopAtRouteBoundary`
would, with no destination and no overrun expectation, because there is no
route to have one against.

**Procedure:**

1. Run the loco at a known, marked speed step onto straight, measured track.
2. Call the endpoint above (or trigger it from the Config UI) at that speed.
3. Measure the actual stopped distance with a ruler.
4. Invert the B1 formula for `brakingFactor`:

```
brakingFactor = 1 - (measured_mm / (REFERENCE_STOPPING_DISTANCE_MM * (s / maxSpeed)^2))
```

Run this three times and take the **longest** of the three measured
distances (the worst case, matching B4's posture throughout this model), then
round the resulting `brakingFactor` **down** — under-crediting a loco's
braking ability is the fail-safe direction, over-crediting it is not.

## B9 — No MQTT contract change, no schema change

The braking ramp publishes exactly the existing
`layout/{id}/loco/{address}/state` topic per step — already retained, already
published by `publishLocoState`. No new topic, no new payload field (mirrors
D12 in `docs/route-locking.md`).

`schema.ts` is untouched: `locos.braking_factor` already exists as
`real notNull default 0.5` and this PR only gives that column a defined
meaning (B1), not a new shape. No schema edit means **no migration** — per
CLAUDE.md's rule, a migration only follows an edit to `schema.ts`, and there
is none here. If a measured per-speed-step curve is ever built (B2's second
`StoppingDistanceModel`), that is a new `loco_braking_samples` table when it
lands, not a change to this column.

## B10 — Braking faults are keyed per loco in `SystemHealth`

The third instance of the sensor-fault/route-fault pattern
(`docs/sensor-fault-recovery.md` D2, `docs/pathfinding.md` P8):
`SystemHealth.brakingFaults: Record<LocoAddress, BrakingFault>`. Latched,
acknowledged individually, with **no arming threshold** — a loco cannot prove
itself the way a sensor can by publishing valid readings (P8's argument
carries over unchanged: the loco whose fault this is has already been
Safe-Stopped, so nothing it does next is evidence of anything).

Priority in `evaluateSystemSafeStop` (PR B) becomes: MQTT, DCC, topology,
sensor faults, **braking faults**, route faults, recovered routes. Braking
sits *above* route faults deliberately: an overrun is very often the *cause*
of a route's `unexpected-occupancy` symptom, so naming the braking fault
first points the operator at the thing to actually investigate. It sits
*below* sensor faults because a bad detector explains a bogus overrun report,
and the sensor is the more actionable thing to fix first.

Per P8's rule, restated because it applies again here: **every Safe-Stop goes
through `SystemHealth`.** No braking code path calls `enterSafeStop` directly.

---

## What this does not do

- **The automation loop** (#7). This PR is a model plus an explicitly-invoked
  execution surface — nothing decides *when* to start braking on its own, and
  nothing does continuous position tracking, approach detection, or
  re-planning mid-ramp. A braking run has to be asked for.
- **Continuous position tracking.** The only ground truth is block-level
  sensor transitions, exactly as everywhere else in this system.
- **Re-planning mid-ramp.** A schedule, once started, runs to completion or is
  aborted outright (B6) — it is never recomputed against new information
  while in flight.
- **Berthing inside the destination block** (B4).
- **A velocity model or temporal divergence detection** (B7) — deferred until
  a second calibration axis is worth opening.
- **Any schema or MQTT contract change** (B9).

## Limits recorded rather than closed

- **The estimate is never confirmed.** There is no loco feedback channel and
  none is planned; every distance this model produces is a prediction, not a
  measurement, for as long as that remains true.
- **`REFERENCE_STOPPING_DISTANCE_MM = 1000` is a guess until Westgate Hollow
  is actually measured.** It is shipped as a named, exported constant for
  exactly that reason. The correct response to it turning out to be wrong is
  to re-measure each loco's `brakingFactor` (which absorbs the error, per
  B1's formula), **not** to tune the constant per layout — the same posture
  `docs/pathfinding.md` records for `DEFAULT_EDGE_LENGTH_MM`.
- **A route cancelled mid-ramp leaves the train at whatever speed the ramp
  had reached**, not necessarily stopped. Accepted for this PR:
  `cancelRoute` already stops the loco outright for auto-authority routes
  (D6, `docs/route-locking.md`), so the train does not simply coast
  indefinitely — but the specific speed it is left at when a braking run is
  aborted this way is not guaranteed to be zero.
- **The overrun check sees only block-granularity evidence.** It can tell you
  the train reached a block it should not have; it cannot tell you by how
  far, or whether it merely nosed over the boundary.
- **#25's point-position confirmation is a forward reference, not a
  dependency.** B7 records the precondition it will add; nothing here is
  built in anticipation of it.
- **"Halts within tolerance" cannot be verified without a physical
  odometer.** The scenario test that lands with PR B proves the *modelled*
  distance fits within the reserved track and exercises the command trace and
  every failure path — it deliberately does not attempt a fake physics
  simulator, because its constants would be chosen to match this model and it
  would therefore prove nothing about the real layout. Real validation is
  B8's on-layout procedure.
- **Moving `LayoutService`'s heartbeat `setInterval` onto `IClock`** is
  out of scope here as unrelated churn — `IClock` exists for this model's
  ramp timers, not as a blanket replacement for every timer in the service.
