# Layout Orchestrator — Working Agreement

Model railway layout orchestration for the Westgate Hollow project. A local-first
control stack: Node/TypeScript backend (Fastify, MQTT, DCC EX serial, SQLite) and a
React/Vite operator frontend.

**This is a control system that moves physical hardware.** Safety rules below are not
style preferences.

## Authoritative documents

| Document | What it governs |
|---|---|
| `docs/project-plan.md` | Phase roadmap (0–3) |
| `docs/mqtt-contract.md` | **Binding** MQTT topics, payloads, QoS, retention |
| `docs/topology.md` | Track graph (`block_edges`): validation, deferred items |
| `docs/track-grid.md` | `grid_tiles` — the Track Editor's **drawing**, its validated write path, and why a tile carries no authority (D1–D11) |
| `docs/route-locking.md` | Route reservation and locking (D1–D14) decision record |
| `docs/pathfinding.md` | Pathfinding, setting the road, and route faults (P1–P8) |
| `docs/auth.md` | Local authentication scheme and the pre-TLS threat model |
| `docs/sensor-fault-recovery.md` | Sensor-fault latch recovery and the per-sensor occupancy model |
| `docs/braking.md` | Per-loco braking model, deceleration profile, and calibration (B1–B10) |
| `docs/point-feedback.md` | Point position confirmation channel and fault model (D1–D10) |
| `docs/naming.md` | Operator-facing names: the `NameBook`, its invalidation points, and the D8 degradation contract (D1–D10) |
| `docs/sensor-simulation.md` | Flag-gated sensor simulation panel: decision record and mechanical resolutions (D1–D13, R1–R6) |
| `docs/diagram-encoding.md` | Track-diagram encoding: colour is never the sole carrier of meaning (D1–D6) |
| `docs/track-editor.md` | Track Editor authoring: derived canvas extent, per-stroke undo, view persistence, the wave-2 affordances, and diagram labelling (D1–D10) |
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
npm run bootstrap-admin --workspace=packages/backend -- <username> <password>  # create/reset an admin account
```

**Run these from the repo root.** `lint`, `test` and `test:e2e` are defined only in the
root `package.json`, and the two failure modes are asymmetric: `npm run lint` from inside
`packages/backend` fails loudly with `Missing script: "lint"`, but `npm test` there
succeeds while running **only that workspace** — so a green backend run reads as a full
pass while the frontend suite never executed. The `--workspace=` commands above are the
exception and are already written to be run from the root too.

Repo housekeeping: `bash .claude/scripts/git-cleanup.sh` previews, and `--yes` applies,
the removal of merged branches, the stale `.claude/worktrees/` agent worktrees holding
them, and empty leftover directories git no longer tracks. Everything it keeps it names,
including worktrees held by unmerged branches — a quiet run means nothing to do, not a
decision made silently. The `/branch-cleanup` skill is a thin wrapper over it.

Migrations are applied automatically on backend startup from `MIGRATIONS_PATH`.
**Any change to `src/adapters/db/schema.ts` requires a generated migration in the same
commit** — this system is deployed to a live layout and cannot be reset.

**Never run `npm audit fix --force` here.** Its only remaining suggestion is
`drizzle-kit@0.18.1` — a major *downgrade* of the tool that generates migrations against
that live database. The four residual moderate advisories it is offering to "fix" are all
one chain: `drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils →
esbuild@0.18.20`. Nothing forward fixes it (drizzle-kit is already at latest and still
declares the deprecated loader), and it is not reachable — drizzle-kit's shipped JS
contains no reference to `@esbuild-kit` at all, and the advisory is about esbuild's dev
*server*, which `core-utils` never starts (it calls `transform`/`transformSync` only).
Plain `npm audit fix` is fine and is what cleared the rest.

## Modes

Set in `.env`:

- `USE_SIMULATOR=true` — full simulator, no broker or hardware needed. Use for tests.
- `USE_SIMULATOR=false` + `DCC_SIMULATOR=true` — hybrid: real MQTT broker, simulated DCC.
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
  - **Backend** — CommonJS (`"module": "Node16"`, `"moduleResolution": "Node16"`, and
    `packages/backend/package.json` has no `"type"` field, which is what makes these
    files CommonJS — the *root* `package.json` says `"type": "module"`, but Node reads
    the nearest one). Static relative imports carry **no extension**:
    `from './types'`. Adding `.js` to a static import breaks `tsc`.
    **One exception:** a dynamic `await import('./x.js')` *requires* the extension,
    because dynamic imports always carry ESM semantics under `Node16` resolution. The
    only one today is the lazy `SerialDccAdapter` load in `src/index.ts`; it is
    commented in place. Do not "fix" it to match the static rule.
  - **Frontend** — ESM (`"type": "module"`, `"module": "ESNext"`, bundler resolution).
- Structured logging through a hand-rolled `{info,warn,error}` interface
  (`LayoutServiceLogger` and its siblings), wired in `index.ts` to
  `process.stdout.write(JSON.stringify(...))`. **Pino is not a dependency of any
  workspace** — do not assume it. Always include `layoutId`, and `locoAddress` /
  `blockId` / `pointId` / `sensorId` where relevant, each **paired with its `*Name`
  counterpart** from the `NameBook` (#54) so a log line is both greppable by id and
  readable by a human.
- Prettier + ESLint run on pre-commit via Husky. Don't fight the formatter.
- Commit only when asked. Branch off `main` rather than committing to it directly.
- **Documentation moves with the code that invalidates it**, in the same PR — never as a
  follow-up. Before opening a PR, check whether it falsifies anything in **Current state**
  below, `README.md` (Known Limits, Next Milestones), or `docs/`. `CLAUDE.md` is loaded
  into every session, so a stale entry there actively misdirects the next one. Amending
  `docs/mqtt-contract.md` is stricter still: it is binding, and the contract changes
  *before* the code, not after.

## Current state (2026-08)

Phases 0–2 complete: domain, adapters, persistence, REST, WebSocket, operator UI,
config UI, track editor, CI. Phase 3 is in progress.

**This section is an index, not a changelog.** Each row says what exists and which
document holds the reasoning. The "why, not just what" lives in `docs/` — do not restate
it here. `CLAUDE.md` loads into every session *and every subagent*, so length in this file
is a tax paid on every task. When you land a feature, add or amend one row and put the
decision record in `docs/`; when a later change supersedes an earlier one, **rewrite the
row rather than appending the new story beneath the old one.**

### What has landed

| Area | What exists | Read before touching |
|---|---|---|
| **Track topology** (#2, #21) | `block_edges` with a full backend path: edge CRUD on `ILayoutRepository`, full-row Zod (`parseBlockEdgeRow`) on every read, DB-level graph invariants, a `TopologyService` write path that validates against the rest of the layout, and `LayoutService.reloadTopology()` applying Safe-Stop on a fatal violation. Validation is O(n) in edge count; `MAX_EDGES_PER_LAYOUT` (2,000) is admission control in `TopologyService.createEdge` only, not a DB or load-path check. Edges are authored explicitly in the Configure screen's Edges tab — deriving them from grid tiles stays deferred. | `docs/topology.md` |
| **Route locking** (#3) | `ReservationService` is the sole owner of lock policy; `LayoutStateManager` stays storage. `domain/routeLocking.ts` is the pure planning/release logic; `route_reservations`/`route_holds` carry DB-level exclusivity via partial unique indexes. `TopologyService` refuses a topology write against anything an active or suspended route holds (409). | `docs/route-locking.md` |
| **Pathfinding** (#4) | `domain/pathfinding.ts#findPath` — a pure, direction-aware Dijkstra whose search state is **(block, end entered by)**, which is what makes the no-reversal rule structural rather than a post-filter. The pathfinder proposes, `planReservation` disposes. `SystemHealth.routeFaults` latches route violations. | `docs/pathfinding.md` |
| **Sensor-fault recovery** (#34, supersedes #27's scalar pair) | `SystemHealth.sensorFaults` is a keyed collection, one latched fault per sensor, with `acknowledgeSensorFault` and `sensors.in_service` for recovery. Block occupancy is **derived**, not last-write-wins: `domain/occupancy.ts#deriveBlockOccupancy` is the only thing that feeds `ReservationService.onOccupancyChange`. | `docs/sensor-fault-recovery.md` |
| **Local auth** (#20) and **user/role management** (#53) | argon2id + session tokens pure in `domain/auth.ts`; one Fastify `onRequest` hook rejects unauthenticated requests before any route, including the `/ws` upgrade. `AuthService` owns all user policy; the repository stays storage. `requireAdmin` on every topology/config write and all of `/api/users`. `POST /api/emergency-stop` is the single deliberately unauthenticated path. | `docs/auth.md` |
| **Operator-facing names** (#54) | `NameBook` (`domain/types.ts`) + pure helpers in `domain/naming.ts`; every `describe*` takes an optional trailing `book?: NameBook` and, without one, renders raw ids byte-for-byte as before. `NameBookCache` (`services/nameBook.ts`) behind the `INameBook` port is injected into the three services as an optional trailing constructor parameter. | `docs/naming.md` |
| **Track Editor authoring** (#69) | Canvas extent derives from content plus a margin — there is no fixed grid to hit, and `MAX_COORDINATE` is admission control, not an edge. Undo is client-side and **per stroke**, so a stray right-drag is one click to reverse; it is never persisted. `⌂` fits content. Pan/zoom persist per layout. | `docs/track-editor.md` |
| **Diagram encoding** (#81, #68, #93) | `diagram/encoding.ts` is the single source of track-diagram colour; every state ships a pattern/glyph/label so colour is never the sole carrier. Block tints are **four** validator-checked colours assigned by graph colouring over adjacency (`diagram/blockRuns.ts`), marking block *boundaries* — a tint never identifies a block, the label does. Don't add a fifth tint: it fails CVD checks. A point is labelled **once per point** by its identifier (`diagram/pointLabels.ts`), because a point is drawn as two tiles sharing one `pointId`. | `docs/diagram-encoding.md`, `docs/track-editor.md` D10 |
| **Track grid** (#70, #71, #73, #74) | `grid_tiles` is the Track Editor's *drawing*, not the track model — no domain decision reads a tile. Writes go through `GridService` (layout existence; `blockId`/`pointId`/annotation ids resolve **in this layout**) behind `gridTileWriteSchema`: closed `tileType` enum, bounded coordinates, and a **closed** `metadata` schema every later field must be added to. `metadata` now also carries `trackRole` (#71 — only ever asserts *decorative*; `classifyTile` derives the three-way state), `annotations` (#74 — generic `{entityType, entityId}` list, never assume "sensor") and `pointRoads` (#73 — leg-list shaped, keyed by a position *tuple*, so slips and three-ways stay open). Rejections are 400/404 — never Safe-Stop. | `docs/track-grid.md` |
| **Block ends** (#72, #91) | `block_ends` (`(blockId, label)` unique) names a block's openings — the referent of `block_edges.fromEnd`/`toEnd`. An opening is where the block's **drawn track leaves the run**, from tile type + rotation (`services/tileGeometry.ts`), never from cell adjacency — two yard roads drawn side by side touch everywhere and connect nowhere. Connectivity is mutual; track butted against a tile that draws nothing back is an end, reported as `track-not-joined`. An end is a dead end only if **every** opening in it is terminated. Labels are still 8-point cardinals bearing from the run centroid, **pinned** when authored or edge-referenced, regenerated on demand only, and a rename or delete of an edge-referenced label is a **409, never a cascade**. Deliberately **no FK** from `block_edges`. | `docs/topology.md`, `docs/track-grid.md` D12 |
| **Grid diagnostics** (#84, #83, #71) | `GET .../grid/diagnostics` — read-only, advisory, never a gate. `warning` = two representations disagree or a hazard is drawn (buffer contradicted by an edge, dangling reference, duplicate annotation, drawn plain diamond per #26); `info` = authoring unfinished (unclassified tile, end with no edges and no buffer, unmapped point tile). Nothing in `domain/` reads a tile, and `TopologyService` never refuses an edge write because of one. | `docs/track-grid.md` D11 |
| **Sensor simulation** (#65) | Flag-gated (`SENSOR_SIMULATION`, off by default) bench tool: `SensorSimulationService` publishes a fabricated reading to the sensor's own `mqttTopic` and the broker echoes it back through the ordinary ingestion path — byte-identical to hardware, no marker field. `GET /api/capabilities` gates the Operate-pane panel and fails closed. | `docs/sensor-simulation.md` |

### Traps

Things that look like bugs or oversights and are not. Each was a deliberate decision:

- **Safe-Stop goes through `SystemHealth`/`evaluateAndApplySafeStop`, never
  `stateManager.enterSafeStop` directly.** #4 fixed a live bug where a route violation
  bypassed `SystemHealth`, so the next unrelated health evaluation cleared a Safe-Stop
  caused by a train being somewhere it should not be.
- **`migrations/0006_users_last_admin_guard.sql` has no `schema.ts` change**, and that is
  correct — SQLite triggers cannot be expressed in Drizzle's schema DSL, so it was
  generated with `drizzle-kit generate --custom`. `schema.ts` carries a comment above
  `users` recording that they exist. Do not "fix" the missing structural change.
- **A malformed sensor payload is a Safe-Stop on the first message, with no tolerance.**
  A malformed *operator UI* request is an ordinary 400 — turning a bad UI request into a
  layout halt would itself be a bug. The contract's fail-safe rule is scoped to
  sensor/control topics.
- **`NameBookCache.refresh` catches `BlockEdgeRowInvalidError` and nothing else.** It runs
  before `loadTopology` inside `reloadTopology`, so a wider catch would let a corrupt row
  escape `loadTopology`'s narrow catch and regress #10's Safe-Stop-not-throw guarantee.
- **`ReservationService.resume` returning `resumed: true` is provisional.** The service has
  no DCC access; `LayoutService.resumeRoute` must re-command every held point before the
  resume counts, and rolls back to `suspended` with locks retained if any is rejected.
- **A `grid_tiles.metadata` blob that fails to parse reads as `{}` instead of throwing**,
  unlike every other row parser in `validation.ts`. Deliberate (`docs/track-grid.md` D10):
  a bad `block_edges` row Safe-Stops because the pathfinder plans on it, while a tile
  decides nothing — and refusing to open the Track Editor over one legacy cell removes
  the only tool that can fix it. The diagnostics report it rather than swallow it.
- **An empty payload on a sensor topic is a retained-clear, not a malformed reading** —
  `handleSensorReading` step 2b returns before the Zod parse and raises no fault (#65 D7,
  `docs/sensor-fault-recovery.md` D9). It looks like a hole in the "malformed payload is a
  Safe-Stop" rule and is not: an empty message asserts nothing about occupancy, and halting
  the layout because someone cleared a retained flag is a nuisance, not a safety win.
  `null`, `{}` and whitespace-only payloads all still fault.

### Open limits

Recorded rather than closed — do not treat any of these as bugs to fix in passing:

- **A point lock is an authority guarantee, not a physical position guarantee.** There is
  still no point-position feedback channel (#25).
- **Two routes fouling at a plain (non-switched) diamond crossing is not caught**, since
  neither shares a block or a point (#26). Westgate Hollow has none today; the editor now
  says so when one is drawn (`diamond-blind-spot`), which is a warning, not a fix.
- **A point tile's leg mapping is unverifiable authored data.** Nothing can check which
  way round a physical point is wired, and `pointConditions` carries no geometry to check
  it against (`docs/track-grid.md` D9).
- **The classification pass over the existing Westgate Hollow grid is manual** and not yet
  done — every untagged tile reports as `unclassified` until it is. That is the intended
  state, not a bug: a defaulting rule would have to guess which track is monitored.
- **Two hand-maintained duplicates across the wire**, both for #75 to unify: `findBlockRuns`
  in `services/gridGeometry.ts` (backend, end generation) and `diagram/blockRuns.ts`
  (frontend, tints and labels); and `TILE_LEGS` in `services/tileGeometry.ts`, of which
  `DRAWN_LEGS` in `diagram/pointRoads.ts` is two rows. A change to one wants the other.
- **The pathfinder does not search around a point-position conflict**, so a path can exist
  that it will not find (P5 in `docs/pathfinding.md`).
- **Driving a granted route is manual.** #4 sets and reserves the road; it does not drive
  the train.
- **Lock messages name the route id, not the train holding it** (D3 in `docs/naming.md`) —
  a route has a different invalidation lifetime from the rest of the `NameBook`.
- Phase 3's remaining work is per-loco braking (#6) and collision avoidance (#7).
