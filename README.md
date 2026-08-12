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
- REST API for layouts, locos, blocks, points, sensors, grid tiles, and block edges (track topology)
- Topology validation with Safe-Stop on an invalid graph, and operator recovery via edge authoring
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
  covering an unexpected occupancy, a rejected point command, and a reserved block whose
  occupancy stops being determinable mid-route
- WebSocket state streaming to the frontend
- Local username/password authentication with role-based access (`admin` /
  `operator`) — see `docs/auth.md` for the scheme and its threat model
- Full user and role management (#53): an admin can create, list, change the role of,
  and delete accounts, and reset another user's password, from the Configure screen's
  Users tab or `GET|POST /api/users` / `PATCH|DELETE /api/users/:id`; any logged-in user
  can change their own password (`POST /api/auth/change-password`). Deleting or
  demoting the last `admin` account is refused at both the service layer and the
  database (a trigger pair, since "at least one must exist" isn't expressible as a
  unique index) — see `docs/auth.md`
- Frontend login screen; the rest of the UI requires an authenticated session
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
  a diagnostic's cell — #94), no-scrollbar viewport regression, edge authoring, and the
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
- CRUD for blocks, sensors, points, locos, and edges
- Inline editing
- Sensors tab: an In service toggle per sensor (marking a dead device out of service clears
  its latched fault and stops the system trusting it)
- Edge authoring: from/to block and end labels, optional point conditions, length, and an
  "also create reverse edge" shortcut; a violation banner surfaces invalid topology and
  rejected writes without discarding the operator's input. End-label suggestions come from
  the block ends the drawing generated, so the name you type is one that exists
- Edge proposals (`docs/topology.md`): a collapsed panel above the form lists the
  connections the drawing implies, with their point conditions, and accepts them one at a
  time or all at once. Accepting is the same `POST .../edges` the form makes — there is no
  second write path. Rows that cannot be posted (an opening with no block end, a
  connection the graph already carries) say why instead of offering a button, and notes
  name the cell where the walk stopped

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
- Block ends (`docs/track-editor.md` D12): `Ends ⟳` regenerates the labels from the
  drawing; `Ends ✎` opens a list of every end — block, label, whether it is pinned or
  generated, and the cell the drawing places it at — where you can add, rename (which also
  pins) and delete one. A rename or delete of a label an edge references is refused, and
  the refusal names the edges
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

A formal track graph exists — `block_edges` in the schema, with construction and
traversal in `domain/graph.ts`, a full REST CRUD surface, and a Configure UI tab for
authoring it. Route reservation and locking now exists on top of it (`docs/route-locking.md`)
— granting, cancelling, suspending, resuming, and progressive release — but it takes an
explicit ordered edge list; there is no pathfinder yet and nothing issues point/throttle
commands for a granted route (both #4). Two limits the locking model records rather than
closes: a point lock guarantees no other software authority will command the point, not
that the point is physically in the required position — there is still no point-position
feedback channel from the DCC controller (#25) — and the model does not catch two routes
fouling at a plain (non-switched) diamond crossing, since neither shares a block or a
point (#26; Westgate Hollow has none today — and the Track Editor now says so when one is
drawn, which is a warning rather than a fix). Edges are still authored explicitly through
the Edges tab rather than derived from grid tiles, but the two representations are
no longer entirely unchecked against each other: block ends are generated from the drawing
as 8-point cardinal labels with a sticky manual override (#72), buffer stops assert that an
end has no onward connection, and `GET .../grid/diagnostics` reports where the drawing and
the graph disagree (#84). The Edges tab will also *propose* the edges the drawing implies
and accept them through the ordinary write path (#78) — proposing is not deriving, and
`lengthMm` is never among what it proposes. One case the manual override still cannot
fully resolve: where the generator refused to name two openings facing the same bearing
(`end-label-collision`), a hand-created end authors edges but never attaches to a cell on
the drawing — see `docs/topology.md`. A block's openings come from where its **drawn track leaves the
run** — tile type and rotation — not from which cells sit next to each other, so two yard
roads drawn side by side no longer read as opening into one another (#91). All of it is
advisory — nothing in `domain/` reads a tile, and no diagnostic can refuse a write or halt
a layout. The classification pass marking which existing Westgate Hollow tiles are
deliberately decorative (#71) is done: the layout is 90 tiles, 79 tagged to a block and 11
decorative, with none unclassified. Each layout is capped at
2,000 `block_edges` —
a deliberate admission-control limit on `POST .../edges` (not a physical layout constraint;
Westgate Hollow is ~40 edges), enforced only on create and only in `TopologyService`, not
the database or the load path — see `docs/topology.md`.

A sensor-payload Safe-Stop (#27) is latched per sensor: once tripped it is not cleared by
an unrelated health re-evaluation (e.g. an MQTT/DCC reconnect). Recovery (#34) is now
possible without a restart, but is narrow by design: an operator may acknowledge a fault
only after `SENSOR_FAULT_CLEAR_READINGS` (default 3) consecutive valid, non-retained
readings have armed it, or mark the sensor out of service outright for a device that will
never publish again. Sharp edges worth knowing: faults are in-memory only and lost on
restart, with no audit trail of what faulted when; nothing marks a sensor out of service
automatically, however many times it faults; a sensor that goes *silent* rather than
malformed is not a fault under this model (a device-liveness gap shared with #25, decided
together later); and a block with no in-service sensor able to determine it reads
`unknown` indefinitely — no route may be granted over it, and none can resume through it,
for as long as that is true (see docs/sensor-fault-recovery.md D6). `websocket`/HTTP parse
failures on operator-facing requests remain ordinary 4xx/`ERROR` responses, not a
Safe-Stop — see the fail-safe rule in `docs/mqtt-contract.md`, which applies only to
sensor and control topics.

Authentication is local-only and, until TLS is added, only defends against a stray
device, a curious guest, or a rogue web page — not an attacker who already has a
foothold on the LAN, since both the login password and the session cookie are
sniffable over plain HTTP. See `docs/auth.md` for the full threat model and what
changes once TLS lands. `EMERGENCY_STOP` is deliberately reachable without
authentication (`POST /api/emergency-stop`); every other control and config
endpoint requires a session.

Every block/point/sensor/loco create/update/delete in `useLayoutConfig.ts` now
surfaces a failed save instead of discarding the response — matching how the Edges
tab has always handled a rejected write (#22).

Every config write route now validates its body with a `.strict()` Zod schema in
`services/validation.ts` before anything reaches the repository (#36). The gap was
that a Fastify `Body` generic is erased at compile time, so a route declaring a
typed body and nothing more validated nothing at runtime — `blocks` `POST`/`PUT`
and `points` `POST` were the remaining outliers and now carry `blockCreateSchema`,
`blockUpdateSchema`, and `pointCreateSchema`.

Operator-facing diagnostic strings (route rejections, topology violations, Safe-Stop
reasons, HTTP 404 bodies) now name the block/point/sensor/loco involved instead of
a bare UUID, wherever a `NameBook` reaches the call site (#54, `docs/naming.md`). One
residual by design: a route-lock message (`block ... is locked by route <id>`) still
names the *route*, not the train behind it — a route is runtime state with a
different invalidation lifetime than the rest of the book, so this is deferred
rather than solved here (`docs/naming.md` D3).

Sensor simulation (#65) is single-shot only — there is no timed or scripted sequence, no
record/replay, and no cancellation semantics; each button press is one MQTT publish. The
"last injected" history shown in the panel is client-side and resets on reload — it is not
persisted, and it is not part of the WebSocket `STATE_SNAPSHOT` (deliberately; see
`docs/sensor-fault-recovery.md`'s note that per-sensor last-reading stays out of that
snapshot). The flag is off by default and must not be enabled on a live layout — see the
safety preamble in `docs/sensor-simulation.md`.

## Next Milestones

1. Per-loco braking model (#6) and collision avoidance (#7)
2. Point position confirmation (#25)
3. Automation engine / schedules
4. Link grid tiles to the topology graph, so tile placement can derive edges
5. Hardware validation and operator workflows
