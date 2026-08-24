# Layout Orchestrator

Model railway layout orchestration for the Westgate Hollow project.

Part of a four-repo control stack:
[PicoDCC](https://github.com/bazauto/PicoDCC) (DCC command station),
[layout-feedback](https://github.com/bazauto/layout-feedback) (MicroPython sensor nodes),
[esp-layout-controller](https://github.com/bazauto/esp-layout-controller) (touchscreen
throttle), and this — the backend and operator UI.

This repository owns [`docs/mqtt-contract.md`](docs/mqtt-contract.md), which is **binding** on
what the sensor nodes publish.

This repository contains a local-first control stack for a DCC-based layout:
- A Node.js backend for layout state, MQTT integration, DCC control, SQLite persistence, REST APIs, and WebSocket updates
- A React frontend for operating the layout, editing topology, and configuring blocks, sensors, points, locos, and track tiles

The project is currently in the layout-definition and operator tooling phase. Route
reservation, locking, and pathfinding have landed (see Current Status); a granted route
reserves its track and sets its points, but driving the train along it is still manual.
A per-loco braking model exists and can be asked to stop a train at a route boundary;
what nothing does yet is decide *when* to ask. Collision avoidance and scheduling are
planned next.

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
  `EMERGENCY_STOP` stays available to every role. The purpose-built frontend view is the
  Control view below, which this role gets labelled **Monitor** and stripped of every
  control (#165) — see `docs/auth.md` "The monitor role"
- Connection-health heartbeat (#82): a periodic application-level `HEARTBEAT`
  `ServerMessage` (not a protocol-level `ws` ping, which the browser can't observe) so a
  client can tell a frozen socket from a quiet layout. The frontend indicator is on the
  Control view: stale or disconnected covers the canvas — see `docs/liveness.md`
- Frontend login screen; the rest of the UI requires an authenticated session
- Role-scoped navigation (#61, #63, #165): `admin` gets Operate, Control, Track Editor and
  Configure; `operator` gets Operate and Control; `monitor` gets that same view alone,
  labelled **Monitor** because it carries none of the controls for that role. The
  authoring screens are **absent** for a non-admin rather than disabled — affordance
  only, with `requireAdmin` and the WebSocket role gate as the actual enforcement
- Control view (#63, #75, #82, #129, #165): the live mimic drawing block occupancy,
  commanded point roads and which loco is where, on the **same** renderer the Track
  Editor uses. A set route is a coloured, dashed line **along the track it holds**,
  through the decorative sections between blocks too, with a key naming each route by
  its loco — several concurrent routes are told apart by hue and dash, not hue alone.
  A point key floating over the canvas — dragged where the operator wants it — resolves
  the abbreviated point names and shows what each point is set to and who holds it. Connection health is always on screen, and a
  stale or disconnected diagram is covered rather than badged — see `docs/liveness.md`.
  An off-by-default "Sensors" checkbox (#76) overlays each placed sensor's live reading
  on its own mark, distinct from a block's occupancy fill — see `docs/diagram-encoding.md` D8
- The control plane (#165): the mimic is also where the layout is driven from. **Throttle
  cards** — one per loco, several at once, dragged where the operator wants them and
  remembered per layout — carry a speed slider that commands as it moves (no *Set* press),
  forward/reverse, `Stop` and `Brake`. Each row of the point key gained `Normal` /
  `Reverse` buttons. Three interlocks, all in `docs/liveness.md` M10–M16: **track is never
  a button** (a mis-tap on a wall display must not move a point under a train); a card for
  a loco under an **auto**-authority route opens *armed*, behind a `Take control` button
  naming the route it will cancel; and direction cannot change while the loco is commanded
  to move. A point a route holds offers no buttons — forcing it cancels that route, which
  stays on the Routes panel. A refused command now says so on screen instead of only in the
  browser console
- Per-loco braking (#6): a deceleration ramp planned from the loco's `brakingFactor` and
  the measured track ahead, run against an injected clock, with a `Brake` button beside
  each loco's `Stop` for the calibration procedure in `docs/braking.md` B8. An overrun —
  the train reaching a block at or beyond where it was told to stop — latches a fault and
  Safe-Stops, because a reservation alone cannot tell an overrun from an arrival
- Sub-block sensor position (#77): an IR beam can carry a measurement — how far it sits
  from the boundary with a *named neighbouring block* — and a `clear → occupied` transition
  is treated as a position fix at that instant, decaying by a worst-case travel allowance
  rather than expiring on a timer. Anchored to a block id, never to a compiled block-end
  label, which is regenerated by every compile. The braking model consumes it as the one
  thing that lets a train be stopped at the boundary of the block immediately ahead; it can
  only ever add distance, never withdraw it. Authored in Configure → Sensors, where the
  anchor lists only blocks the drawing actually joins this one to. Unmeasured is the
  default and behaves exactly as before. See `docs/sensor-position.md`
- Frontend operate screen for throttle, points, and live state
- Frontend configuration screen for blocks, sensors, points, locos, and edges
- Track editor with tile palette, rotation, keyboard shortcuts, hover ghost preview, and persistence
- Backend unit/integration/scenario tests and Playwright frontend end-to-end tests
- GitHub Actions CI
- Automation engine (#7): an `auto`-authority route is driven end to end — departed at the
  loco's configured line speed, braked on approach, crawled, and stopped on a **berthing
  beam** placed where the train should stand. Nothing is automated until an operator sets
  a loco's automation speeds and asks for an `auto` route
- Live sensor observations on the wire (#76): `StateSnapshot.sensors` and a `SENSOR_STATE`
  delta, pushed only when a sensor's contributed value (or `faulted`/`inService`) changes —
  so a healthy sensor re-asserting inside the freshness window pushes nothing, and a
  flapping beam is visible on every transition. Surfaced on the control view as an off-by-default
  "Sensors" layer, drawn on its own channel — never a block tint — so raw sensor evidence
  stays visibly subordinate to derived block occupancy

Planned next:
- Automation engine / schedules — deciding *where* a train should go. Collision avoidance
  and speed control (#7) is **done** (`docs/automation.md`): automation drives one
  operator-granted `auto` route end to end, and what is left is sequencing several

## Workspace Layout

```text
.
├─ packages/
│  ├─ backend/   # Fastify, MQTT/DCC adapters, domain logic, DB, tests
│  └─ frontend/  # React + Vite operator/config/editor UI
├─ tests/
│  └─ e2e/       # Playwright end-to-end tests
├─ deploy/       # systemd units, backup timer, journald retention, deploy scripts
├─ .github/
│  └─ workflows/ # CI
└─ docs/         # Project notes and contracts
```

## Requirements

- Node.js 22+ — matching the `engines.node` floor in `package.json`. CI runs 24.x and
  `deploy/bootstrap.sh` provisions 24, so 24 is the tested version
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

`FRONTEND_DIST_PATH` points at the built operator UI (`packages/frontend/dist`). When set,
the backend serves it from `/` on the same port as the API — that is what makes a
deployment one process on one port. **Leave it unset in development**, where Vite serves
the UI instead. See the Deployment section below.

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

Frontend runs on Vite's dev server, which proxies `/api` and `/ws` to the backend on port
`3000`. The frontend addresses its own origin rather than a hardcoded host, so the proxy
is what connects the two — there is no API URL to configure.

Leave `FRONTEND_DIST_PATH` unset in development. Setting it makes the backend serve a
*built* copy of the UI on :3000 as well, and debugging a stale bundle you forgot you were
looking at is a poor use of an afternoon.

## Deployment

The full reasoning is `docs/deployment.md`; this is the short version.

The stack runs as a **systemd service**, with the backend serving the built operator UI on
its own port — one process, one port, one unit. Everything lives in `deploy/`.

One-time, on the target machine:

```bash
curl -fsSL https://raw.githubusercontent.com/bazauto/layout-orchestration/main/deploy/bootstrap.sh | bash
```

That installs Node from NodeSource, clones the repository to `/opt/layout-orchestrator`,
installs the two units, the timer and the journald drop-in, and adds the service account
to `dialout` for the DCC serial port. It deliberately does **not** write `.env`, copy a
database, or start anything.

Then write `/opt/layout-orchestrator/.env` (start from `.env.example`), put a database in
`data/`, and:

```bash
sudo systemctl enable --now layout-orchestrator
```

Thereafter, deploy from the development machine:

```bash
bash deploy/deploy.sh              # deploys origin/main
bash deploy/deploy.sh <tag|sha>    # deploys anything else
```

The target checks the ref out from GitHub, runs `npm ci`, builds both workspaces and
restarts the service. Nothing is copied from the development machine — what runs on the
layout is always a commit that exists in the repository.

Two things the deployed `.env` must get right, both of which are silent if wrong:

- **Absolute paths.** The unit's working directory is the repository root, not
  `packages/backend`, so `MIGRATIONS_PATH=./migrations` resolves to a directory that does
  not exist and the backend starts against an unmigrated database.
- **systemd's grammar.** The same file is read by `dotenv` *and* by systemd's
  `EnvironmentFile`, and systemd accepts plain `KEY=value` only — no `export`, no shell
  expansion. `deploy.sh` refuses to deploy a file that breaks this.

### Backups

`layout-orchestrator-backup.timer` runs `deploy/backup-db.cjs` daily, which takes a
`VACUUM INTO` snapshot and retains 14.

**Never back this database up with a file copy.** It runs in WAL mode with a log reaching
megabytes; copying `layout.db` alone produces a backup that restores cleanly and is
missing the most recent session's work. `VACUUM INTO` folds the WAL in and writes one
self-contained file.

```bash
sudo systemctl start layout-orchestrator-backup       # snapshot now
journalctl -u layout-orchestrator-backup              # what happened
systemctl list-timers layout-orchestrator-backup      # when is the next one
```

To restore: stop the service, copy the snapshot over `data/layout.db`, **delete
`layout.db-wal` and `layout.db-shm`**, start. Leaving the old WAL beside a restored
snapshot resurrects the state you were rolling back.

### Logs

The backend writes structured JSON to stdout, so under systemd there is no log file and
nothing for logrotate to rotate — retention is journald's, configured host-wide in
`/etc/systemd/journald.conf.d/layout-orchestrator.conf` (500 MB, 30 days).

```bash
journalctl -u layout-orchestrator -f                              # follow
journalctl -u layout-orchestrator -b | grep '"level":"error"'     # errors this boot
journalctl -u layout-orchestrator -b | grep '"level":"warn"'      # warnings this boot
```

**`journalctl -p err` does not work here**, and returns an empty result rather than an
error. The logger writes every line — errors included — to `process.stdout`, which
journald records at `info` priority; the severity is a `level` field *inside* the JSON,
which journald does not parse. Filter on the payload, as above.

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

### Deployment

**Backups live on the same disk as the database.** The bench box has one disk, so the
daily `VACUUM INTO` snapshot protects against corruption, a bad migration and an
accidental delete — and not against the disk failing. Pulling a snapshot off the box is a
manual `scp` today. `docs/deployment.md` D6.

**The broker on the bench listens on `127.0.0.1:1883` only.** That is sufficient for the
orchestrator, which runs on the same machine, and it means the ESP sensor and point
controllers cannot reach it. Opening a LAN listener is a firmware-session task with an
authentication question attached, not a line in a config file.

**No TLS, and `COOKIE_SECURE` stays `false`.** A deliberate position with its own threat
model in `docs/auth.md`, on a private network. Flipping the cookie flag before TLS exists
makes every session fail closed, which is why the two move together or not at all.

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

**Driving a granted route is manual until you opt a route in to automation.** Pathfinding,
reservation and locking all landed (#4): a route is found, its track reserved and **its
points thrown**. Braking landed too (#6) — the system can be *asked* to stop a train at a
route boundary and will run the ramp. #7 PR B is what now decides *when* to ask, and drives
the train: an `auto`-authority route departs, runs at its loco's line speed, brakes on
approach, crawls, and stops on a berthing beam (`docs/automation.md`).

**Nothing on this layout is automated yet, and nothing will be until you say so.** Every
column automation needs is nullable and nothing back-fills one, so today no loco has an
`auto_speed_step` and no route has a `direction` — automation departs nothing. A
`manual`-authority route is still exactly what it was: the operator driving their own
reserved road, which automation neither drives nor guards.

**A braked stop to the very next block needs a beam in the block behind it.** Occupancy is
block-granular, so on its own the model will only promise the *intermediate* track between
the block the train is confirmed in and the one it must stop short of — and for adjacent
blocks that is zero, because the train may already be hard against the exit. #77 closed
that: an IR beam measured toward a neighbouring block turns a trip into a position fix, and
the fix contributes the distance from the beam to the boundary. What remains is coverage —
a block with no positioned beam, or one whose beam has not been broken since the train
entered, still refuses. See `docs/braking.md` B4 and `docs/sensor-position.md` D9.

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
- **A silent sensor is still not a *fault*** — but since #28 it is no longer ignored
  either. Silence now degrades the track that sensor observes (below); only a malformed
  payload latches a fault.
- **A block with no in-service sensor able to determine it reads `unknown` indefinitely.**
  No route may be granted over it and none can resume through it for as long as that holds
  (`docs/sensor-fault-recovery.md` D6).

**A retained reading is never trusted on its own** (#28, `docs/sensor-trust.md`). MQTT
retention tells a new subscriber what was last published and nothing about whether the
publisher is still alive — so a controller that died reporting `clear` replayed that
`clear` to every future subscriber, and the backend believed it. Sensor hardware is now
contractually obliged to **re-publish its current reading at least every 30 s**, and a
sensor from which no *live* message has arrived inside `SENSOR_FRESHNESS_TIMEOUT_MS`
(default 90 s) is untrusted: every block it reports degrades to `unknown`, which is
already treated as occupied.

Two things about that are deliberate and look like oversights:

- **A stale sensor degrades its own track; a malformed one still halts the layout.** A
  device *lying* cannot be trusted now and gets an immediate Safe-Stop; a device *dying*
  is stale and gets a freshness window scoped to what it observes.
- **A stale sensor does not poison a block another live detector still covers**, and does
  not raise occupancy from its last reading either. Untrusted means "not evidence", in
  both directions. Only losing a block's *last* trusted detector degrades it.

**Until the firmware re-asserts, every sensor-backed block on real hardware reads
`unknown`.** That is the honest state rather than a regression — nothing could previously
tell a live detector from a dead one. Manual driving is unaffected; route granting and
automation over unobserved track are refused. The firmware side is #9 and #50.

**A sensor's own reading is now on the control view, not just its effect on a block** (#76).
`StateSnapshot.sensors` and a `SENSOR_STATE` delta carry every registered sensor's current
observation — pushed only when its contributed value, `faulted`, or `inService` changes, so
a healthy sensor re-asserting inside the 30 s window above pushes nothing, and an
oscillating beam is visible on every transition instead of being invisible entirely. It is
an off-by-default layer on the control view (a "Sensors" checkbox), and it is deliberately
subordinate to derived occupancy on screen — the two can legitimately disagree
(`deriveBlockOccupancy` clause 3), and the beam gets its own small mark, never a share of a
block's fill. See `docs/diagram-encoding.md` D8 and `docs/sensor-fault-recovery.md` D10.

**Parse failures on operator-facing requests are ordinary 4xx/`ERROR` responses**, not a
Safe-Stop. The fail-safe rule in `docs/mqtt-contract.md` is scoped to sensor and control
topics; turning a bad UI request into a layout halt would itself be a bug.

### The command station

**The DCC leg is inside the safety model now, and what closed it was learning to listen.**
Until #148 `SerialDccAdapter` was write-only, so `isConnected()` reported on a USB device
node: a station that had cut track power, entered maintenance mode, rebooted or simply
stopped listening looked exactly like a healthy one. The orchestrator now sends `<s>` every
five seconds and reads the stream. Silence for three probes Safe-Stops the layout; a
rejected command (`<X>`) faults the route that issued it; an acknowledgement naming a
different loco than the one addressed Safe-Stops outright. See `docs/dcc-link.md`.

**Silence halts everything, because there is no partial degrade for this leg.** A stale
sensor poisons only its own blocks — the command station is the sole path to every train.
Note what the halt is about: sensors run over MQTT, so a dead DCC link does not make train
positions unknown. What it costs is the ability to *act*, and a system that can watch a
train it cannot stop must not be granting it new track.

**A wrong *speed* in an acknowledgement warns; only a wrong *cab* halts.** Dated, not
permanent: the speed byte's encoding changed in `bazauto/PicoDCC#49`, `#48` (speed 0
encoding as an emergency stop) is open, and #151 will introduce a per-loco step mode. A
strict check today would halt a live layout over a firmware version skew. `docs/dcc-link.md`
D6 carries the revisit condition.

**Track power is observed, not acted on.** `<p0 MAIN>` is parsed and reported; nothing
refuses a route over a dark layout yet, and nothing can turn power back on from the UI. That
is #149. A station that cut power and still answers probes therefore reads *responsive and
dark* — and because the firmware's cutoff paths are still silent on the wire
(`bazauto/PicoDCC#4`, half done), it is seen at the next probe rather than pushed.

**Decoder functions are refused against real hardware** (#150). PicoDCC validates `<F>`,
accepts it, and does nothing with it — `updateFunct()` is an empty body — so
`SerialDccAdapter.setFunction` throws rather than reporting a headlight that never came on.
The simulator is unaffected; this is a hardware limit, not a model limit.

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

1. **Fit and measure the beams.** #7 is complete in this repository
   (`docs/automation.md`), so what stands between the live layout and automated running is
   hardware: a **berthing beam** where a train should stand in each destination (the
   platform, the goods shed), measured with a tape and entered in Configure → Sensors.
   Without one a run stops short of its destination block instead of berthing inside it —
   a limit of coverage, not of the model. Each loco also needs its automation and crawl
   speed steps set in Configure → Locos, and each automated route a direction; until then
   automation departs nothing
2. ESP firmware, as **one** flash-and-test cycle rather than three. Three obligations are
   now waiting on the same boards, and all three are specified against a stable contract:
   the WiThrottle→MQTT migration (#9); answering `point/*/query` for point position
   feedback (#50 — #25 is complete in this repo, but nothing answers a query yet and no
   point has a feedback switch wired); and #28's **30 s re-assert** on
   `sensor/*/reading`, which is roughly ten lines and without which every sensor-backed
   block reads `unknown`
3. **The rest of the command-station work** (#153 is the index). #147 and #148 have landed,
   and #150's guard with them. Next is #149 — track power: `<1>` on connect, refusing routes
   over a dark layout, and an operator control to turn power back on after a cutoff, which
   today needs a power cycle of the station. Behind it sit #152 (validate `points.dcc_address`,
   and act on the `<X>` a bad one now draws) and #151 (per-loco 128/28-step mode, which needs
   #148's read path to survive a station restart). **Do not calibrate braking until
   `bazauto/PicoDCC#48` lands** — speed 0 currently encodes as an emergency stop, so every
   stopping-distance sample would be measuring the wrong curve
4. Order and scheduling systems — #7's automation engine has landed; what it deliberately
   does not do is decide *where* a train should go, sequence two trains through a
   junction, or plan a timetable
5. A shared workspace package for the remaining backend↔frontend duplicates
   (`findBlockRuns`, `TILE_LEGS` vs `diagram/trackGeometry.ts`, and the heartbeat
   constants). #75 unified the editor↔control-view seam *inside* the frontend and deliberately
   left these alone — they span a CommonJS backend and an ESM frontend, which is a different
   problem. `EDGE_OFFSET`'s mirror is closed, having gone with the opening marks
6. Hardware validation and operator workflows

## Licence

Released under the MIT Licence — see [`LICENSE`](LICENSE).

That covers the first-party code in `packages/`, `deploy/`, `tests/` and the documentation.
The two workspace packages are marked `"private": true` so they are never accidentally
published to npm; the MIT grant applies to the source in this repository regardless.

### Third-party dependencies

No third-party code is vendored here — everything arrives through npm and is resolved from
`package-lock.json`, so each package ships under its own licence with its own notice inside
`node_modules/`.

The production dependency tree (169 packages behind Fastify, React, Drizzle, `better-sqlite3`,
`mqtt` and `serialport`) is entirely permissive:

| Licence | Packages |
|---|---|
| MIT | 149 |
| ISC | 8 |
| BlueOak-1.0.0 | 5 |
| BSD-3-Clause | 4 |
| BSD-2-Clause | 1 |
| Apache-2.0 | 1 |
| 0BSD | 1 |

There is no copyleft anywhere in the tree, production or development, and nothing unlicensed.
The one non-software licence present is `caniuse-lite` (CC-BY-4.0), a build-time browser-support
dataset used by the Vite/Babel toolchain that is not included in the built bundle.

To re-check after a dependency change, print the licence of every production package:

```bash
npm ls --omit=dev --all --parseable | tail -n +2 | tr '\\' '/' | while read -r d; do
  node -p "require('$d/package.json').license || 'NONE'" 2>/dev/null
done | sort | uniq -c | sort -rn
```

The `tr` is needed on Windows, where `npm ls` prints backslash paths that `require` will not
resolve. Two `NONE` entries are expected — they are this repo's own two workspace packages.
Anything else that is not MIT / ISC / BSD / Apache-2.0 / 0BSD / BlueOak wants a second look
before it lands.

**If a built artefact is ever distributed** — a tarball or container image rather than this
source tree — the frontend bundle will contain React and its dependencies, and MIT requires
their copyright notices travel with it. Generate a `THIRD_PARTY_NOTICES` file into the build
output at that point. Distributing the source repository, as today, needs nothing further.
