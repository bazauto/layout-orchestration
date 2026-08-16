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
| `docs/track-graph-compilation.md` | **Shipped (#103).** The drawing *compiles* to `block_edges` under operator review, and `block_ends` is deleted (D1–D10). The compiler is the **only** writer of the track graph; there is one description of the railway's connectivity, not two. Applied to the live layout 2026-08-14. Status table at the head of the file. |
| `docs/track-grid.md` | `grid_tiles` — the Track Editor's **drawing**, its validated write path, why a tile carries no authority, and what makes two tiles connected (D1–D12) |
| `docs/route-locking.md` | Route reservation and locking (D1–D14) decision record |
| `docs/pathfinding.md` | Pathfinding, setting the road, and route faults (P1–P8) |
| `docs/auth.md` | Local authentication scheme, the three roles, and the pre-TLS threat model |
| `docs/liveness.md` | Connection health: the heartbeat, why staleness is a property of the connection and not of an entity, and how the mimic degrades (D5–D7, M1–M5) |
| `docs/sensor-fault-recovery.md` | Sensor-fault latch recovery and the per-sensor occupancy model |
| `docs/braking.md` | Per-loco braking model, deceleration profile, and calibration (B1–B10) |
| `docs/sensor-position.md` | Sub-block sensor position: the anchor, the rising-edge fix, its decay, and why a clear beam still clears nothing (D1–D12) |
| `docs/point-feedback.md` | Point position confirmation channel and fault model (D1–D10) |
| `docs/naming.md` | Operator-facing names: the `NameBook`, its invalidation points, and the D8 degradation contract (D1–D10) |
| `docs/sensor-simulation.md` | Flag-gated sensor simulation panel: decision record and mechanical resolutions (D1–D13, R1–R6) |
| `docs/diagram-encoding.md` | Track-diagram encoding: colour is never the sole carrier of meaning (D1–D6) |
| `docs/track-editor.md` | Track Editor authoring: derived canvas extent, per-stroke undo, view persistence, the wave-2 affordances, diagram labelling, keyboard navigation, the one leg-shape table, and why nothing about an opening is drawn (D1–D18; D8/D12/D13/D15 record removals) |
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
| **Track topology** (#2, #21, #105) | `block_edges` with a full backend path: edge reads plus an atomic `replaceBlockEdges` on `ILayoutRepository`, full-row Zod (`parseBlockEdgeRow`) on every read, DB-level graph invariants, a `TopologyService` write path that validates against the rest of the layout, and `LayoutService.reloadTopology()` applying Safe-Stop on a fatal violation. Validation is O(n) in edge count; `MAX_EDGES_PER_LAYOUT` (2,000) is admission control in `TopologyService.replaceGraph` only — a check on the whole candidate set — not a DB or load-path check. Edges are **compiled from the drawing** and applied whole (#103 PR 5): there is no `POST`/`PUT`/`DELETE .../edges` and no `createEdge`/`updateEdge`/`deleteEdge`, only `replaceGraph`. `GET .../edges` stays and the Edges tab lists it. **An edge carries no length**: a joint is treated as zero and distance is on `blocks.length_mm` (D4/D5, #105), which `TrackGraph.blockLengthsMm` carries to both consumers. | `docs/topology.md`, `docs/track-graph-compilation.md` |
| **Route locking** (#3) | `ReservationService` is the sole owner of lock policy; `LayoutStateManager` stays storage. `domain/routeLocking.ts` is the pure planning/release logic; `route_reservations`/`route_holds` carry DB-level exclusivity via partial unique indexes. `TopologyService` refuses a topology write against anything an active or suspended route holds (409). | `docs/route-locking.md` |
| **Pathfinding** (#4, #105) | `domain/pathfinding.ts#findPath` — a pure, direction-aware Dijkstra whose search state is **(block, end entered by)**, which is what makes the no-reversal rule structural rather than a post-filter. A hop costs the **block it lands in** (`DEFAULT_BLOCK_LENGTH_MM` when unmeasured), so what discriminates two routes is the intermediate track, and a detour can win with more hops. The pathfinder proposes, `planReservation` disposes. `SystemHealth.routeFaults` latches route violations. | `docs/pathfinding.md` |
| **Sensor-fault recovery** (#34, supersedes #27's scalar pair) | `SystemHealth.sensorFaults` is a keyed collection, one latched fault per sensor, with `acknowledgeSensorFault` and `sensors.in_service` for recovery. Block occupancy is **derived**, not last-write-wins: `domain/occupancy.ts#deriveBlockOccupancy` is the only thing that feeds `ReservationService.onOccupancyChange`. | `docs/sensor-fault-recovery.md` |
| **Local auth** (#20), **user/role management** (#53), **roles in the UI** (#61, #63) | argon2id + session tokens pure in `domain/auth.ts`; one Fastify `onRequest` hook rejects unauthenticated requests before any route, including the `/ws` upgrade. `AuthService` owns all user policy; the repository stays storage. `requireAdmin` on every topology/config write and all of `/api/users`. `POST /api/emergency-stop` is the single deliberately unauthenticated path. **Three roles**: `admin` edits, `operator` drives, `monitor` only watches. A monitor's driving commands are refused **at the WebSocket edge** by a role captured **once at the upgrade** into a per-connection `const` — never a per-message lookup, which is what preserves "auth is enforced only at the connection edge, never mid-connection". A refusal is an `ERROR` reply, **never a socket close**; `EMERGENCY_STOP` is absent from the gated list and reachable by every role. The fallback when `request.user` is somehow absent is `'monitor'`, the *least* privileged — an unreachable defensive branch still resolves fail-safe. The frontend mirrors all of it as **affordance, not authorisation** (`TABS_BY_ROLE` in `App.tsx`): admin gets four tabs, operator gets Operate + Monitor, monitor gets Monitor alone, and `appTab` starts at the role's first visible tab. Hiding a tab does nothing to `curl`. | `docs/auth.md` |
| **Operator-facing names** (#54) | `NameBook` (`domain/types.ts`) + pure helpers in `domain/naming.ts`; every `describe*` takes an optional trailing `book?: NameBook` and, without one, renders raw ids byte-for-byte as before. `NameBookCache` (`services/nameBook.ts`) behind the `INameBook` port is injected into the three services as an optional trailing constructor parameter. | `docs/naming.md` |
| **Track Editor authoring** (#69, #94, #103 PR 6) | Canvas extent derives from content plus a margin — there is no fixed grid to hit, and `MAX_COORDINATE` is admission control, not an edge. Undo is client-side and **per stroke**, so a stray right-drag is one click to reverse; it is never persisted. `⌂` fits content. Pan/zoom persist per layout. The canvas is keyboard-navigable (`role="application"`): a `cursor` state moves on arrow keys, paints on Enter/Space, erases on Delete, and Escape exits to the toolbar; one `aria-live` string (`diagram/cursorAnnouncement.ts`) is both the visible readout and the screen-reader announcement. Ruler gutters and a crosshair give a persistent spatial reference; diagnostics with a coordinate (`diagnosticCoordinate`) are click-to-jump buttons, and `jumpToCell` is the one implementation any surface naming a cell uses. **Nothing about a compiled opening is drawn on the canvas** (D15): the boundary tick, the `⊣` stop glyph and the label that #103 step 6.1 added are all gone, with `diagram/openings.ts`, `portMarkGeometry`, `computePortsAtCell`, `computeOpeningsAtCell` and `OPENING` in `encoding.ts`. D-H's argument was about *authoring* — a mark at the wrong boundary is visibly wrong where a plausible label is not — and it lapsed once the graph was compiled and applied: an opening's name is disposable output nobody reads off the diagram, and the check moved to the compile diff under review. `GET .../grid/openings` is still read, for the **keyboard readout alone** (`computeOpeningsAtCursor`), which still says `opening yard-3 at the east boundary, buffered`; the Edges tab and compile diff keep the labels that mean something. **`Ends ⟳` and `Ends ✎` are gone** (#103 PR 6.2), with `BlockEndsPanel` and `useBlockEnds`: both existed only to reconcile a stored copy of the opening names with the drawing, and there is one copy now. Nothing in the browser reads `block_ends`. Two rules survive the panel and apply to whatever comes next: a list of controls, never a click on the drawn label (the canvas is `role="application"` and a click there paints), and one shared `jumpToCell`. | `docs/track-editor.md` D15 |
| **Diagram encoding** (#81, #68, #93) | `diagram/encoding.ts` is the single source of track-diagram colour; every state ships a pattern/glyph/label so colour is never the sole carrier. Block tints are **four** validator-checked colours assigned by graph colouring over adjacency (`diagram/blockRuns.ts`), marking block *boundaries* — a tint never identifies a block, the label does. Don't add a fifth tint: it fails CVD checks. A point is labelled **once per point** by its identifier (`diagram/pointLabels.ts`), because a point is drawn as two tiles sharing one `pointId`. A run label lies **along** diagonal track (`trackAngle`, `docs/track-editor.md` D19) — only for a tile drawing one leg, only at ±45°, and never turned past upright. | `docs/diagram-encoding.md`, `docs/track-editor.md` D10, D19 |
| **Track grid** (#70, #71, #73, #74) | `grid_tiles` is the Track Editor's *drawing*, not the track model — no domain decision reads a tile. Writes go through `GridService` (layout existence; `blockId`/`pointId`/annotation ids resolve **in this layout**) behind `gridTileWriteSchema`: closed `tileType` enum, bounded coordinates, and a **closed** `metadata` schema every later field must be added to. `metadata` now also carries `trackRole` (#71 — only ever asserts *decorative*; `classifyTile` derives the three-way state), `annotations` (#74 — generic `{entityType, entityId}` list, never assume "sensor") and `pointRoads` (#73 — leg-list shaped, keyed by a position *tuple*, so slips and three-ways stay open). Rejections are 400/404 — never Safe-Stop. | `docs/track-grid.md` |
| **Grid diagnostics** (#84, #83, #71, #91, #92, #103) | `GET .../grid/diagnostics` — read-only, advisory, never a gate. `warning` = two representations disagree or a hazard is drawn (**`buffer-contradicted-by-edge`**, dangling reference, duplicate annotation, drawn plain diamond per #26, `track-not-joined` per #91); `info` = authoring unfinished (unclassified tile, unmapped point tile). A finding must be one the operator can act on: `point-tile-unmapped` gates on `depictsPoint(tileType)`, because a point is drawn as two tiles and only one has legs to map. **The five end-related findings are down to one** (#103 PR 7): three described states a stored `block_ends` label could be in and cannot occur now; `end-unfinished` and `block-without-detection` were **promoted to compile gaps**, where they refuse `auto` instead of merely advising. That inversion is the rule — a diagnostic compares two representations that may legitimately disagree mid-authoring, a gap says the compiler is not confident, and only the second gates. Nothing in `domain/` reads a tile. | `docs/track-grid.md` D11 |
| **Track graph compilation** (#103) | `services/trackGraphCompiler.ts` compiles the drawing to a **whole candidate graph plus its gaps** — pure, both directions from the walk, **never mirrored** (#104). It asserts over its own output, not the walk: a block in no edge, a block with no in-service detection, an unresolved opening (D7). Components are **reported, never gated** — two separate railways are legal. Two reads, split by cost: `GET .../grid/openings` (geometry only, per stroke) and `GET .../topology/compile` (full search, on review) — neither admin-gated, neither able to Safe-Stop, 404 on a bad layout and **409** over `MAX_COMPILED_EDGES`. `compiled_graphs` stores one fingerprint row per layout; a **missing row** is "never compiled"; `annotations` are excluded from the hash so moving a sensor marker cannot stale a review. The diff matches in **two passes** — exact ends first (`unchanged`/`changed`), then the physical connection (`relabelled`) — because labels are disposable and a label-keyed diff reads a rename as a full replacement. `POST .../topology/compile/apply` is the write: admin-only, body carries a **fingerprint and nothing else** (a body with rows is a 400 — an apply that took edges would be a second authoring path), recompiles and refuses on mismatch, then `TopologyService.replaceGraph`. **Refuse first, write second** — any held route (`findAnyHeldRoute`, not per-edge, because every label is regenerated), the edge cap, then `validateTopology` over the whole candidate set, and only then one transaction. `duplicate-connection` keys on the same tuple as `block_edges_connection_unq`, so the OQ7 point-in-a-block collision is a **named 422 before any write**, not a SQLite failure mid-batch. Gaps never refuse an apply — they gate **`auto` and `hybrid`** at `handleSetMode` (not inside `canIssueAutoCommand`, which stays a pure two-enum predicate on the hot path), read live through `IGraphCompletenessView`; `reloadTopology` drops an automatic mode to `manual` when the graph goes gappy underneath it, suspending auto routes, **never Safe-Stopping**. The inert default gates nothing — an unwired service was told nothing about completeness. `GET .../topology` carries a `compiled` block; staleness **warns and never gates**, and is deliberately **not** on the MQTT/WS `system/status` payload, which is binding. The compiler is the **only** writer of `block_edges` and the only source of an opening's name; `block_ends` and everything that read it are deleted. **The review is `CompilePanel` (Configure → Edges)**: fetches on first open only, **gaps above the diff** (D7 — "Fiddle Yard 2 has no connections" outranks a cell note, `diagram/compile.ts#gapRank`), diff grouped `changed`/`added`/`removed`/`relabelled`/`unchanged` with `changed` first, and **one `Apply`** — no per-row accept, because a recompile is a replace and accepting one row authors a graph the drawing does not describe. Apply is disabled on an empty **or relabel-only** diff (`hasSubstantiveChange`). A 409 renders "the drawing changed, re-compile" with a button and **never auto-retries** — an automatic retry is the client approving a graph no human saw. Applied to the live layout 2026-08-14: 90 tiles and 9 blocks to 22 edges, one component, no gaps. | `docs/topology.md`, `docs/track-graph-compilation.md` |
| **One renderer, and the live mimic** (#75, #63, #82) | `TrackDiagram` is the **only** thing that draws the railway. `GridEditor` composes it with authoring chrome and passes no live state; `MonitorView` composes it with a `live` prop and no-op handlers. A second renderer is the failure mode #75 exists to prevent — on a diagram whose purpose is being trusted at a glance, divergence is not cosmetic. Supporting extractions: `diagram/tilePaths.tsx`, `diagram/diagramModel.ts` (pure derivations), `hooks/useDiagramViewport.ts` (pan/zoom + the load-bearing StrictMode-safe persistence guard — move it verbatim, an e2e spec caught it once). **State wins the colour channel**: where live state is drawn the `BLOCK_TINTS` identity wash is not, and the run label becomes the only thing naming a block. Occupancy is a fill + hatch and a commanded road is solid vs dimmed vs dashed-indeterminate — over a point tile whose **own roads are drawn faint** (`POINT_BASE_OPACITY`, live only), because the overlay only ever *added* a highlight and a point standing reverse still drew its normal road as connected track. **A route is a coloured line along the track it holds** (#129, `diagram/routePaths.ts`), drawn under the track and wider — a halo — inside each tile's group, because every tile paints its own opaque background and a layer beneath them all would be invisible. The segments come from a **walk**, not a wash (`docs/liveness.md` M9): seeded at the joins between held blocks and followed leg to leg, taking only the road a point hold selects, because a block is not a piece of track — washing the destination block lit the road out of it that the route had held shut. The walk's state is a **port** (cell + boundary entered by), which is what keeps a crossing from reading as a junction (#26). Two fallbacks, both drawing *more*: an unresolved point tile stays traversable, and a block the walk never reaches is washed whole. The renderer draws in **three layers** — every wash, then every route halo, then every piece of track and text — because one group per tile means a tile's opaque background erases its already-drawn neighbour's halo, which on a 45° run showed as a waist at each tile edge (the "carriages"). A halo is wider than a tile boundary is thin; nothing that crosses a boundary can live in a per-tile group. Sleepers were blamed for this first and are **not** the cause: they stay. **Decorative track is not dimmed where `live` is present**: "unfinished" is an authoring question, and the absent occupancy wash already says the system cannot see it. It **replaced** the dashed `perimeterEdges` outline rather than joining it: the outline could say "held" but never "held by which", and it is drawn from the same `lockedByRoute` field — a step is drawn only while its block still reports this route's lock — so the two cannot disagree. A route highlight drawn *in addition to* a lock outline would still be two marks for one fact, and is still refused. Identity is hue **and** dash (`ROUTE_TINTS` = `BLOCK_TINTS`, free because state takes the colour channel; the two never share a surface); `active` and `suspended` both draw. Decorative cells between blocks come from `CompiledEdge.via` — the monitor reads `GET .../topology/compile` **once** at mount and joins `RoutePathStep.edgeId` → `block_edges` row → connection tuple → `via`; an unresolved join draws a **gap and says so in the key**, never a guessed path. Position stays block-granular: no train at a spot, nothing animated between blocks (`docs/braking.md` B7). A **point lock** is `LOCK.glyph` **beside the point's name**, in the same `<text>` — once per point, the same mark a locked block's label carries, and **not** gated on label density, because a lock is state and "Labels: off" is an authoring control (M7); with labels off it draws alone. In the tile's corner it was a mark with nothing tying it to a point. The **point key** (`PointKeyPanel`, `diagram/pointKey.ts`, M6) is a collapsible panel the operator **drags over the canvas** — that inverts M6's original "beside, never over", because a fixed column covers track permanently and everywhere while an overlay covers only what the operator puts it over. Clamped inside the canvas on every move (a panel dragged off the edge cannot be dragged back), arrow-key movable, sized to its content. It resolves the `shortPointLabel` abbreviations a wall display cannot hover, plus commanded position and holder; monitor-only, position and collapsed state persisted per layout, and a point with no live state reads `unknown` rather than `normal`. Occupants are a **list** so #39 populates it rather than reshaping consumers. Liveness is one word derived once in `App` (`useConnectionHealth`) and handed down; stale or disconnected **covers the canvas**, never a badge, and stacks with Safe-Stop. | `docs/liveness.md`, `docs/diagram-encoding.md` |
| **Monitor e2e** (`tests/e2e/monitor-view.spec.ts`) | The one spec that mounts the monitor. Its fixture is Westgate Hollow's Engine / Goods Transfer corner — a 45° staircase block, two connective cells belonging to no block, and a point *inside* the destination block — because that shape is what every claim on this view is about. It reads the rendered SVG back in one `evaluate` (which cells carry a route line, what opacity the track under them is drawn at, what the labels say and how they are turned) rather than one locator per assertion: the diagram is one picture and the facts worth pinning are relationships between its layers. | `docs/liveness.md` |
| **Point position feedback** (#25 PR A) | A point can now say where it **is**, not just where it was told to go. `PointState.position` is deleted, not deprecated: `commandedPosition` (what we sent, `null` if never), `confirmedPosition` (what came back, `'unknown'` until it does) and a six-state `confirmation` replace it, and **`effectivePosition` (`domain/pointConfirmation.ts`, D7) is the one place that decides which is trusted** — `'required'` trusts `confirmedPosition` and nothing else, `'none'` falls back to commanded exactly as the whole system did before. It is deliberately **not** consumed by the pathfinder (`docs/pathfinding.md` P3 stands). Ingestion is one wildcard subscription to `point/+/reading`; **neither `reading` nor `query` is retained**, and the asymmetry with the retained `sensor/*/reading` is the load-bearing decision (D1): occupancy self-corrects on the next train movement, a point's position is re-asserted by nothing and can change while its controller is off. Restart recovery is a live `query`, never a broker cache, and **nothing about a confirmation is persisted** — a database row is a retained message with better durability (D2/D10). A **command** arms the 8 s deadline; a **query never does** (D6), so an unanswered query at boot leaves the point `unknown` without faulting, symmetric with how block occupancy already boots. The timeout is a pure predicate over a 250 ms sweep on the injected `IClock` (which gained `setInterval` for it) — both halves are needed: a lazy predicate emits nothing, and a per-command `setTimeout` cannot be exercised by the scenario harness. Faults are latched in `SystemHealth.pointFaults`, keyed by point, **every kind Safe-Stopping**, in the priority slot between sensor and route faults; the escape hatch is `positionFeedback: 'none'`, which is why a two-tier "some point faults halt the layout" model buys nothing. `points.position_feedback` defaults `'none'` with **no CHECK constraint** (D10) so the live layout is byte-identical after the migration. `SimulatedPointController` is a fake **ESP**, not a fake DCC callback (D9) — it subscribes to `point/+/query` over the real port, so the tests exercise the contract rather than a private channel. The UI states the guarantee **per point**, because per system it would be false. **PR B gives the failure a route** (D8): `RouteFaultKind` gains `'point-not-confirmed'` and `RouteFault` gains a `pointId` beside its `blockId` — an operator told a route is suspended is told *which point*, and a point is not a block. A held point going `timeout`/`mismatch`/`indeterminate` stops that route's loco **unconditionally** (not only under `auto` authority, matching `handleRouteOccupancyUnknown`) and latches **both** faults: "this point motor is dead" and "route R's road is no longer known to be set" are different facts, resolved by different actions. The three kinds are the whole list — `malformed-payload` and `id-mismatch` leave the confirmation untouched, so the road may still genuinely be set. **`resumeRoute` refuses against the latched fault, never against `confirmation === 'pending'`** — a `pending` check deadlocks, because resuming re-commands every held point and makes each one `pending` again. | `docs/point-feedback.md` |
| **Per-loco braking** (#6) | A model plus an **explicitly-invoked** execution surface — nothing decides *when* to brake, which is the whole #6/#7 boundary. `brakingFactor` means dimensionless *effectiveness* scaling `REFERENCE_STOPPING_DISTANCE_MM` quadratically in normalised speed (B1); callers depend on the `StoppingDistanceModel` **function type**, never the scalar formula, so a measured curve replaces it without touching one (B2). `domain/braking.ts` is pure: a `BrakingSchedule` is a linear step-down, 8 steps per 250 ms tick, **loco-independent** — `brakingFactor` predicts *distance*, it does not shape the ramp (B3). Available distance is the sum of `blocks.length_mm` over the **intermediate** steps only (B4); an unmeasured block **refuses**, and `DEFAULT_BLOCK_LENGTH_MM` must never be reused here — guessing a cost steers a search, guessing a stopping distance is a collision. `BrakingService` plans; `LayoutService` executes against the injected `IClock` as **one chained timer**, step 0 awaited inline so a first-command rejection can answer `started: false` *and* latch a fault (B12). B5's overrun expectation is a snapshot armed after step 0 and **outliving the ramp** — reaching speed 0 is a command, not a confirmation — cleared by a manual throttle, its route leaving `active`, a new run, or firing. It is checked in `recomputeBlock` **before** `onOccupancyChange`, which is what makes an overrun latch *two* faults (braking + the route's `unexpected-occupancy` cancel) instead of letting the route read `completed` — the false success the check exists to prevent. `SystemHealth.brakingFaults` is keyed per loco, latched, **no arming threshold** (a Safe-Stopped loco cannot prove itself), between point and route faults. Every ramp is aborted **before** any `emergencyStop()` broadcast. B7's #25 forward reference is built: a plan refuses `point-not-confirmed` on a held point whose `effectivePosition` is not the required one — inert for `'none'` points, so the live layout is unchanged. `POST .../locos/:address/brake` is B8's calibration stimulus (409 + structured reason on refusal); `GET .../braking-faults` and `POST .../locos/:address/acknowledge-fault` mirror the sensor/route pattern. No MQTT or schema change (B9). | `docs/braking.md` |
| **Sub-block sensor position** (#77 PR A) | A sensor may say **where in its block it is**, and — far more carefully — what may be concluded from one having been broken. `sensors` gains `position_toward_block_id`/`position_offset_mm`: `offsetMm` of track before the boundary its own block shares with a **neighbouring block**. **The anchor is the whole decision** (D2). #77 as filed said `(blockId, endLabel, offsetMm)`, and #103 took that vocabulary away — an end label is regenerated by every compile, so a stored one comes to name a *different* end after an innocuous redraw. The issue's own three replacements are all rejected: a **port** anchors a measurement of the railway to a picture of it (moving a tile does not move a beam), an **edge id** is rewritten wholesale by every apply for the same reason a label is, and **store-and-diagnose** fails quiet. A block id is operator-owned and the compiler never rewrites it. `null` = unmeasured = exactly today's B4 worst case (D3); only an `ir_position` sensor may carry one (D4); a self-anchor, a missing block, or an offset longer than the block is a **400, never a Safe-Stop**. **The fix is the rising edge and nothing else** (D6): a repeated `occupied` moves `lastReadingAt` and deliberately not `lastRisingEdgeAt`, or a device re-publishing on a timer would look like it kept re-seeing a train. It **decays by a worst-case travel allowance** (`MAX_CREDIBLE_SPEED_MM_PER_S`, D7), not a freshness cliff — subtracting a deliberately generous speed can only *understate* the distance, and an old fix falls to zero on its own. **A clear beam still clears nothing** (D8): `deriveBlockOccupancy` clause 3 is untouched, and the tempting "but we know where the beam is now" simplification is refused in the decision record, not merely in a comment. Ambiguity resolves to *unmeasured*, never a guess (D5) — two blocks joined in two places, joined nowhere, or a half-set row left by `ON DELETE SET NULL`, which reads as unmeasured rather than as corruption (the one place `parseSensorRow`'s corruption-must-throw posture is deliberately not applied). Nothing about a fix is persisted (D11). **Nothing consumes one yet**: `leadDistanceMm` is D9's whole rule waiting for PR B, so the live layout is byte-identical. | `docs/sensor-position.md` |
| **Sensor simulation** (#65) | Flag-gated (`SENSOR_SIMULATION`, off by default) bench tool: `SensorSimulationService` publishes a fabricated reading to the sensor's own `mqttTopic` and the broker echoes it back through the ordinary ingestion path — byte-identical to hardware, no marker field. `GET /api/capabilities` gates the Operate-pane panel and fails closed. | `docs/sensor-simulation.md` |

### Traps

Things that look like bugs or oversights and are not. Each was a deliberate decision:

- **A point `command` arms the confirmation deadline; a `query` deliberately does not** (#25,
  `docs/point-feedback.md` D6). It reads as an inconsistency and is the opposite: a fault means
  something the backend *commanded* did not happen as promised, while an unanswered query just
  leaves the point where it already was — `unreported`, position `unknown`, untraversable, no
  Safe-Stop. Arming on query would halt the layout at boot for any instrumented point whose
  controller happened to be powered off, before an operator had done anything at all. A block
  reading `unknown` at boot does not Safe-Stop either; point position is symmetric with that.
- **A `retained` point reading is dropped with a warn rather than faulted**, even though the
  contract says retain false and a firmware that sets it is buggy. It confirms nothing and arms
  nothing towards clearing a fault, so the point times out on its own schedule — which is
  self-announcing and correct without a special case. A malformed or id-mismatched payload
  still faults, retained or not.

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

- **The drawing↔graph model has been replaced (#103, `docs/track-graph-compilation.md`).**
  Accepted 2026-08-13, shipped and applied to the live layout 2026-08-14. D4/D5 (#105 — length
  is on `blocks.length_mm`, joints are zero), the #104 fix in the walk, the compiler, both
  read surfaces, the apply, the `auto` gate, the review UI, the Track Editor's side of it,
  and — as of PR 7 — the deletion of `block_ends`, `BlockEndService`, its routes, six
  repository methods, `generateBlockEnds` and four of the five end diagnostics. **The
  compiler is the only writer of `block_edges` and the only source of an opening's name.**
  The root fault it fixed: `block_ends.label` was both the join key `block_edges`
  references and a geometry-derived description, and `pinned`, the rename 409, adoption
  and the collision refusal were all that conflict surfacing. Both proposed fixes stay
  **rejected** — the anchor coordinate (#97) and a 16-point bearing — because the question
  they answered stopped being asked. `docs/plans/103-track-graph-compilation.md` carries a
  "Shipped, with notes" block per PR recording what differed from the plan.
- **A braked run to the *immediately next* block is refused, not slowed** (`D-K`,
  `docs/braking.md` B4). With length on blocks there is no intermediate block between the
  confirmed one and the next, so available distance is zero and `insufficient-distance`
  fires. Correct under block-level occupancy — the train may be hard against the exit —
  and the fail-safe direction, but it is a behaviour change from the edge-length model.
  Fixing it needs sub-block position (#77), not a fudged distance. **#77 is therefore a
  prerequisite for #7, not a later refinement** (operator's call, 2026-08-16): Westgate
  Hollow has nine blocks and most routes are two or three steps, so "slow on approach to
  the block ahead" — #7's central move — would refuse in the common case without it.
  **#77's model has landed and this limit still stands verbatim** — PR A is measurement,
  storage and `leadDistanceMm`; nothing calls it. `remainingRouteDistanceMm` gains its one
  optional lead term in PR B, and only then does an adjacent target stop refusing.
- **A point lock is an authority guarantee, and now a position guarantee too — but only for
  points configured `positionFeedback: 'required'`** (#25 PR A). For a `'none'` point the old
  statement stands verbatim: the lock promises no other authority will command it, never that
  the blades moved. That per-point split is the whole reason the config column exists, and it
  is the honest thing to say while Westgate Hollow has no feedback fitted yet — every point on
  the live layout is `'none'` until an operator changes it, so **nothing about the live layout's
  behaviour has changed**. #25 is complete in this repository (PR A the channel, PR B the route
  interaction); what is outstanding is **firmware**: nothing answers a `point/*/query` yet, and
  no point has a feedback switch wired. See `docs/project-plan.md`.
- **Two routes fouling at a plain (non-switched) diamond crossing is not caught**, since
  neither shares a block or a point (#26). Westgate Hollow has none today; the editor now
  says so when one is drawn (`diamond-blind-spot`), which is a warning, not a fix.
- **A point tile's leg mapping is unverifiable authored data.** Nothing can check which
  way round a physical point is wired, and `pointConditions` carries no geometry to check
  it against (`docs/track-grid.md` D9).
- **`end-label-collision` is closed, and both proposed fixes stay rejected.** Not a
  limit any more — kept because the shape recurs. Westgate Hollow's one collision
  (`Engine / Goods Transfer`, two openings both bearing south-east) is the case #103 was
  named after: `generateBlockEnds` refused to name *either*, so a real, drawn, trafficable
  opening was unreferenceable and **naming failure became routing failure**. The applied
  live graph carries `southeast-1 → Engine Shed 1/2` and `southeast-2 → Goods Shed`.
  An anchor coordinate (#97) and a 16-point bearing were both **rejected** and neither was
  needed: the refusal existed only because the label was an identifier, and a disposable
  description may be guessed at freely. Reach for that argument before making any derived
  name referenceable.
- **Westgate Hollow's classification pass is done** — 0 unclassified tiles, every block
  with in-service sensors — so `unclassified-tile` and `block-without-detection` are both
  silent on the live layout. That is a finished authoring pass, not a broken check. The
  drawing compiles to a **single connected component with no gaps** — 90 tiles and 9
  blocks to 22 edges and 19 openings. **The operator has applied it** (2026-08-14): the
  live `block_edges` holds those 22 rows and `compiled_graphs` carries the matching
  fingerprint, so the graph is no longer stale and the layout no longer refuses `auto`
  for want of one. Counts measured against a copy of the live DB taken with its `-wal`;
  prefer a fresh measurement over any quoted here.
- **Read the live DB with its `-wal`, or you will read a stale layout.** `data/layout.db`
  is in WAL mode and the log runs to megabytes, so copying the `.db` alone silently drops
  recent drawing edits. It cost a round of wrong conclusions here: tiles the operator had
  marked decorative read as unclassified, the graph came out in three components with
  eight gaps instead of one and none, and an apparent unique-index conflict was reported
  as a blocker that does not exist. Copy `layout.db`, `layout.db-wal` and `layout.db-shm`
  together, and prefer specific counts measured at the time over any quoted in this file.
- **Two hand-maintained duplicates across the wire**, and **#75 did not close them**:
  `findBlockRuns` in `services/gridGeometry.ts` (backend) and `diagram/blockRuns.ts`
  (frontend, tints and labels); and `TILE_LEGS` in `services/tileGeometry.ts`, mirrored by
  `diagram/trackGeometry.ts` (frontend). A change to one wants the other. This file used to
  attribute them to "#75 to unify", which conflated two different problems: #75 was the
  **editor↔monitor** seam *inside* the frontend, and it is done. These are
  **backend↔frontend** and need a shared workspace package spanning a CommonJS backend and an
  ESM frontend — a larger and riskier change that nobody has scoped. `HEARTBEAT_INTERVAL_MS`
  in `domain/liveness.ts`, mirrored in the frontend's `types.ts`, is a third of the same shape
  and for the same reason. `effectivePosition` in `domain/pointConfirmation.ts` (backend, #25
  D7) is a fourth, mirrored verbatim by `diagram/pointConfirmation.ts` (frontend): the same
  `'required'`-trusts-`confirmedPosition` / `'none'`-falls-back-to-`commandedPosition` rule has
  to agree on both sides of the wire, or a point's live-diagram road and its point-key/Layout-panel
  reading would silently disagree about what is trusted.
  **Two of these changed shape** (`docs/track-editor.md` D16). `EDGE_OFFSET`'s mirror was
  **closed** when the opening marks went (D15) and is **open again**, in
  `diagram/trackGeometry.ts` with `rotateEdge` and `oppositeEdge`: the route line walks the
  road through a block (`docs/liveness.md` M9) and a walk has to know which neighbour an edge
  faces. `trackGeometry.test.ts` asserts the offsets literally, as it does the leg pairs.
  And the `TILE_LEGS` mirror was `DRAWN_LEGS` in `diagram/pointRoads.ts`, *two rows* of
  the table, free to drift from both the backend and the paths `TilePath` drew; it is now the
  whole table in one file, with `trackGeometry.test.ts` asserting the pair list literally so a
  backend change fails a test here rather than quietly producing a diagram that disagrees with
  the compiler. Still a duplicate — but a complete, tested one.
- **The pathfinder does not search around a point-position conflict**, so a path can exist
  that it will not find (P5 in `docs/pathfinding.md`).
- **Driving a granted route is manual.** #4 sets and reserves the road; it does not drive
  the train.
- **Lock messages name the route id, not the train holding it** (D3 in `docs/naming.md`) —
  a route has a different invalidation lifetime from the rest of the `NameBook`.
- Phase 3's remaining work is **collision avoidance and speed control (#7)**, which needs
  sub-block position (#77) first — see the braked-run limit above. Per-loco braking (#6) is
  complete: what it deliberately does not do is decide *when* to brake. #77 is **partly
  done**: PR A landed the model, PR B is the braking consumption and PR C the authoring
  form (`docs/plans/77-sensor-position.md`). The scenario harness (#5) shipped long ago and
  its issue is closed.
