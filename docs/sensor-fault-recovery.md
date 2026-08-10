# Sensor-Fault Recovery — Decision Record

This document records the design behind operator recovery from a sensor-payload
Safe-Stop (#34), and the per-sensor occupancy model it requires:
`SystemHealth.sensorFaults` in `domain/safety.ts`, the occupancy derivation in
`domain/occupancy.ts`, the `sensors.in_service` column, and
`LayoutService.handleSensorReading` / `acknowledgeSensorFault`.

Same posture as `docs/topology.md` and `docs/route-locking.md` — not binding the
way `docs/mqtt-contract.md` is, but it explains *why*, not just *what*, so the
next change doesn't accidentally undo a deliberate choice.

## The situation this closes

#27 made a malformed sensor payload a Safe-Stop trigger, per
`docs/mqtt-contract.md` §Fail-Safe Triggers item 3 and CLAUDE.md safety rule 3,
and deliberately **latched** it: an unrelated health re-evaluation (an MQTT
reconnect, say) must not quietly clear it, because nothing about a reconnect
tells you the sensor started publishing valid payloads again.

Latching is correct. The gap was what came after it — clearing the latch
required restarting the backend process, which is both a blunt instrument and,
once #3's persistence lands, an expensive one (every reservation revives as
`suspended` under its own latch). This is the decision that gives the fault a
way back that does not involve a process restart, **without** letting the
system resume on the word of a device that is still publishing garbage.

## D1 — Two recovery paths: valid readings *arm* an acknowledge; out-of-service is the path for a dead device

Neither half alone is right. "A valid reading arrived" is far too weak on its
own — the contract's whole premise is that a device publishing malformed
payloads is a device whose output cannot be trusted, and one good message
proves nothing. But a bare acknowledge with no evidence at all is just as
weak: it lets an operator wave the layout back into service while the sensor
is still spraying garbage, which defeats #27 outright.

So the two are composed, not offered as alternatives:

1. **Return to service.** After the fault, the sensor must publish
   `clearAfterValidReadings` **consecutive** valid readings. That does not
   clear the fault — it *arms* it, making the fault acknowledgeable. The
   operator then explicitly acknowledges (D5). Both are required: the device
   demonstrates it is healthy, and a human decides the layout may move again.
2. **Out of service.** The operator marks the sensor out of service. This
   needs no valid readings at all, which is the point — a sensor whose wiring
   has failed will never publish anything again, and the layout must not be
   held hostage to a device that is simply dead. Marking it out of service
   clears its fault *because the system stops trusting the sensor entirely*
   (D3), not because the sensor was vindicated.

Rules on the counter, each of which is a way to get this wrong:

- **Consecutive.** Any malformed payload resets the count to zero. A sensor
  alternating good and bad messages is a faulty sensor, and a non-resetting
  counter would eventually arm on one.
- **Retained messages do not count.** `sensor/{sensorId}/reading` is a
  retained topic (`docs/mqtt-contract.md` §Topic Reference), so a broker
  reconnect replays the last reading — one free, stale, valid-looking message
  toward the threshold, arriving precisely when the system knows least about
  the layout. See D8 for the port change this requires. Overlaps #28.
- **Post-fault only.** The counter starts at the fault, is per sensor, and is
  in-memory. A restart already clears the fault by re-initialising
  `SystemHealth`, so there is nothing to persist.
- `clearAfterValidReadings` is layout-wide config
  (`SENSOR_FAULT_CLEAR_READINGS`, default 3), not per sensor. A per-sensor
  override is a plausible later refinement and deliberately deferred — there
  is no evidence yet that different sensors on this layout want different
  thresholds, and the column is cheap to add when there is.
- **Out-of-service is checked before validation, not after (Q1).** A sensor
  marked out of service is dropped in `handleSensorReading` *before* its
  payload ever reaches `sensorReadingSchema` — not merely excluded from
  arming. The alternative (still Zod-validating an out-of-service sensor's
  payload, and letting a malformed one trip a fresh fault) would mean a
  sensor the operator has explicitly told the system to stop trusting can
  still hold the whole layout in Safe-Stop, which contradicts D3 outright
  and makes the escape hatch this decision exists to provide unusable. The
  primary mechanism is `LayoutService` never subscribing to an out-of-service
  sensor's topic at all; the in-service check inside `handleSensorReading`
  is defence in depth for a handler that somehow still fires.

## D2 — The fault is per sensor

`SystemHealth.sensorFault: boolean` / `sensorFaultReason: string | null` become
a keyed collection: `sensorFaults: Record<SensorId, SensorFault>`, where a
`SensorFault` carries the reason, the topic, the timestamp, and the current
consecutive-valid count. `evaluateSystemSafeStop` trips while the collection is
non-empty, and reports the oldest fault's reason (the first cause, which is the
one worth investigating), keeping its existing priority order: MQTT, then DCC,
then topology, then sensor faults.

A scalar cannot express the real situation. Nothing stops a second sensor
faulting while the first is unacknowledged, and with a scalar the second fault
overwrites the first's reason — so acknowledging what the operator can see
clears a fault they were never told about. Per-sensor state means acknowledging
sensor A leaves sensor B's fault latched, and the system stays in Safe-Stop
until every fault is individually resolved. That is the only shape that makes
"acknowledge" mean something specific.

Since #54, `tripSensorFault`'s reason text (`LayoutService.ts`) names the
sensor — `Malformed sensor payload from sensor "Platform Detector"
(3c1dab82) on topic "..."` — instead of the bare sensor id, rendered through
the `NameBook` `LayoutService` now owns. See `docs/naming.md` (D1–D10) before
touching that reason string or any other `describe*`/error-message call site.

## D3 — Occupancy is derived from in-service sensors, and block detection outranks IR

This is the change that makes per-sensor recovery *useful* rather than merely
precise, and it is implementable today with no new hardware.

`sensors.type` already distinguishes `block_detection` (a current-sensing
detector monitoring the whole block) from `ir_position` (a beam at one specific
spot). Those two are not interchangeable evidence, and the current code treats
them as if they were: `handleSensorReading` calls
`updateBlockOccupancy(blockId, state)` for **any** sensor carrying a `blockId`,
regardless of type, last write wins. So today an IR sensor reporting `clear`
clears the entire block — asserting the whole block is empty on the evidence of
one beam being unbroken, which is exactly the "guess a train's position" that
safety rule 1 forbids. Fixing that is not scope creep here; it is the same code
path and the same decision.

Block occupancy therefore becomes **derived** state, computed from the set of
that block's sensors that are both in service and not faulted:

- A `block_detection` sensor's reading governs the block outright, `occupied`
  or `clear`. It is a whole-block monitor; that is what it is for.
- An `ir_position` sensor may only ever raise occupancy, never lower it.
  `occupied` from IR means occupied. `clear` from IR means **nothing about the
  block** and is discarded for occupancy purposes.
- If no in-service, non-faulted sensor can determine the block, it reads
  `unknown`.

This requires tracking each sensor's latest contribution per block rather than
folding readings straight into block state, which is a real change to
`stateManager` — but it is the only way to answer "is this block still
trustworthy with sensor X out?" at all.

The degraded-operation cases fall straight out, and they are what was actually
asked for:

- **IR faults, block detector in service** → block occupancy is unaffected.
  Genuine continued operation.
- **Block detector faults, IR in service** → block reads `unknown`. IR cannot
  assert the block is clear, so there is nothing to fall back to. Honest, and
  it is the answer safety rule 1 requires.

## D4 — On fault, the block reads `unknown` and `locoAddress` is nulled

A faulted sensor stops contributing to its block immediately (D3). Its last
reading is **not** retained as a going belief — occupancy state that has
silently stopped updating is indistinguishable from track that is genuinely
clear, which is the reasoning #27 already recorded in
`handleSensorReading`'s comment. In practice, for a block whose only detector
has faulted, this means `unknown`.

`BlockState.locoAddress` is nulled on the same path: identity is unknown unless
it can be guaranteed, and a block whose occupancy is no longer trustworthy
cannot vouch for what is standing in it. Nothing is lost by this — today
`handleSensorReading` never sets `locoAddress` at all, and once #3/#4 land the
`RouteReservation` carries its own `locoAddress`, so the operator's assertion
(`docs/route-locking.md` D13) survives on the route aggregate where it belongs.

## D5 — Acknowledge is `operator`; out of service is `admin`

Both are real roles in the code (`requireAdmin` in
`transport/http/auth/`, `operator` may read and drive). On this layout the
distinction is not two different people — it is an elevation that exists to
stop an accidental config change. That framing settles it cleanly:

- **Acknowledge a fault** — `POST /api/layouts/:layoutId/sensors/:id/acknowledge-fault`,
  `operator`. Transient, driving-adjacent, refused unless the fault is armed
  (D1), and the refusal names how many valid readings are still outstanding.
  It is the exact opposite of `POST /api/emergency-stop`'s deliberate lack of
  auth, so it is authenticated like everything else.
- **Mark a sensor out of service** — the existing
  `PUT /api/layouts/:layoutId/sensors/:id`, which already carries
  `requireAdmin`. No new endpoint: out-of-service is a persistent change to
  what the system trusts, which is config, and config writes are already
  admin-only. It is authored from the Configure screen's Sensors tab alongside
  the sensor's other fields.

Returning a sensor to service is the same admin PUT, and it does not
resurrect the old fault — a sensor coming back into service starts with no
fault and no reading, so its block reads `unknown` until it actually publishes
something. That is the correct starting position, not a regression.

**Deleting a sensor clears its fault too (Q2).** `LayoutService.deleteSensorConfig`
unregisters the observation, unsubscribes, and drops any latched fault before
recomputing the block and re-evaluating Safe-Stop. Any other answer leaves a
latch that can never be acknowledged, because the sensor it names no longer
exists — the exact restart-only-recovery bug #34 exists to close, reopened by
a different door.

## D6 — No change to `docs/route-locking.md` D8, and out-of-service does not unblock reserved movement

D8 holds unchanged when the Safe-Stop being cleared is a sensor fault: on
Safe-Stop every `active` reservation goes `suspended` with locks retained, and
clearing the Safe-Stop does **nothing** to routes — the operator cancels or
resumes each one explicitly, and resume re-checks every precondition. A sensor
fault arriving while routes are already suspended does not re-suspend or
double-latch them.

What the sensor case adds is an ordering the operator will meet in practice,
and it must be written down because "acknowledge" invites being read as "back
in service":

- Acknowledging a sensor fault clears the system latch. It does not make the
  block readable. D8's resume refuses on any `unknown`, so a route through that
  block cannot resume until real readings return. **Sensor recovery and route
  recovery are two separate operator steps, in that order, and the second can
  still fail after the first succeeds.**
- Out of service is the sharp edge. `isBlockEffectivelyOccupied` treats
  `unknown` as occupied, so a block with no in-service sensor able to determine
  it reads `unknown` indefinitely — no route can be granted over it, and no
  route can be resumed through it, for as long as that is true. So marking a
  sensor out of service buys manual driving anywhere and automated routes
  anywhere **except through that block**. That is the feature limitation, and
  it is a consequence of fail-safe, not a bug to be worked around later.

**A second interaction with `docs/route-locking.md`, this one load-bearing rather
than merely sequential:** D3's derivation is not only the *reporting* layer's
concern — `LayoutService.recomputeBlock` is also the ONLY call site left for
`ReservationService.onOccupancyChange`, and it feeds that call the DERIVED
occupancy, never a raw per-sensor reading. Before this decision,
`handleSensorReading` passed straight through whatever a single sensor just
reported, so an `ir_position` sensor's `clear` reached the reservation engine
as if it were the block's occupancy — and route-locking.md D5's progressive
release fires on exactly that kind of `clear` transition. One unbroken IR
beam could therefore release a block's hold, and un-reserve track, while a
train already confirmed further up the route was still standing in it. Routing
`onOccupancyChange` through the derived value closes that: D3 already
discards an IR `clear` before `recomputeBlock` ever calls in, so it can never
fire progressive release or an unexpected-occupancy violation. A fault-driven
transition to `unknown` needs no equivalent guard — `evaluateOccupancyChange`
only ever acts on `occupied`, or on `clear` arriving from a previous `occupied`,
so `unknown` is simply inert to it and is passed through faithfully rather
than filtered out. See the cross-reference this note is answered by in
`docs/route-locking.md` D5.

## D7 — Identity is out of scope, and stays out until RFID is designed

Vehicle identity is deliberately absent from this decision beyond D4's "null
it". Deducing a loco's identity from the preceding block as occupancy moves
forward is genuinely wanted, but it cannot be built on what exists:
`sensor/{sensorId}/reading` carries only `{ state, updatedAt }` with **no
identity field whatsoever**, and `sensors.type` has no identity-bearing member.
There is no ID-based occupancy sensor in the system to fall back from.

RFID readers at key locations are the intended source and are their own
feature: contract-first (`docs/mqtt-contract.md` amended before any code), then
firmware in `bazauto/esp-layout-controller` batching with #9/#25 into one
flash-and-test cycle. It also carries a modelling question this document should
not pre-empt — tags on unpowered rolling stock have no DCC address, so
`BlockState.locoAddress` is the wrong shape to hold what a reader observes; that
is a vehicle-identity concept, not a loco address. Deduction from a preceding
block additionally needs confirmed position and direction of travel, which
arrive with #4/#7.

Recorded so the sequencing is unambiguous: **#34 does not depend on RFID, and
RFID does not reopen #34.**

## D8 — No MQTT contract change; one port change

`docs/mqtt-contract.md` is untouched. Nothing here needs a new topic, a new
payload field, or a retention change — every mechanism is backend-side state
over readings the contract already defines, which is what makes this
implementable ahead of any firmware work.

One port change is required, and it is not optional. `MqttMessageHandler` is
`(payload: unknown, topic: string) => void`, so the **retain flag is not
surfaced to the subscriber** and D1's "retained messages do not count" cannot
be honoured. The handler signature gains the message's retained flag (mqtt.js
already provides it as `packet.retain`), implemented in both `MqttAdapter` and
`SimulatedMqttAdapter` so the simulator can exercise the reconnect-replay case
without a broker.

## D9 — An empty payload is a retained-clear, not a malformed reading (#65)

`sensor/{sensorId}/reading` is retained (§Topic Reference,
`docs/mqtt-contract.md`), and #65's sensor simulation panel needs a way to
tidy up after itself — a fabricated reading for a detector that is not wired
yet must not replay into the backend on every restart, forever (see
`docs/sensor-simulation.md` D6). The only thing MQTT accepts as "forget this"
is a zero-length retained publish to the same topic.

Before this decision that zero-length message would have been treated as any
other payload: `JSON.parse('')` throws, `MqttAdapter` forwards the raw empty
string for the subscriber to validate (`MqttAdapter.ts:96-111`, deliberate —
see the comment there), `sensorReadingSchema.safeParse('')` fails, and
`tripSensorFault` would Safe-Stop the layout. So tidying up after a bench test
would have halted the layout every time — a rule this document already
distinguishes from a genuine defect (D1's "device publishing malformed
payloads cannot be trusted"): an empty message is not a malformed *assertion*
about occupancy, it is the absence of one. Ignoring it leaves derived
occupancy exactly where the last real reading left it, which is the correct
behaviour — halting because someone cleared a retained flag is a nuisance,
not a safety win.

**Where.** `LayoutService.handleSensorReading` gains step 2b, between the
existing step 2 (the in-service check) and step 3 (the Zod parse):

- **After the in-service check.** D1/Q1's ordering — an out-of-service
  sensor's payload is dropped before anything else looks at it — applies
  here too. An empty payload from a sensor nobody trusts is still a drop,
  logged as the in-service drop, not the 2b drop, so an operator reading the
  log sees why the message was actually ignored.
- **Before the Zod parse.** That is the entire fix: today `''` reaches Zod
  and fails it. Step 2b intercepts first.
- **What "empty" means.** `domain/sensorPayload.ts#isEmptySensorPayload` —
  strict equality to a zero-length string. `null`, `{}`, and a
  whitespace-only body are all still malformed and still fault; only a
  genuinely empty string qualifies. See the function's own doc comment for
  why each of those must NOT be swallowed here.
- **Effect.** Logged `info` (not `warn` — an expected, benign event, not a
  degradation), naming layoutId/layoutName, sensorId/sensorName,
  blockId/blockName and topic, then return. No fault, no counter change, no
  `recomputeBlock` call. Derived occupancy is untouched.

**A *retained* empty payload cannot arrive in practice.** A real broker never
stores a zero-length message as a retained value — publishing one is what
*clears* the broker's retained store, not what populates it — and
`SimulatedMqttAdapter.clearRetained` (see `docs/sensor-simulation.md` R1)
deletes from its `retained` map rather than storing `''` there. So step 2b
has no `retained` branch to speak of, and none should be added speculatively.

## Deferred, and stated so nobody has to ask

- **Per-sensor `clearAfterValidReadings` override** — layout-wide config only
  (D1).
- **Sensor liveness / staleness** — a sensor that goes *silent* rather than
  malformed is not a fault under this decision, and `Occupancy`'s doc comment
  already mentions a "sensor timeout" that nothing implements. That is device
  liveness, which #25 (point position feedback) shares; decide the two
  together.
- **Fault history** — faults are in-memory and are lost on restart. No audit
  trail of what faulted when. Worth having eventually; not needed to make
  recovery possible.
- **Automatic out-of-service** — nothing marks a sensor out of service on the
  system's own initiative, however many times it faults. That decision stays
  with the operator, deliberately.
- **No DB CHECK constraint on `sensors.in_service`** — the schema adds
  `in_service INTEGER NOT NULL DEFAULT 1` with no accompanying CHECK,
  deliberately deviating from #11's usual "domain check plus DB invariant"
  posture (e.g. `block_edges`, `route_holds`). A CHECK added to an *existing*
  SQLite table forces drizzle-kit to emit a table-rebuild migration
  (`CREATE TABLE ... AS SELECT`, not a plain `ALTER TABLE ADD COLUMN`) on the
  live `sensors` table, and the payoff — guarding a boolean column Zod
  (`parseSensorRow`) already validates on every read — is small next to that
  risk. The half that IS worth having, and landed here, is full-row Zod on
  the read path (`listSensors`/`createSensor`/`updateSensor` now go through
  `parseSensorRow` instead of a bare `as SensorRecord[]` cast) — `type` had
  never actually been validated before, despite now deciding whether a
  `clear` reading may govern a block (D3).
