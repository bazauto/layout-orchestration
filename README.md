# Layout Orchestrator

Model railway layout orchestration for the Westgate Hollow project.

This repository contains a local-first control stack for a DCC-based layout:
- A Node.js backend for layout state, MQTT integration, DCC control, SQLite persistence, REST APIs, and WebSocket updates
- A React frontend for operating the layout, editing topology, and configuring blocks, sensors, points, locos, and track tiles

The project is currently in the layout-definition and operator tooling phase. Route
reservation, locking, and pathfinding have landed (see Current Status); a granted route
reserves its track and sets its points, but driving the train along it is still manual.
Braking models, collision avoidance, and scheduling are planned next.

## Current Status

Implemented:
- Backend domain safety and state logic
- MQTT and DCC adapter abstraction with simulator support
- SQLite persistence via Drizzle ORM with auto-migrate on startup
- REST API for layouts, locos, blocks, points, sensors, and grid tiles. The track graph
  (`block_edges`) is **read-only over REST** — it is compiled from the drawing and applied
  whole, so there is no edge create/update/delete surface (#103)
- Topology validation with Safe-Stop on an invalid graph, and operator recovery by
  re-compiling the drawing
- Safe-Stop on a malformed sensor payload (a message on a `sensor/*/reading` topic that
  fails Zod validation, including a non-JSON payload), naming the sensor and topic in the
  reason — latched per sensor (`SystemHealth.sensorFaults`, keyed so acknowledging one
  fault never silently clears another the operator was never told about), with two
  operator recovery paths: three consecutive valid readings arm an acknowledge, or the
  sensor can be marked out of service — see `docs/sensor-fault-recovery.md`
- Block occupancy is derived from every sensor registered against a block, not
  last-write-wins — an `ir_position` sensor may raise occupancy but never clear it on its
  own, only a `block_detection` sensor can (`domain/occupancy.ts`)
- Route reservation and locking engine — grant/cancel/suspend/resume over an
  explicit ordered path, exclusive block/point locks with progressive
  release, Safe-Stop suspension and restart recovery — see `docs/route-locking.md`
- Route pathfinding — a direction-aware shortest-path search over the block graph
  (state is *block plus the end entered by*, so no path can require a reversal), which
  will not route over a block that is occupied, unknown, or held by another route, nor
  over a point another route holds. A granted route then has its points thrown; a point
  command the DCC adapter rejects invalidates the whole route and Safe-Stops — see
  `docs/pathfinding.md`
- Latched route faults (`SystemHealth.routeFaults`) with per-route operator acknowledge,
  covering an unexpected occupancy, a rejected point command, a reserved block whose
  occupancy stops being determinable mid-route, and a held point that fails to confirm
- Point position confirmation (#25) — a point controller reports its observed position on
  `point/{pointId}/reading` (never retained; restart recovery is a live `point/*/query`),
  and the backend keeps *commanded* and *confirmed* position as separate fields. Opt in per
  point: `positionFeedback: 'required'` means commanded position is no longer trusted on its
  own, and a point that fails to confirm within 8 seconds latches a fault and Safe-Stops —
  see `docs/point-feedback.md`
- WebSocket state streaming to the frontend
- Local username/password authentication with role-based access (`admin` /
  `operator` / `monitor`) — see `docs/auth.md` for the scheme and its threat model
- Full user and role management (#53): an admin can create, list, change the role of,
  and delete accounts, and reset another user's password, from the Configure screen's
  Users tab or `GET|POST /api/users` / `PATCH|DELETE /api/users/:id`; any logged-in user
  can change their own password (`POST /api/auth/change-password`). Deleting or
  demoting the last `admin` account is refused at both the service layer and the
  database (a trigger pair, since "at least one must exist" isn't expressible as a
  unique index) — see `docs/auth.md`
- Monitor role (#63): situational awareness with no authority to move anything. The
  WebSocket transport captures the connection's role once at the upgrade and refuses a
  monitor's driving commands with an `ERROR` reply, never a socket close;
  `EMERGENCY_STOP` stays available to every role. The purpose-built frontend view is a
  later PR — see `docs/auth.md` "The monitor role"
- Connection-health heartbeat (#82): a periodic application-level `HEARTBEAT`
  `ServerMessage` (not a protocol-level `ws` ping, which the browser can't observe) so a
  client can tell a frozen socket from a quiet layout. The frontend staleness indicator
  is a later PR — see `docs/liveness.md`
- Frontend login screen; the rest of the UI requires an authenticated session
- Role-scoped navigation (#61, #63): `admin` gets Operate, Monitor, Track Editor and
  Configure; `operator` gets Operate and Monitor; `monitor` gets Monitor alone. The
  authoring screens are **absent** for a non-admin rather than disabled — affordance
  only, with `requireAdmin` and the WebSocket role gate as the actual enforcement
- Monitor view (#63, #75, #82, #129): a read-only live mimic drawing block occupancy,
  commanded point roads and which loco is where, on the **same** renderer the Track
  Editor uses. A set route is a coloured, dashed line **along the track it holds**,
  through the decorative sections between blocks too, with a key naming each route by
  its loco — several concurrent routes are told apart by hue and dash, not hue alone.
  A point key beside the canvas resolves the abbreviated point names and shows what
  each point is set to and who holds it. Connection health is always on screen, and a
  stale or disconnected diagram is covered rather than badged — see `docs/liveness.md`
- Frontend operate screen for throttle, points, and live state
- Frontend configuration screen for blocks, sensors, points, locos, and edges
- Track editor with tile palette, rotation, keyboard shortcuts, hover ghost preview, and persistence
- Backend unit/integration/scenario tests and Playwright frontend end-to-end tests
- GitHub Actions CI

Planned next:
- Per-loco braking model (#6) and collision avoidance (#7) — driving a granted route
- Automation engine / schedules

## Workspace Layout

```text
.
├─ packages/
│  ├─ backend/   # Fastify, MQTT/DCC adapters, domain logic, DB, tests
│  └─ frontend/  # React + Vite operator/config/editor UI
├─ tests/
│  └─ e2e/       # Playwright end-to-end tests
├─ .github/
│  └─ workflows/ # CI
└─ docs/         # Project notes and contracts
```

## Requirements

- Node.js 20+
- npm
- Optional for hybrid/full hardware modes:
  - MQTT broker (for example Mosquitto)
  - DCC EX serial controller

## Installation

```powershell
npm install
```

## Environment

Copy the example file and adjust values as needed:

```powershell
Copy-Item .env.example .env
```

Important mode flags:

- `USE_SIMULATOR=true` → full simulator, no broker and no hardware required
- `USE_SIMULATOR=false` + `DCC_SIMULATOR=true` → hybrid mode, real MQTT broker + simulated DCC
- `USE_SIMULATOR=false` + `DCC_SIMULATOR=false` → full hardware mode, real MQTT broker + DCC serial controller

Default local development is typically best in hybrid mode.

`SENSOR_SIMULATION=true` exposes a bench-testing panel and API that FABRICATE sensor
readings — off by default; **do not enable on a live layout**. See
`docs/sensor-simulation.md`.

`INITIAL_ADMIN_PASSWORD` is required the first time the backend starts against
an empty database — it bootstraps a single `admin` account and the backend
refuses to start without it. That first admin can then create every other
account — including `operator` accounts, which nothing before #53 could
produce — from the Configure screen's Users tab; `npm run bootstrap-admin
--workspace=packages/backend` remains the CLI break-glass path for resetting
a forgotten password without going through the UI. See `docs/auth.md` for the
full scheme (sessions, roles, user management, CORS, and the pre-TLS threat
model).

## Running Locally

Start backend:

```powershell
npm run dev:backend
```

Start frontend:

```powershell
npm run dev:frontend
```

Frontend runs on Vite's dev server and talks to the backend on port `3000`.

## Database

The backend uses SQLite with Drizzle ORM.

On startup the backend automatically applies pending migrations from `MIGRATIONS_PATH`.

Useful commands:

```powershell
npm run db:generate --workspace=packages/backend
npm run db:migrate --workspace=packages/backend
npm run db:push --workspace=packages/backend
npm run db:seed --workspace=packages/backend
```

`db:seed` creates a useful starter layout with:
- blocks
- points
- sensors
- locos

## Testing

Run all workspace tests:

```powershell
npm test
```

Run lint:

```powershell
npm run lint
```

Run Playwright end-to-end tests:

```powershell
npm run test:e2e
```

Current automated coverage includes:
- backend domain unit tests
- backend service tests
- backend HTTP route integration tests, including authenticated/unauthenticated
  and role-enforcement paths (logging in for real via Fastify `inject()`, not
  a bypass), a real end-to-end authenticated WebSocket upgrade, and WebSocket
  broadcast delivery — that an event emitted *after* connect actually reaches
  every connected client, which the initial-snapshot test cannot prove
- backend scenario tests (`packages/backend/tests/scenario/`) covering topology Safe-Stop
  and recovery paths, malformed-sensor-payload Safe-Stop (#27), and per-sensor fault
  recovery — latching, premature-recovery refusal, retained-replay exclusion, arming and
  acknowledge, out-of-service, degraded (IR/detector) operation, and the regression guard
  that an IR `clear` cannot release a route's holds (#34); and pathfinding — a grant by
  destination that sets its points, routing around an occupied block, an unreachable
  destination, a conflicting request, a DCC-rejected point command, a reserved block going
  unknown mid-route, and the regression guard that a route Safe-Stop is latched and does
  not clear on an unrelated health evaluation (#4)
- Playwright tests for editor happy path, erase flow, keyboard shortcuts, keyboard-only
  grid navigation (canvas focus, cursor movement, paint/erase at the cursor, and jumping to
  a diagnostic's cell — #94), no-scrollbar viewport regression, the compile review panel
  (including the failure path where the drawing moves between review and apply), and the
  login screen

## Frontend Features

### Operate
- System status bar
- Emergency stop
- Mode selection
- Loco throttle with roster dropdown
- Live block and point state display
- Sensor-fault banner: lists every latched fault with its reason and an Acknowledge action
  (enabled once armed — see `docs/sensor-fault-recovery.md`)
- Routes panel: request a route by loco, start block, and destination (the backend finds
  the path); live routes with their progress along the path, Cancel, and Resume; latched
  route faults with Acknowledge. A refused request shows the backend's reason — "no route
  exists to block 4 — block b2 is occupied" — and leaves the form populated
- Sensor simulation panel (#65): visible only when the backend has `SENSOR_SIMULATION=true`
  and reports it via `GET /api/capabilities` (fails closed on any error). Injects an
  occupied/clear reading, a canned-malformed payload, or a retained-clear at a chosen
  sensor, through the same MQTT round trip real hardware uses — see
  `docs/sensor-simulation.md`

### Configure
- CRUD for blocks, sensors, points, and locos. **Not edges** — see the Edges tab below
- Inline editing
- Sensors tab: an In service toggle per sensor (marking a dead device out of service clears
  its latched fault and stops the system trusting it)
- Edges tab: a read-only list of the track graph, plus the compile panel that writes it.
  A violation banner surfaces an invalid topology. There is no edge form — `block_edges`
  is compiled from the drawing and has exactly one writer (#103)
- Compile review (`docs/track-graph-compilation.md`): a collapsed panel that walks the
  drawing on demand and shows the graph it implies. **Gaps first** — a block nothing
  reaches, a block with no detection, an opening leading nowhere — then the diff against
  the stored graph, grouped into changed / to add / to remove / renamed / unchanged, with
  the *changed* rows first because those are the same two openings needing different point
  positions. **One `Apply`**, which replaces the whole graph: there is no per-row accept,
  because a recompile is a replace and taking one row would author a graph the drawing
  does not describe. If the drawing moves while you are reading, the apply is refused and
  says to re-compile — it never retries by itself

### Track Editor
- Tile-based sparse grid persisted to backend
- Straight, corner, point, crossing, buffer, and platform tiles
- Rotation in 45° steps
- Keyboard-navigable canvas (`docs/track-editor.md` D11): the grid itself takes focus
  (`role="application"`) and is fully usable without a mouse
  - Arrow keys move a `cursor` cell (clamped to the drawn extent)
  - `Enter`/`Space` paints the selected tile at the cursor; `Delete`/`Backspace` erases it
  - `Escape` returns focus to the toolbar
  - `1-7` select tile type, `R`/`Shift+R` rotate ±45°, `Ctrl+Z` undoes — all scoped to the
    canvas, not the whole page
  - A single `aria-live` readout under the canvas ("Column 11, row 3. Point tile, …") is
    both the visible cursor position and the screen-reader announcement
  - Ruler gutters (column/row numbers) and a faint crosshair give a persistent spatial
    reference independent of the cursor readout; every 5th gridline is emphasised
  - Diagnostics-panel lines that carry a coordinate are click-to-jump buttons that move the
    cursor, centre the view, and pulse the cell
- Openings (`docs/track-editor.md` D15): **not drawn on the canvas**. Their names are
  compiled from the drawing on every read, so there is nothing to regenerate and nothing to
  correct by hand — the `Ends ⟳` and `Ends ✎` controls are gone (#103) — and with the graph
  compiled and applied, a name nobody acts on stopped earning the cells it sat on. Still
  spoken by the keyboard readout, and still listed in the Edges tab and the compile diff
- Mouse controls:
  - left drag to paint
  - right click to erase
  - middle drag to pan
  - wheel to zoom

## CI

GitHub Actions currently runs:
- install
- lint
- workspace tests
- backend build
- Playwright browser install
- Playwright end-to-end tests
- upload of the Playwright evidence artifact (runs even when the job fails)

### Playwright evidence

Every e2e run captures a trace, a screenshot, and a video for **every test**,
passing or failing, so a green build leaves a visual record of what the operator
UI actually rendered rather than only proving nothing threw. A failing test
additionally gets `error-context.md`, a YAML snapshot of the page at the moment
of failure, and the `github` reporter annotates the failing line inline on the
pull request.

CI uploads these as the `playwright-evidence` artifact, retained 14 days. To
read one:

```powershell
# download and unzip the artifact from the run's Summary page, then:
npx playwright show-report <unzipped-dir>
```

Serving the report is required rather than optional — opening `index.html`
directly over `file://` cannot fetch the trace archives.

Only `playwright-report/` is uploaded. The HTML reporter copies every attachment
into `playwright-report/data/`, so `test-results/` holds a duplicate of the same
traces, videos, and screenshots; uploading both would double the artifact for no
extra information. Both directories are gitignored.

`retries` is deliberately **0**. A test that only passes on a second attempt
would be reported as flaky-but-green, and this suite covers the operator UI of a
system that moves physical hardware — an intermittent failure is a finding, not
noise to be retried away. That is also why `trace` is `'on'` rather than
`'on-first-retry'`, which with no retries would capture nothing at all.

If artifact storage becomes a problem, drop `video` to `'retain-on-failure'`
first: a trace already carries a DOM snapshot and screenshot for every action,
so video on a passing test is the most expensive and least additive of the three.

## Safety Notes

The system follows a fail-safe posture:
- unknown/unhealthy transport states should result in safe-stop behavior
- business logic is separated from transport callbacks
- MQTT and DCC are abstracted behind ports/adapters
- simulation remains a first-class development mode

## Known Limits

Positions the system holds deliberately, each with a document behind it. **This is not a
changelog** — nothing here is a bug waiting to be fixed in passing, and a limit leaves
this list only when the decision behind it changes.

### Track graph

**The graph is compiled from the drawing, not authored.** The Track Editor's tiles are the
only description of the railway's connectivity; `block_edges` is generated from them and
applied whole after an operator reads the diff (#103). There is one writer and one
representation, so the two cannot drift. The hand-authoring routes and the older
edge-proposal surface are both deleted, as is `block_ends` — an opening's name is derived
on every compile and referenced by nothing in between, so there is nothing to store and
nothing to keep in agreement.

**An opening comes from where drawn track leaves the run** — tile type and rotation — not
from which cells happen to sit next to each other, so two yard roads drawn side by side no
longer read as opening into one another (#91).

**No distance is compiled, and none ever could be.** Tile count bears no relation to
physical length. Length lives on the block (#105), edited in Configure → Blocks and left
blank wherever nobody has run a tape over it.

**Two edge caps, for two different reasons.** `MAX_EDGES_PER_LAYOUT` (2,000) is admission
control on the apply, checked in `TopologyService.replaceGraph` against the whole candidate
set — not in the database and not on the load path. `MAX_COMPILED_EDGES` (200) is tighter
and sits in the compiler: a drawing producing more than that returns **409** from
`GET .../topology/compile` rather than handing back a diff nobody could review. Neither is
a physical constraint — Westgate Hollow compiles to 22 edges. See `docs/topology.md`.

**Nothing in `domain/` reads a tile**, and no grid diagnostic can refuse a write or halt a
layout. Diagnostics are advisory; only the compiler's *gaps* gate anything, and what they
gate is `auto` mode, never a write.

*Westgate Hollow, applied 2026-08-14:* 90 tiles (79 tagged to a block, 11 decorative, none
unclassified — the #71 classification pass is finished) and 9 blocks compile to 22 edges,
one connected component, no gaps. That includes the two south-east openings of
`Engine / Goods Transfer` which the old generator refused to name and therefore left
unroutable; the compiler disambiguates them by suffix and both carry edges.

### Routing and movement

**Driving a granted route is manual.** Pathfinding, reservation and locking all landed
(#4): a route is found, its track reserved and **its points thrown**. What is not automated
is the throttle — nothing drives the train along the road it has been given. That is #6
(per-loco braking) and #7 (collision avoidance).

**A point lock is a position guarantee only for points configured to require feedback**
(#25). The channel now exists: a point controller reports its observed position on
`point/{pointId}/reading`, the backend distinguishes what it *commanded* from what was
*confirmed*, and a point that does not confirm within 8 seconds goes `unknown` and
Safe-Stops the layout. But that applies per point, not per system — `positionFeedback`
defaults to `none`, and **every point on Westgate Hollow is `none` today** because no
feedback hardware is fitted yet. For those the old statement stands exactly: the lock
promises no other software authority will command the point, not that the blades have
moved, and the position drawn is commanded. The Layout panel and the point key say which
kind each point is rather than the system claiming one uniform level of trust it does not
have. The firmware side is not written yet — see `docs/project-plan.md`.

**A failed point names the route it invalidated, and that route cannot be resumed until the
point is dealt with.** A held point that times out, reports the wrong position, or reports
`unknown` stops its loco, suspends the route with its locks retained, and latches two
separate faults — one against the point, one against the route — because "this point motor
is dead" and "route R's road is no longer known to be set" are different problems an
operator fixes by different means. Resume is refused while the point's fault stands.

**Loco position is block-granular and always will be.** The model is open-loop dead
reckoning with no loco feedback (`docs/braking.md` B7), so the mimic highlights the block a
loco occupies and never places a train at a spot along it. Rolling stock is not modelled at
all (#39), so an occupied block with no identified occupant — a rake of coaches in a siding
— is all the system can say, and the diagram says exactly that rather than implying the
block is empty of vehicles.

**Fouling at a plain diamond crossing is not modelled** (#26) — two routes crossing there
share neither a block nor a point, so nothing detects the conflict. Westgate Hollow has no
plain diamond today, and the Track Editor now warns when one is drawn. That is a warning,
not a fix.

**A route-lock message names the route, not the train** (`block … is locked by route <id>`).
Everything else operator-facing resolves ids to names (#54), but a route is runtime state
with a different invalidation lifetime from the rest of the `NameBook` — deferred by
design, `docs/naming.md` D3.

### Sensors and occupancy

**A sensor-payload Safe-Stop is latched per sensor** (#27): once tripped it is not cleared
by an unrelated health re-evaluation, such as an MQTT or DCC reconnect.

**Recovery needs no restart, but is narrow by design** (#34). An operator may acknowledge a
fault only after `SENSOR_FAULT_CLEAR_READINGS` (default 3) consecutive valid, non-retained
readings have armed it — or mark the sensor out of service outright, for a device that will
never publish again.

Sharp edges worth knowing:

- Faults are **in-memory only** and lost on restart. There is no audit trail of what
  faulted when.
- **Nothing marks a sensor out of service automatically**, however many times it faults.
- **A silent sensor is not a fault** under this model — only a malformed one is. That
  device-liveness gap is shared with #25 and will be decided together with it.
- **A block with no in-service sensor able to determine it reads `unknown` indefinitely.**
  No route may be granted over it and none can resume through it for as long as that holds
  (`docs/sensor-fault-recovery.md` D6).

**Parse failures on operator-facing requests are ordinary 4xx/`ERROR` responses**, not a
Safe-Stop. The fail-safe rule in `docs/mqtt-contract.md` is scoped to sensor and control
topics; turning a bad UI request into a layout halt would itself be a bug.

### Authentication

**Local-only, and until TLS lands it defends against a stray device, a curious guest, or a
rogue web page — not an attacker with an existing foothold on the LAN.** Over plain HTTP
both the login password and the session cookie are sniffable. `docs/auth.md` carries the
full threat model and what changes once TLS is in place.

**`EMERGENCY_STOP` is deliberately reachable without authentication**
(`POST /api/emergency-stop`) — it can only move the system in the fail-safe direction, and
requiring a login before someone can halt a runaway is the wrong trade. Every other control
and config endpoint requires a session.

### Sensor simulation

**Single-shot only** (#65) — no timed or scripted sequence, no record/replay, no
cancellation. Each button press is one MQTT publish. The panel's "last injected" history is
client-side and resets on reload; it is deliberately not on the WebSocket `STATE_SNAPSHOT`.
The flag is off by default and **must not be enabled on a live layout** — see the safety
preamble in `docs/sensor-simulation.md`.

## Next Milestones

1. Per-loco braking model (#6) and collision avoidance (#7)
2. ESP firmware for point position feedback — #25 is complete in this repo, but nothing
   answers a `point/*/query` yet and no point has a feedback switch wired. Batch it with
   the WiThrottle→MQTT migration (#9); each is a flash-and-test cycle on the layout
3. Automation engine / schedules
4. A shared workspace package for the remaining backend↔frontend duplicates
   (`findBlockRuns`, `TILE_LEGS` vs `diagram/trackGeometry.ts`, and the heartbeat
   constants). #75 unified the editor↔monitor seam *inside* the frontend and deliberately
   left these alone — they span a CommonJS backend and an ESM frontend, which is a different
   problem. `EDGE_OFFSET`'s mirror is closed, having gone with the opening marks
5. Hardware validation and operator workflows
