# Layout Orchestrator — Working Agreement

Model railway layout orchestration for the Westgate Hollow project. A local-first
control stack: Node/TypeScript backend (Fastify, MQTT, DCC EX serial, SQLite) and a
React/Vite operator frontend.

**This is a control system that moves physical hardware.** Safety rules below are not
style preferences.

## Reading this repo without burning context

This file loads into **every session and every subagent**, so every line here is a tax
paid on every task — including tasks that never touch what the line describes. It is
therefore an **index and a rulebook, nothing else**. Three layers, read in order, and
stop as soon as you know enough:

1. **`CLAUDE.md`** (this file) — the rules, and one line per area saying what exists.
2. **`docs/current-state.md`** — the long form of that index: what an area actually
   consists of. Read only the section for the area you are touching.
3. **`docs/<area>.md`** — the decision record: *why* it is that way, as numbered
   decisions (D1, B4, A7, …).

Decision records run to 20–50 KB. When you need one decision, **grep for its id**
(`grep -n "^### D7" docs/point-feedback.md`) rather than reading the file whole. Read a
record end-to-end only when you are changing the design it records.

The same economy applies to work: prefer doing a task inline over spawning a subagent,
because every spawn re-pays this file. Spawn when the user asks, or when the work is
genuinely parallel and self-contained.

When you land a change, **update the index line here and the long form in
`docs/current-state.md`** — and when a later change supersedes an earlier one, rewrite
the entry rather than appending the new story beneath the old one.

## Authoritative documents

| Document | What it governs |
|---|---|
| `docs/current-state.md` | **Long form of the index below** — what each landed area consists of |
| `docs/project-plan.md` | Phase roadmap (0–3) |
| `docs/mqtt-contract.md` | **Binding** MQTT topics, payloads, QoS, retention |
| `docs/topology.md` | Track graph (`block_edges`): validation, deferred items |
| `docs/track-graph-compilation.md` | The drawing *compiles* to `block_edges` under operator review; the compiler is the only writer of the track graph (D1–D10) |
| `docs/track-grid.md` | `grid_tiles` — the Track Editor's drawing, its write path, why a tile carries no authority (D1–D12) |
| `docs/route-locking.md` | Route reservation and locking (D1–D14) |
| `docs/pathfinding.md` | Pathfinding, setting the road, route faults (P1–P8) |
| `docs/auth.md` | Local authentication, the three roles, the pre-TLS threat model |
| `docs/liveness.md` | Connection health: the heartbeat, staleness as a property of the connection, mimic degradation (D5–D7, M1–M9) |
| `docs/sensor-fault-recovery.md` | Sensor-fault latch recovery and the per-sensor occupancy model |
| `docs/sensor-trust.md` | Why a retained reading is never trusted alone, the 30 s re-assert, degrade-vs-Safe-Stop (D1–D14) |
| `docs/braking.md` | Per-loco braking model, deceleration profile, calibration (B1–B12) |
| `docs/automation.md` | Automation engine (#7): what drives a train, the berthing beam, the brake trigger, the one invariant (A1–A14) |
| `docs/sensor-position.md` | Sub-block sensor position: the anchor, the rising-edge fix, its decay (D1–D12) |
| `docs/point-feedback.md` | Point position confirmation channel and fault model (D1–D10) |
| `docs/naming.md` | Operator-facing names: the `NameBook`, invalidation, the D8 degradation contract (D1–D10) |
| `docs/sensor-simulation.md` | Flag-gated sensor simulation panel (D1–D13, R1–R6) |
| `docs/diagram-encoding.md` | Track-diagram encoding: colour is never the sole carrier of meaning (D1–D6) |
| `docs/track-editor.md` | Track Editor authoring: derived extent, per-stroke undo, keyboard navigation, leg-shape table (D1–D19) |
| `docs/claude-review.md`, `docs/gpt-review.md` | Open design questions |

Never invent an MQTT topic or payload field. If `docs/mqtt-contract.md` does not cover
it, the contract must be amended first — the ESP firmware in `bazauto/esp-layout-controller`
is built against it.

## Safety rules (non-negotiable)

1. **Fail-safe on uncertainty.** If sensor, block, MQTT, or DCC state becomes unknown,
   the correct action is Safe-Stop: halt automated movement, refuse new routes, require
   explicit operator recovery. Never guess a train's position.
2. **No business logic in transport callbacks.** MQTT handlers, serial event handlers,
   and HTTP/WebSocket controllers parse, validate, and delegate. Domain decisions live
   in `packages/backend/src/domain/` and `src/services/`.
3. **Validate every inbound payload** with Zod before it reaches the domain layer. A
   malformed payload on a control topic is a Safe-Stop trigger, not a logged warning.
4. **Control topics are never retained.** A retained throttle command causes a ghost
   movement when a controller reconnects. See `docs/mqtt-contract.md` retention policy.
5. **Everything must be testable without hardware.** The simulator is a first-class
   mode, not a fallback.

## Architecture

Ports and adapters, strictly layered:

```
transport/  (http routes, websocket)  ─┐
adapters/   (mqtt, dcc, db)           ─┼─► services/ ─► domain/
                                        (domain depends on nothing)
```

- `src/domain/` — pure logic and types. No imports from transport, adapters, or db.
- `src/ports/` — interfaces the domain/services depend on (`IMqttAdapter`, `IDccController`,
  `ILayoutRepository`). Adapters implement these; services accept them by injection.
- `src/services/LayoutService.ts` — orchestration, emits `LayoutEvent`.
- `src/adapters/` — every external system, each with a simulated twin.

`src/domain/types.ts` is the authoritative vocabulary for the whole system, frontend
included. Add types there, not locally.

## Commands

```powershell
npm install
npm run dev:backend        # Fastify on :3000
npm run dev:frontend       # Vite dev server
npm test                   # all workspace unit + integration tests
npm run lint
npm run test:e2e           # Playwright
npm run db:generate --workspace=packages/backend   # after any schema.ts change
npm run db:migrate --workspace=packages/backend
npm run db:seed --workspace=packages/backend
npm run bootstrap-admin --workspace=packages/backend -- <username> <password>
```

**Run these from the repo root.** `lint`, `test` and `test:e2e` exist only in the root
`package.json`, and the two failure modes are asymmetric: `npm run lint` inside
`packages/backend` fails loudly, but `npm test` there **succeeds while running only that
workspace** — a green backend run reads as a full pass while the frontend suite never
executed. The `--workspace=` commands above are written to run from the root too.

Migrations apply automatically on backend startup from `MIGRATIONS_PATH`. **Any change to
`src/adapters/db/schema.ts` requires a generated migration in the same commit** — this
system is deployed to a live layout and cannot be reset.

**Never run `npm audit fix --force` here.** Its only remaining suggestion is a major
*downgrade* of `drizzle-kit`, the tool that generates migrations against the live
database, and the four residual moderate advisories it offers to fix are one unreachable
chain. Full reasoning in `docs/current-state.md` (Repo notes). Plain `npm audit fix` is
fine and cleared the rest.

Repo housekeeping: `bash .claude/scripts/git-cleanup.sh` previews, and `--yes` applies,
the removal of merged branches, stale `.claude/worktrees/` agent worktrees, and empty
leftover directories. Everything it keeps it names. `/branch-cleanup` wraps it.

## Modes

Set in `.env`:

- `USE_SIMULATOR=true` — full simulator, no broker or hardware needed. Use for tests.
- `USE_SIMULATOR=false` + `DCC_SIMULATOR=true` — hybrid: real broker, simulated DCC.
  Best default for local development.
- both `false` — full hardware.

## Testing expectations

| Layer | Tool | Location |
|---|---|---|
| Domain unit | Vitest | `packages/backend/tests/unit/` |
| Service | Vitest | `packages/backend/tests/unit/services/` |
| HTTP integration | Vitest + Fastify inject | `packages/backend/tests/integration/` |
| Scenario / replay | Vitest | `packages/backend/tests/scenario/` (see `/scenario` skill) |
| Frontend e2e | Playwright | `tests/e2e/` |

Any change to safety, routing, or occupancy logic needs a scenario test covering the
failure path, not just the happy path. Run `npm test` before reporting work complete,
and quote real output — never claim passing tests you did not run.

## Conventions

- TypeScript strict everywhere. Module systems differ per workspace — match the code you
  are editing, do not normalise:
  - **Backend** — CommonJS (`"module": "Node16"`, and `packages/backend/package.json` has
    no `"type"` field, which is what makes these files CommonJS — the *root* says
    `"type": "module"`, but Node reads the nearest one). Static relative imports carry
    **no extension**: `from './types'`. Adding `.js` breaks `tsc`. **One exception:** a
    dynamic `await import('./x.js')` *requires* the extension under `Node16` resolution.
    The only one today is the lazy `SerialDccAdapter` load in `src/index.ts`, commented in
    place. Do not "fix" it.
  - **Frontend** — ESM (`"type": "module"`, `"module": "ESNext"`, bundler resolution).
- Structured logging through a hand-rolled `{info,warn,error}` interface
  (`LayoutServiceLogger` and siblings), wired in `index.ts` to `process.stdout.write`.
  **Pino is not a dependency of any workspace.** Always include `layoutId`, and
  `locoAddress` / `blockId` / `pointId` / `sensorId` where relevant, each **paired with
  its `*Name` counterpart** from the `NameBook` (#54).
- Prettier + ESLint run on pre-commit via Husky. Don't fight the formatter.
- Commit only when asked. Branch off `main` rather than committing to it directly.
- **Documentation moves with the code that invalidates it**, in the same PR — never as a
  follow-up. Before opening a PR, check whether it falsifies the index below,
  `docs/current-state.md`, `README.md` (Known Limits, Next Milestones), or `docs/`.
  Amending `docs/mqtt-contract.md` is stricter still: it is binding, and the contract
  changes *before* the code, not after.

## Current state (2026-08)

Phases 0–2 complete: domain, adapters, persistence, REST, WebSocket, operator UI, config
UI, track editor, CI. Phase 3 is in progress.

### What has landed — index

One line per area: enough to know whether it is what you are touching. The long form is
`docs/current-state.md`; the reasoning is the decision record named in the last column.

| Area | What exists | Why |
|---|---|---|
| **Track topology** (#2, #21, #105) | `block_edges`, validated full-row on every read, written **only** whole via `TopologyService.replaceGraph` — no per-edge routes. An edge carries no length; distance is `blocks.length_mm`. | `topology.md` |
| **Route locking** (#3) | `ReservationService` is the sole owner of lock policy; `domain/routeLocking.ts` is the pure logic; DB partial unique indexes carry exclusivity. | `route-locking.md` |
| **Pathfinding** (#4, #105) | `domain/pathfinding.ts#findPath` — direction-aware Dijkstra whose state is **(block, end entered by)**, which makes no-reversal structural. Pathfinder proposes, `planReservation` disposes. | `pathfinding.md` |
| **Sensor-fault recovery** (#34) | `SystemHealth.sensorFaults` keyed and latched per sensor; occupancy is **derived** by `domain/occupancy.ts#deriveBlockOccupancy`, never last-write-wins. | `sensor-fault-recovery.md` |
| **Sensor trust** (#28) | A retained reading is not evidence. Hardware must re-assert every 30 s; `domain/sensorTrust.ts#isSensorFresh` plus a trust sweep on `IClock` set `trusted`. | `sensor-trust.md` |
| **Auth and roles** (#20, #53, #61, #63) | argon2id + session tokens, one Fastify `onRequest` hook covering `/ws` too. Three roles (admin/operator/monitor); the WS role is captured **once at upgrade**. The frontend mirrors it as affordance, not authorisation. | `auth.md` |
| **Operator-facing names** (#54) | `NameBook` + pure helpers in `domain/naming.ts`; `NameBookCache` behind `INameBook`, injected as an optional trailing parameter. | `naming.md` |
| **Track Editor** (#69, #94, #103 PR 6) | Derived canvas extent, per-stroke client-side undo, persisted pan/zoom, fully keyboard-navigable canvas. **Nothing about a compiled opening is drawn.** | `track-editor.md` D15 |
| **Diagram encoding** (#81, #68, #93) | `diagram/encoding.ts` is the single source of diagram colour; every state ships a pattern/glyph/label. Four validator-checked block tints — do not add a fifth. | `diagram-encoding.md` |
| **Track grid** (#70, #71, #73, #74) | `grid_tiles` is the Track Editor's *drawing*, not the track model — **no domain decision reads a tile**. Writes go through `GridService` behind a closed schema; rejections are 400/404, never Safe-Stop. | `track-grid.md` |
| **Grid diagnostics** (#84, #83, #91, #92, #103) | `GET .../grid/diagnostics` — read-only, advisory, **never a gate**. A diagnostic compares two representations that may legitimately disagree; a compile *gap* says the compiler is not confident, and only that gates. | `track-grid.md` D11 |
| **Track graph compilation** (#103) | `services/trackGraphCompiler.ts` is the **only** writer of `block_edges` and the only source of an opening's name. Compile → review in `CompilePanel` → fingerprinted admin-only apply. Gaps gate `auto`/`hybrid` only, never Safe-Stop. `block_ends` is deleted. | `track-graph-compilation.md` |
| **One renderer, live mimic** (#75, #63, #82, #129) | `TrackDiagram` is the **only** thing that draws the railway. State wins the colour channel; a route is a halo drawn from a **walk** along held track; three global layers, not per-tile groups. | `liveness.md` |
| **Monitor e2e** | `tests/e2e/monitor-view.spec.ts` — the one spec that mounts the monitor, reading the rendered SVG back in one `evaluate`. | `liveness.md` |
| **Point position feedback** (#25) | `commandedPosition` / `confirmedPosition` / six-state `confirmation`; **`effectivePosition` decides which is trusted**. Nothing is persisted. Every fault kind Safe-Stops; the escape hatch is `positionFeedback: 'none'`. | `point-feedback.md` |
| **Per-loco braking** (#6) | `domain/braking.ts` is pure; `BrakingService` plans and `LayoutService` executes one chained timer on `IClock`. Unmeasured intermediate track **refuses** — never guess a stopping distance. | `braking.md` |
| **Sub-block sensor position** (#77) | `position_toward_block_id` + `position_offset_mm`, anchored to an operator-owned **block id**. A **rising edge** sets the fix and it decays by a worst-case travel allowance; **a clear beam still clears nothing.** Consumed as the `lead` term in `remainingRouteDistanceMm`. | `sensor-position.md` |
| **Automation engine** (#7) | Drives an `auto`-authority route: departs, runs, brakes, crawls, berths. The invariant is that **a train under automation never passes the end of its authority**. A 250 ms sweep, not an occupancy hook; the stop target is a **berthing beam**. | `automation.md` |
| **Sensor simulation** (#65) | Flag-gated (`SENSOR_SIMULATION`, off by default) — publishes to the sensor's own `mqttTopic` so the broker echoes it back through ordinary ingestion, byte-identical to hardware. | `sensor-simulation.md` |

### Traps

Things that look like bugs or oversights and are not — each was a deliberate decision.
**One line each; the reasoning is in the record named at the end of the line.** Grep it for
the id (`grep -n "^### D9" docs/sensor-trust.md`) before concluding any of these is wrong.

- A point `command` arms the confirmation deadline; a **`query` deliberately does not** —
  arming on query would halt the layout at boot for any instrumented point whose controller
  was powered off (`point-feedback.md` D6).
- A **`retained` point reading is dropped with a warn, not faulted** — it confirms nothing
  and arms nothing. A malformed or id-mismatched payload still faults, retained or not
  (`point-feedback.md`).
- **Safe-Stop goes through `SystemHealth`/`evaluateAndApplySafeStop`, never
  `stateManager.enterSafeStop` directly** — #4 fixed a live bug where the next unrelated
  health evaluation cleared a route violation (`topology.md`).
- **`migrations/0006_users_last_admin_guard.sql` has no `schema.ts` change, and that is
  correct** — SQLite triggers are outside Drizzle's DSL, so it was generated with
  `drizzle-kit generate --custom` (`auth.md`).
- **A malformed sensor payload Safe-Stops on the first message; a malformed operator UI
  request is an ordinary 400.** The fail-safe rule is scoped to sensor/control topics
  (`sensor-trust.md`).
- **`NameBookCache.refresh` catches `BlockEdgeRowInvalidError` and nothing else** — it runs
  before `loadTopology`, so a wider catch regresses #10's Safe-Stop-not-throw guarantee
  (`naming.md`).
- **`ReservationService.resume` returning `resumed: true` is provisional** —
  `LayoutService.resumeRoute` must re-command every held point, and rolls back to
  `suspended` with locks retained if any is rejected (`route-locking.md`).
- **A `grid_tiles.metadata` blob that fails to parse reads as `{}` instead of throwing**,
  unlike every other row parser — a tile decides nothing, and refusing to open the Track
  Editor over one legacy cell removes the only tool that can fix it (`track-grid.md` D10).
- **An empty payload on a sensor topic is a retained-clear, not a malformed reading** — it
  asserts nothing about occupancy. `null`, `{}` and whitespace-only still fault (#65 D7).
- **A stale sensor degrades only its own blocks; a malformed one Safe-Stops the layout.** A
  malformed payload is a device *lying*; silence is a device *dying*. Softening the
  malformed case was proposed and explicitly overruled (#28 D10).
- **A stale sensor does not poison a block another live detector still covers**, and does
  not raise occupancy from its last reading — untrusted means "not evidence", in both
  directions (#28 D9).
- **A retained delivery never demotes a trusted sensor**, so a broker blip does not flap
  every block to `unknown` — trust is a property of the device, not the connection (#28).

### Open limits

Recorded rather than closed — **none of these is a bug to fix in passing.** One line each;
`README.md` §Known Limits is the long form, with the document behind each position.

- **Read the live DB with its `-wal`, or you will read a stale layout.** `data/layout.db` is
  in WAL mode with a log running to megabytes; copy `layout.db`, `layout.db-wal` and
  `layout.db-shm` together. Copying the `.db` alone silently drops recent drawing edits and
  has already cost a round of wrong conclusions. Prefer a fresh measurement over any count
  quoted in the docs.
- **Until the firmware re-asserts, every sensor-backed block on the live layout reads
  `unknown`** (#28 D12). Expect this to look like a regression on the first hardware run; it
  is not. Manual driving is unaffected — what is refused is routing and automation over
  unobserved track. Fix is ~10 lines of firmware, batched with #9 and #50.
  `USE_SIMULATOR=true` is unaffected.
- **A point lock is an authority guarantee, and a position guarantee only for points
  configured `positionFeedback: 'required'`** (#25). Every live point is `'none'`, so live
  behaviour is unchanged. #25 is complete here; what is outstanding is **firmware**.
- **A braked run to the *immediately next* block is refused unless a beam says otherwise**
  (`braking.md` B4). The model half is closed; what is left is **coverage** — fitting a beam
  fixes it with no code change.
- **Automation's coverage tracks where the beams are.** No trusted, measured `ir_position`
  beam at the destination — or no `crawl_speed_step` on the loco — means no berth: the run
  stops at the destination block's entry boundary and an operator finishes the move.
- **#7 deliberately does not schedule.** One route, one train, one destination, granted by an
  operator. Nothing sequences two trains or plans a timetable. That is the next feature.
- **Driving a granted route is manual** unless it is an `auto`-authority route on a layout
  where an operator has set `locos.auto_speed_step` and the route's `direction` (A12).
- **Two routes fouling at a plain (non-switched) diamond crossing is not caught** (#26).
  Westgate Hollow has none; the editor warns when one is drawn (`diamond-blind-spot`).
- **A point tile's leg mapping is unverifiable authored data** — nothing can check which way
  round a physical point is wired (`track-grid.md` D9).
- **The pathfinder does not search around a point-position conflict** (`pathfinding.md` P5),
  so a path can exist that it will not find.
- **Lock messages name the route id, not the train holding it** (`naming.md` D3).
- **Duplicates hand-maintained across the backend↔frontend wire** — a change to one wants the
  other: `findBlockRuns`, `TILE_LEGS`/`EDGE_OFFSET` (frontend `diagram/trackGeometry.ts`, with
  `trackGeometry.test.ts` asserting the table literally), `HEARTBEAT_INTERVAL_MS`, and
  `effectivePosition`. Closing them needs a shared package spanning a CommonJS backend and an
  ESM frontend; nobody has scoped it. **#75 did not close these** — it closed the
  editor↔monitor seam *inside* the frontend.
- **Westgate Hollow's authoring passes are done and the compiled graph is applied**
  (2026-08-14): one connected component, no gaps, matching fingerprint in `compiled_graphs`.
  `unclassified-tile` and `block-without-detection` being silent is a finished pass, not a
  broken check.
- **#103's rejected alternatives stay rejected** — the anchor coordinate (#97) and a 16-point
  bearing, for `end-label-collision` and for #77's anchor alike. A *disposable* description
  may be guessed at freely; reach for that argument before making any derived name
  referenceable (`track-graph-compilation.md`).
