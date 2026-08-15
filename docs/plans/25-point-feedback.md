# #25 Point Position Feedback — implementation running order

The design is decided and recorded in `docs/point-feedback.md` (D1–D10); the
contract amendment landed already (`b2b6641`). This file is the *running
order* only — what lands in which PR, in which order, and the exact
signatures the parallel pieces agree on. Where this file and
`docs/point-feedback.md` differ, the decision record wins.

Two PRs, as the decision record says:

- **PR A — the channel.** Config, the `PointState` re-shape, ingestion, the
  confirmation timeout, latched `SystemHealth.pointFaults` with acknowledge,
  the simulated point controller, and the UI.
- **PR B — route interaction.** `RouteFaultKind` gains `point-not-confirmed`,
  the suspend-and-stop path, the resume precondition, and `docs/route-locking.md`
  D11.

## Decisions taken here that the decision record left open or did not reach

1. **`IClock` gains `setInterval`.** The port shipped with #6 carries `now()`
   and `setTimeout` only. D5 needs a 250 ms sweep. A self-rescheduling
   `setTimeout` chain would put re-arm bookkeeping in `LayoutService` and make
   "cancelled between fire and re-arm" a live hazard on a safety timer, so the
   port gains `setInterval(fn, ms): ClockTimer` — same handle type as
   `setTimeout`, so nothing about the existing braking call sites changes.
2. **An automated route may be granted over a `positionFeedback: 'none'`
   point** (`docs/point-feedback.md` open question 1, recommendation "yes").
   `planReservation` is untouched: `positionFeedback` gates *what a
   confirmation means*, never *whether a route may be granted*. Refusing would
   make automation impossible until every point on the layout is instrumented.
   The reduced guarantee is stated per point where the operator can see it —
   the Layout panel's "no feedback" marker and the monitor's point key — not
   in a footnote. Recorded in `docs/point-feedback.md` as resolved.
3. **A `driver`-sourced reading on a `'required'` point yields
   `indeterminate`, which is a fault, which Safe-Stops** — D3 and D4 composed.
   That is the intended reading of both: an operator who marks a point
   `'required'` has asserted a sensor is fitted, and a controller answering
   `driver` says it is not. Self-announcing misconfiguration, cleared by
   flipping the point back to `'none'` (D4's escape hatch).
4. **An `id-mismatch` or malformed payload on a topic naming a point this
   layout does not have is dropped with a warn, and latches nothing** — the
   D10-of-the-issue rule for an unknown device, unchanged. The fault is
   latched against the *topic* point id when that point is known, never
   against the point id the payload claimed.

---

## PR A

### Stage 1 — domain, persistence, state (no `LayoutService`)

**`packages/backend/src/ports/IClock.ts`** — add:

```ts
setInterval(fn: () => void, everyMs: number): ClockTimer;
```

`SystemClock` wraps the global. `ManualClock.advance` fires a repeating timer
once per elapsed period, in due order with the one-shot timers, re-arming from
its own due instant (not from `now`), so advancing 1000 ms past a 250 ms
interval fires it four times. A callback that throws must not stop the other
timers — a thrown handler must never silently kill the confirmation sweep.

**`domain/types.ts`**:

```ts
export type PointFeedbackMode = 'none' | 'required';

export type PointConfirmation =
  | 'unreported'     // no reading ever received
  | 'pending'        // a command is outstanding; deadline running
  | 'confirmed'
  | 'mismatch'       // reported, but not the commanded position
  | 'indeterminate'  // reported 'unknown', or 'driver'-sourced on a 'required' point
  | 'timed-out';

export interface PointState {
  pointId: PointId;
  commandedPosition: 'normal' | 'reverse' | null;
  confirmedPosition: PointPosition;          // 'unknown' until a reading lands
  confirmation: PointConfirmation;
  positionFeedback: PointFeedbackMode;
  awaitingSince: Date | null;                // non-null iff confirmation === 'pending'
  lastReadingAt: Date | null;
  locked: boolean;
  lockedByRoute: RouteId | null;
  lastUpdated: Date;
}

export interface PointReading {
  pointId: PointId;
  position: PointPosition;
  source: 'sensor' | 'driver';
  reportedAt: Date | null;   // from the payload; never used as a clock
}

export type PointFaultKind =
  | 'timeout' | 'mismatch' | 'indeterminate' | 'malformed-payload' | 'id-mismatch';

export interface PointFault {
  pointId: PointId;
  kind: PointFaultKind;
  reason: string;
  faultedAt: Date;
  /** Consecutive confirming readings since the fault — D4's arming counter. */
  consecutiveConfirmations: number;
}

export interface PointFaultView {
  pointId: PointId;
  kind: PointFaultKind;
  reason: string;
  faultedAt: string;
  consecutiveConfirmations: number;
  requiredConfirmations: number;
  armed: boolean;
}
```

`PointState.position` is **removed**, not deprecated (D3). `LayoutEvent`,
`ServerMessage` and `StateSnapshot` gain `POINT_FAULTS` /
`pointFaults: PointFaultView[]`, mirroring `SENSOR_FAULTS` exactly.

**`domain/safety.ts`** — `SystemHealth.pointFaults: Record<PointId, PointFault>`,
required, not optional. `evaluateSystemSafeStop` checks it **after** sensor
faults and **before** route faults (D4's priority slot). Add
`oldestPointFault`, reusing the existing generic `oldestFault`.

**`domain/pointConfirmation.ts`** — pure, importing only from `domain/`:

```ts
export interface PointConfirmationPolicy { timeoutMs: number; }

export function initialPointState(pointId: PointId, feedback: PointFeedbackMode, now: Date): PointState;
export function onPointCommanded(p: PointState, position: 'normal' | 'reverse', now: Date): PointState;
export function onPointQueried(p: PointState, now: Date): PointState;
export function applyPointReading(p: PointState, reading: PointReading, now: Date): PointState;
export function evaluateTimeout(p: PointState, now: Date, policy: PointConfirmationPolicy): PointState | null;
export function effectivePosition(p: PointState): PointPosition;
export function buildPointPositionMap(points: ReadonlyMap<PointId, PointState>): Map<PointId, PointPosition>;
export function confirmationArms(p: PointState, reading: PointReading): boolean;
```

Rules (each one a doc comment on the function):

- `onPointCommanded` always sets `commandedPosition`. For `'required'` it also
  sets `confirmation: 'pending'`, `awaitingSince: now`,
  `confirmedPosition: 'unknown'`. For `'none'` no deadline runs and
  `confirmation` is left untouched.
- `onPointQueried` **does not** arm a deadline (D6). It is a no-op on state
  beyond `lastUpdated`.
- `applyPointReading`: `position === 'unknown'` → `indeterminate`,
  `confirmedPosition: 'unknown'`. A `source: 'driver'` reading on a
  `'required'` point → `indeterminate`, `confirmedPosition: 'unknown'` (D3).
  Otherwise `confirmedPosition = reading.position` and `confirmation` is
  `confirmed` when it equals `commandedPosition`, `mismatch` when it does not,
  and `confirmed` when `commandedPosition === null` (a query answer with
  nothing outstanding to disagree with). Always clears `awaitingSince`, always
  sets `lastReadingAt`.
- `evaluateTimeout` returns `null` unless `confirmation === 'pending'` and
  `now - awaitingSince >= policy.timeoutMs`; otherwise `'timed-out'`,
  `confirmedPosition: 'unknown'`, `awaitingSince: null`.
- `effectivePosition` per D7: `'required'` → `confirmedPosition`, full stop;
  `'none'` → `confirmedPosition` if not `'unknown'`, else
  `commandedPosition ?? 'unknown'`.
- `confirmationArms` is D4's one rule with no per-kind branching: a reading
  that is well-formed, non-retained, and confirms the point at its
  `commandedPosition` — or, if never commanded this session, is a
  `sensor`-sourced reading that is not `'unknown'`.

**`domain/pointPayload.ts`** (sibling of `sensorPayload.ts`):

```ts
export const pointReadingSchema = z.object({
  pointId: z.string().min(1),
  position: z.enum(['normal', 'reverse', 'unknown']),
  source: z.enum(['sensor', 'driver']),
  updatedAt: z.string().datetime().optional(),
}).strict();
```

**`domain/layoutState.ts`** — `registerPoint(pointId, feedback, now)` builds
via `initialPointState`; `updatePointPosition` is replaced by
`setPointState(pointId, next): PointState`, which stores what the domain
decided. A `setPointState` for an unregistered point id is a no-op that
returns the passed state without inserting.

**Persistence** — `points.position_feedback TEXT NOT NULL DEFAULT 'none'`,
added as a plain `ALTER TABLE ADD COLUMN`. **No CHECK constraint** (D10): a
CHECK on an existing SQLite table forces drizzle-kit to emit a table rebuild
against a live database that cannot be reset. Generate the migration with
`npm run db:generate --workspace=packages/backend` and read the SQL before
committing — a rebuild in the diff means something is wrong. `PointRecord`
gains `positionFeedback`; `validation.ts` gains `pointRowSchema` /
`parsePointRow` / `PointRowInvalidError` modelled exactly on `parseSensorRow`,
wired through every `listPoints`/`createPoint`/`updatePoint` read;
`pointCreateSchema` and `pointUpdateSchema` accept `positionFeedback`
(optional, defaulting to `'none'` on create).

**`services/PointConfirmationService.ts`** — no MQTT, no DCC, no timer:

```ts
export type PointReadingRejection =
  | { kind: 'unknown-point'; pointId: PointId }
  | { kind: 'id-mismatch'; topicPointId: PointId; payloadPointId: PointId };

export interface PointReadingOutcome {
  point: PointState | null;
  rejection: PointReadingRejection | null;
  arms: boolean;   // this reading counts toward clearing a latched fault
}

noteCommanded(pointId, position, now): PointState | null;
noteQueried(pointId, now): PointState | null;
applyReading(topicPointId, reading, now, retained): PointReadingOutcome;
sweep(now): PointState[];                 // only the points that transitioned
pointsRequiringFeedback(): PointId[];
```

Tests for stage 1 live in `tests/unit/domain/pointConfirmation.test.ts`,
`tests/unit/adapters/clock.test.ts`, `tests/unit/services/pointConfirmationService.test.ts`
and the existing `layoutState` / `graph` / `validation` suites. The failure
paths that must be covered are listed in `docs/point-feedback.md` and in the
#25 plan comment; the load-bearing one is that a topic/payload id mismatch
updates **neither** point.

### Stage 2a — `LayoutService`, the simulator, wiring

- Constructor takes `clock: IClock` and `pointConfirmations: PointConfirmationService`.
- `config.points = { confirmTimeoutMs: POINT_CONFIRM_TIMEOUT_MS ?? 8000,
  sweepIntervalMs: POINT_CONFIRM_SWEEP_MS ?? 250,
  faultClearAfterConfirmations: POINT_FAULT_CLEAR_CONFIRMATIONS ?? 1 }`, plus
  `simulator.pointConfirmDelayMs` (`POINT_SIM_CONFIRM_DELAY_MS`, default 150).
  Mirrored into `.env.example`.
- `initializeLayoutState` registers each point with its `positionFeedback` and
  publishes `point/{id}/state` for every point, which also overwrites the
  stale old-shape retained messages the pre-rename backend left on the broker.
- `subscribePointReadings(layoutId)` — one wildcard subscription to
  `layout/{id}/point/+/reading`; the callback extracts the point id from the
  topic and calls `handlePointReading(topicPointId, payload, retained)` and
  nothing else.
- `handlePointReading`: a `retained` reading is **dropped with a warn** (D1) —
  it confirms nothing and arms nothing. Zod failure or id mismatch on a known
  point latches a `PointFault` (`malformed-payload` / `id-mismatch`), which is
  what enters Safe-Stop — never `enterSafeStop` directly (CLAUDE.md Traps).
  An unknown topic point is a warn and a drop.
- `handlePointCommand` calls `noteCommanded` after `dcc.setPoint` resolves.
- `startConfirmationSweep()` / `stopConfirmationSweep()` on
  `clock.setInterval`, started next to `startHeartbeat` and stopped in
  `stop()`. Each transition publishes `POINT_STATE` and, for
  `timed-out`/`mismatch`/`indeterminate`, latches a `PointFault`.
- `queryPointPositions()` publishes `point/{id}/query` `{ requestedAt }` at
  `{ qos: 1, retain: false }` for every `'required'` point, at the end of
  `start()` and on every MQTT reconnect.
- `getPointFaults()` / `acknowledgePointFault()` mirroring the sensor pair,
  with `GET /api/layouts/:layoutId/point-faults` and
  `POST /api/layouts/:layoutId/points/:id/acknowledge-fault` mirroring
  `sensors.ts`.
- `publishPointState` publishes exactly the contract's field set —
  `awaitingSince` and `lastReadingAt` stay off MQTT.
- `getPointPositions(): ReadonlyMap<PointId, PointPosition>` via
  `buildPointPositionMap`.
- `adapters/simulator/SimulatedPointController.ts` per D9: subscribes to
  `point/+/query`, publishes `point/{id}/reading` after `confirmDelayMs` on
  the injected clock, non-retained, with `mode: 'confirm' | 'silent' |
  'wrong-position' | 'indeterminate' | 'driver-only'` globally or per point,
  and the in-process `noteCommanded` hook wired from `index.ts` through an
  optional `onPointCommanded` callback on `LayoutService`.

### Stage 2b — frontend (parallel with 2a; disjoint workspace)

Mirror the types. `LayoutPanel` shows `confirmedPosition` as the primary badge
with `commandedPosition` as secondary text when they differ, colours keyed on
`confirmation` rather than position, a disabled throw button while `pending`,
and a "no feedback" marker on `'none'` points — the honest per-point statement
of the guarantee (decision 2 above). `diagram/liveState.ts`,
`diagram/pointKey.ts` and `diagram/routePaths.ts` read `effectivePosition`,
ported as a pure frontend helper next to the existing diagram helpers, never
`commandedPosition` directly. Point faults render in the same place sensor
faults do.

### Stage 3 — scenario tests and docs

Scenario harness gains a `ManualClock`, the confirmation service, the
simulated controller, `commandPoint`, `advance`, and `positionFeedback` on
`_setPoints`. The nine scenarios listed in the #25 plan comment, of which the
regression guard for the live layout — a `'none'` point commanded and never
reporting stays trusted, no timeout, no fault, no Safe-Stop — is the one that
must not be dropped.

Docs in the same PR: `CLAUDE.md` (a row in **What has landed**, the open
limit about point position rewritten, `docs/point-feedback.md` already in the
authoritative table), `README.md` Known Limits, `docs/point-feedback.md`
(open question 1 marked resolved).

## PR B

`RouteFaultKind` gains `'point-not-confirmed'` with suspend semantics
matching `'occupancy-unknown'`. When a held point transitions to `timeout`,
`mismatch` or `indeterminate` while an `active` or `suspended` reservation
holds it: suspend the route (never cancel — locks retained), stop its loco
unconditionally, and latch both a `PointFault` and a `RouteFault` (D8).
`LayoutService.resumeRoute` refuses before calling `reservations.resume` if
any point the route holds carries a latched, unacknowledged `PointFault` —
the check is against the *fault*, never against `confirmation === 'pending'`,
which would deadlock because resuming re-commands every held point.
`docs/route-locking.md` D11 is rewritten to the per-point split, and #4's
acceptance criterion is tightened back on the issue.
