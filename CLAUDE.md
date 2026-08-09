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
| `docs/route-locking.md` | Route reservation and locking (D1–D14) decision record |
| `docs/pathfinding.md` | Pathfinding, setting the road, and route faults (P1–P8) |
| `docs/auth.md` | Local authentication scheme and the pre-TLS threat model |
| `docs/sensor-fault-recovery.md` | Sensor-fault latch recovery and the per-sensor occupancy model |
| `docs/braking.md` | Per-loco braking model, deceleration profile, and calibration (B1–B10) |
| `docs/point-feedback.md` | Point position confirmation channel and fault model (D1–D10) |
| `docs/naming.md` | Operator-facing names: the `NameBook`, its invalidation points, and the D8 degradation contract (D1–D10) |
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

Repo housekeeping: `bash .claude/scripts/git-cleanup.sh` previews, and `--yes` applies,
the removal of merged branches and the stale `.claude/worktrees/` agent worktrees holding
them. The `/branch-cleanup` skill is a thin wrapper over it.

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
config UI, track editor, CI.

**Topology's backend half has landed (PR A of two); authoring has not (PR B).**
`block_edges` now has a full backend path: `ILayoutRepository` has edge CRUD methods
(`DrizzleRepository`, every read going through `parseBlockEdgeRow` — full-row Zod
validation, not just `point_conditions`); DB-level invariants (no self-loop, a positive
`length_mm` or `NULL`, non-blank ends, and a unique index on the full connection tuple —
deliberately *not* on `(from_block_id, from_end)`, see `docs/topology.md`) landed in
`migrations/0002_bitter_jane_foster.sql`; a `TopologyService` write path
(`src/services/TopologyService.ts`) validates every create/update against the rest of the
layout before persisting; and `LayoutService.reloadTopology()` runs on startup and after
every edge mutation, applying Safe-Stop on a fatal violation (`domain/topology.ts`,
`services/topologyLoader.ts`). REST: `GET|POST /api/layouts/:layoutId/edges`,
`PUT|DELETE .../edges/:id`, `GET .../topology`, `POST .../topology/revalidate`; block and
point deletes now delegate to `TopologyService` so a block delete cannot leave a dangling
edge and a point delete is refused while an edge still references it.

**The Configure UI has an Edges tab.** Edges are authored explicitly from the Configure
screen — not derived from grid tiles, which stays deferred (see `docs/topology.md`).

**Route locking has landed (#3).** `lockBlock` / `lockPoint` in `domain/layoutState.ts`
are now called — by `ReservationService`, the sole owner of that policy;
`LayoutStateManager` stays storage only. `domain/routeLocking.ts` is the pure planning/
release logic (`planReservation`, `evaluateOccupancyChange`, `holdsReleasableAt`);
`domain/types.ts` carries `RouteReservation`/`RouteHold`/`RouteRejection`;
`route_reservations`/`route_holds` (migration `0004_redundant_tana_nile.sql`) persist
reservations with DB-level exclusivity (partial unique indexes, #11's posture — no two
routes may hold the same block/point, at most one active/suspended reservation per loco);
`ReservationService` (`grant`/`cancel`/`suspendAll`/`suspendAuto`/`suspendOne`/`resume`/
`onOccupancyChange`/`loadOnStartup`) owns the lifecycle, with no MQTT/DCC access of its
own — `LayoutService` calls in and reacts to the outcomes. Because the service has no DCC
access, `resume` returning `resumed: true` is **provisional**: D8 requires every held
point to be re-commanded, so `LayoutService.resumeRoute` issues those commands *before*
treating the resume as successful, and rolls the route back to `suspended` (`suspendOne`,
locks retained) without clearing D9's restart latch if any is rejected. `TopologyService` gained a
fourth constructor argument, `lockView: IRouteLockView` (implemented by
`ReservationService`), closing the deferred edge-writes-vs-reservations note in
`docs/topology.md`: an edge/block/point held by an active or suspended route now refuses
a topology write (409). REST: `GET|POST /api/layouts/:layoutId/routes`,
`DELETE .../routes/:routeId`, `POST .../routes/:routeId/resume` — not role-gated beyond
authentication, same posture as the WebSocket driving commands. Full design record
(D1–D14) — why, not just what — is `docs/route-locking.md`; read it before touching
`domain/routeLocking.ts`, `services/ReservationService.ts`, or the route-lock guard in
`services/TopologyService.ts`.

**Sensor-fault recovery has landed (#34).** `SystemHealth.sensorFault`/`sensorFaultReason`
(the scalar pair #27 introduced) are gone, replaced by a keyed collection,
`SystemHealth.sensorFaults: Record<SensorId, SensorFault>` — one latched fault per sensor,
so acknowledging a fault the operator can see never silently clears one they were never
told about (D2); `evaluateSystemSafeStop` reports the *oldest* fault's reason and keeps its
existing priority order (MQTT, DCC, topology, sensor faults, then recovered routes — #4
later inserted route faults between the last two).
Block occupancy is now **derived**, not last-write-wins:
`domain/occupancy.ts#deriveBlockOccupancy` computes it fresh from every sensor currently
registered against a block, and an `ir_position` sensor may only ever raise occupancy,
never lower it — before this, any sensor carrying a `blockId` could clear the whole block
on its own say-so, which is exactly the "guess a train's position" failure safety rule 1
forbids (D3). That derivation is also now the ONLY thing that feeds
`ReservationService.onOccupancyChange` (`LayoutService.recomputeBlock`) — closing a real
seam with route locking: an IR `clear` can no longer fire progressive release or
un-reserve track under a train, because it never reaches the reservation engine as the
block's occupancy in the first place (see the cross-reference in `docs/route-locking.md`
D5 and `docs/sensor-fault-recovery.md` D6). `sensors.in_service`
(migration `0005_dusty_iron_lad.sql`, a single `ALTER TABLE ADD COLUMN`, default `true`)
plus `parseSensorRow` (full-row Zod, matching `parseBlockEdgeRow`/`parseUserRow`) join
`SensorRecord`; `MqttMessageHandler` gained a third `retained` parameter (D1/D8) so a
broker's retained replay on reconnect/subscribe can never count toward a fault's
recovery-arming threshold. `LayoutService` gained `acknowledgeSensorFault`,
`createSensorConfig`/`updateSensorConfig`/`deleteSensorConfig`, and `getSensorFaults`; two
new REST routes, `POST .../sensors/:id/acknowledge-fault` (any authenticated role — the
deliberate mirror of `POST /api/emergency-stop`'s deliberate lack of auth, since this one
moves the system OUT of Safe-Stop rather than into it) and
`GET .../sensor-faults`, alongside `requireAdmin` on the existing sensor config routes,
which now delegate to `LayoutService` instead of calling the repository directly. A
`SENSOR_FAULTS` `LayoutEvent` is forwarded over `/ws` the same way `BLOCK_STATE` etc.
already are, and the WS `STATE_SNAPSHOT` gains `sensorFaults` (deliberately not the raw
per-sensor observation map — diagnostic state nothing renders). Full design record
(D1–D8, plus the Q1/Q2 additions this PR recorded) is `docs/sensor-fault-recovery.md`;
read it before touching `domain/occupancy.ts`, `LayoutService`'s sensor-handling methods,
or `domain/safety.ts`'s `sensorFaults` handling.

**Pathfinding and setting the road have landed (#4).** `domain/pathfinding.ts#findPath`
is a pure, direction-aware Dijkstra whose search state is **(block, end entered by)**, not
block — that is what makes the no-reversal rule structural rather than a post-filter (P1).
Cost is `BlockEdge.lengthMm`, with `DEFAULT_EDGE_LENGTH_MM` (1,000) for unmeasured track,
so a layout with no lengths recorded degrades to fewest-hops (P2); ties break
deterministically by node key then edge id, so the same request cannot return different
paths between runs. The search ignores current point *positions* — setting the road is
what a route is — but refuses a point another route *holds*, and refuses any block that is
not positively `clear` and unlocked, via the shared `isBlockEffectivelyOccupied` (P3).
`ReservationService.grant` now takes `GrantRequest.path`, either
`{ kind: 'edges', edgeIds }` (#3's form, unchanged and still first-class) or
`{ kind: 'destination', destinationBlockId, startExitEnd? }`; a searched path is then
handed to `planReservation` exactly like a supplied one — **the pathfinder proposes, the
planner disposes** (P6). `checkPathIndependentPreconditions` was extracted from
`planReservation` so a search failure still reports the system/roster/graph rejections
D14 requires. `LayoutService.requestRoute` **throws the points** after the locks are
committed (D3's ordering, now exercised); a command the DCC adapter *rejects* invalidates
the whole route — cancelled, locks released, Safe-Stop — and is reported as
`granted: false` (P7). `commandPointHolds` is shared with D8's resume path.

**`SystemHealth.routeFaults: Record<RouteId, RouteFault>`** (P8) closes a live bug: a
route violation used to call `stateManager.enterSafeStop` directly, bypassing
`SystemHealth`, so the next unrelated health evaluation cleared a Safe-Stop caused by a
train being somewhere it should not be. Three kinds — `unexpected-occupancy` and
`point-command-rejected` (route cancelled) and `occupancy-unknown` (route **suspended**,
locks retained per D8). That last one is new behaviour: `evaluateOccupancyChange` used to
ignore `unknown` entirely, which was safe when the cause was a sensor fault (that
Safe-Stops on its own) but not when a sensor was taken out of service or deleted
mid-route. Priority in `evaluateSystemSafeStop` is now MQTT, DCC, topology, sensor faults,
**route faults**, recovered routes. REST: `POST .../routes/:routeId/acknowledge-fault`
(any authenticated role, mirroring the sensor equivalent; no arming threshold — a route
cannot prove itself) and `GET .../route-faults`. A `ROUTE_FAULTS` `LayoutEvent` is
forwarded over `/ws` and the `STATE_SNAPSHOT` gains `routeFaults`. Frontend: a Routes
panel on the Operate screen (loco + start + destination, live routes with Cancel/Resume,
latched faults with Acknowledge). Full design record is `docs/pathfinding.md` — read it
before touching `domain/pathfinding.ts`, `ReservationService.resolvePath`, or
`LayoutService`'s `requestRoute` / `commandPointHolds` / route-fault methods.

Phase 3's remaining work is per-loco braking (#6) and collision avoidance (#7); driving a
granted route is still manual — #4 sets and reserves the road, it does not drive the
train. Limits recorded rather than closed: a point lock is an authority guarantee ("no
other authority will command this point"), not a physical position guarantee — there is
still no point-position feedback channel (#25); the locking model does not catch two
routes fouling at a plain (non-switched) diamond crossing, since neither shares a block or
a point (#26; Westgate Hollow has none today); and the pathfinder does not search around a
point-position conflict, so a path can exist that it will not find (P5).

The three security findings against the original topology commit — #10 (Safe-Stop on
invalid topology rather than a bare throw), #11 (DB-level graph invariants), #12 (Zod
over the whole `block_edges` row) — have landed with this work.

**#21 landed**: topology validation (`domain/topology.ts`'s `validateTopology`) is O(n)
in edge count rather than O(n²) — duplicate-connection detection is index-backed
(`EdgeIndex`/`buildEdgeIndex`) instead of an `Array#find` scan per edge — and each
layout is capped at `MAX_EDGES_PER_LAYOUT` (2,000) edges, enforced only by
`TopologyService.createEdge` (admission control, not a DB invariant or a load-path
check — see `docs/topology.md`). `TopologyService.getStatus` now delegates to
`validateTopology` instead of open-coding its own scan, so `GET .../topology` and the
load path that decides Safe-Stop report the same violation set. A cap breach is a new
`EdgeLimitExceededError`, mapped to HTTP 409 on `POST .../edges`.

`packages/backend/tests/scenario/` now exists and has content (topology Safe-Stop and
recovery paths); it was empty before.

Frontend has no unit tests (`vitest --passWithNoTests`) — #8.

**Local authentication has landed.** `users`/`sessions` tables
(`migrations/0003_cooing_blur.sql`); pure argon2id hashing and session-token
logic in `domain/auth.ts`; `IAuthRepository`/`DrizzleAuthRepository`
(`parseUserRow`/`parseSessionRow` full-row Zod, matching `parseBlockEdgeRow`);
`AuthService` (login/logout/session validation, 30-day sliding refresh).
`DrizzleRepository` and `DrizzleAuthRepository` now share one SQLite
connection via `adapters/db/connection.ts#openDatabase` rather than each
opening and migrating their own. A single Fastify `onRequest` hook
(`transport/http/auth/hook.ts`), registered before any route, rejects an
unauthenticated request with 401 — this also covers the `/ws` upgrade, since
`@fastify/websocket` dispatches it through the same hook pipeline before
switching protocols; no separate check lives in the WebSocket transport code,
and auth is still enforced only at that edge, never mid-connection on a live
socket. `POST /api/auth/login` (rate-limited), `POST /api/auth/logout`,
`GET /api/auth/me`; every topology/config write route carries a
`requireAdmin` preHandler (`operator` may read and drive, only `admin` may
edit topology or config); `POST /api/emergency-stop` is the one deliberately
unauthenticated control path. CORS is an explicit env-driven allowlist
(`CORS_ALLOWED_ORIGINS`) plus `credentials: true`, replacing `origin: true`.
`services/bootstrapAdmin.ts` creates a single admin account from
`INITIAL_ADMIN_PASSWORD` on an empty `users` table and refuses to start
otherwise; `scripts/bootstrap-admin.ts` is the CLI password-reset path.
Frontend: `LoginScreen`, `useAuth`, and `api.ts` (`credentials: 'include'` +
centralised 401 handling) gate the rest of the UI behind a session. Full
scheme and the pre-TLS threat model are in `docs/auth.md` — read it before
touching anything under `transport/http/auth/` or `services/AuthService.ts`.

**#27 landed**: `LayoutService.handleSensorReading` now enters Safe-Stop — via
the same `SystemHealth`/`evaluateAndApplySafeStop` machinery as a connection
or topology failure, not a parallel mechanism — the instant a sensor payload
fails `sensorReadingSchema`, per mqtt-contract.md §Fail-Safe Triggers item 3.
The old warn-and-return is gone; the reason names the sensor id and topic,
block state is never touched on that path (the `return` happens before
`stateManager.updateBlockOccupancy`), and there is no tolerance — the first
malformed message trips it. `SystemHealth` gained `sensorFault`/
`sensorFaultReason` (`domain/safety.ts`), required fields mirroring
`topologyValid`/`topologyReason`; `evaluateSystemSafeStop`'s priority order is
now MQTT, then DCC, then topology, then sensor fault. The fault is latched —
nothing clears it automatically, so an unrelated MQTT/DCC reconnect can't
silently undo it. (`sensorFault`/`sensorFaultReason` and the "no acknowledge and
clear; recovery means restarting the backend" gap described here are #27's
original shape — #34, above, replaced the scalar pair with a keyed
`sensorFaults` collection and closed the gap with `acknowledgeSensorFault`
and out-of-service; see `docs/sensor-fault-recovery.md`.) Audited the
other inbound-parse warn-and-return sites while in there: `MqttAdapter`'s raw
`JSON.parse` failure (`adapters/mqtt/`) had the *same* bug one layer up —
malformed non-JSON on a sensor topic was dropped before it ever reached
`handleSensorReading`'s Zod check, so it now forwards the raw string through
to the subscriber instead of swallowing it, keeping the Safe-Stop decision in
the service layer rather than the transport (rule 2). HTTP/WS parse failures
on operator-facing routes (`transport/http/routes/{auth,edges}.ts`,
`transport/websocket/index.ts`'s `clientMessageSchema`) were also audited and
left as ordinary 400s / `ERROR` frames — the contract's fail-safe rule is
scoped to sensor/control topics, not operator UI requests, and turning a bad
UI request into a layout halt would itself be a bug. `services/validation.ts`'s
other `safeParse` sites (`block_edges`/`users`/`sessions` row parsing) were
already throwing rather than warn-and-return, and DB-row corruption already
surfaces as Safe-Stop via the topology load path (#12) or a 500, so those were
left unchanged. `docs/mqtt-contract.md` did not change — the code moved to
meet it.

**#53 landed**: local authentication (#20) shipped with no way to create an
`operator` account — every path that could create a user hardcoded `role:
'admin'` — so the entire operator half of the role model was unreachable
short of hand-editing SQLite. `IAuthRepository` gained `listUsers`,
`updateUserRole`, `deleteUser` (plus `LastAdminError`/`UsernameTakenError`,
declared on the port so both `AuthService` and `DrizzleAuthRepository` can
throw them without either importing the other's module); `AuthService` owns
the policy (`listUsers`/`createUser`/`changeUserRole`/`deleteUser`/
`resetUserPassword`/`changeOwnPassword`) the same way `ReservationService`
owns route-locking policy over `LayoutStateManager` — the repository stays
storage. Deleting or demoting the layout's last admin is refused at both
layers: `AuthService` from a `listUsers()` pre-check
(`domain/users.ts#wouldRemoveLastAdmin`), and — because that service-level
check has the same read-then-write race #11 argued against for route
exclusivity — a SQLite trigger pair (`users_last_admin_no_demote`/
`users_last_admin_no_delete`, migration `0006_users_last_admin_guard.sql`)
at the database. That migration is deliberately the one place in the repo
that touches persistence without a `schema.ts` change: a trigger can't be
expressed in Drizzle's schema DSL, so it was generated with
`drizzle-kit generate --custom` rather than `db:generate`, and `schema.ts`
carries a comment above the `users` table recording that the triggers exist
so the file still tells the truth. A role change and a deletion both call
`deleteSessionsForUser` immediately after the write succeeds, closing the
same "auth enforced only at the connection edge" gap the WebSocket upgrade
hook already relies on — a demoted or deleted user holding an open `/ws`
would otherwise keep their old authority indefinitely. Six routes:
`GET|POST /api/users`, `PATCH|DELETE /api/users/:id`,
`POST /api/users/:id/password` — all `requireAdmin`, since an operator has
no reason to enumerate accounts — and `POST /api/auth/change-password`,
reachable by any authenticated user and rate-limited at login parity because
verifying the caller's current password makes it the same guessing oracle
login is; a wrong current password there is 403, not 401, so the frontend's
app-wide 401 handler doesn't bounce the user to the login screen on a typo.
An admin may not change their own role or delete themselves (409
`SelfMutationError`) even with another admin present — handover is "create
the second admin, then they demote you" — but may reset their own password
exactly like anyone else's, since a hijacked admin session could already do
that regardless. Frontend: a Users tab on the Configure screen, rendered
only for `role === 'admin'` (`useUsers`, `UsersTab`), and a
`ChangePasswordDialog` reachable by any logged-in user from the session area
beside "Log out". Full decision record — why, not just what — is
`docs/auth.md`'s "User and role management" section; read it before touching
`AuthService`'s user-management methods, `domain/users.ts`, or the trigger
migration.

**#54 landed**: operator-facing diagnostic strings (route rejections, topology
violations, Safe-Stop reasons, HTTP 404 bodies) name the block/point/sensor/loco
involved instead of a bare UUID. `NameBook` (`domain/types.ts`) is six
`ReadonlyMap`s — layouts, blocks, points, sensors, locos, edges (edges hold a
*derived* label like `Down Platform:north → Up Loop:south`, not a name —
`block_edges` has no name column) — and `domain/naming.ts` carries the pure
rendering helpers (`label`/`blockLabel`/`pointLabel`/`sensorLabel`/`locoLabel`/
`edgeLabel`/`layoutLabel`/`buildEdgeLabel`/`pluralise`) every `describe*`
function in `domain/` now threads an optional trailing `book?: NameBook`
through. With no book (or a book miss) every one of those renders the full raw
id, byte-for-byte identical to before #54 (D8) — the plural/delimiter wording
fixes D7 asked for are the one unconditional exception. `services/nameBook.ts`
holds the impure half: `buildNameBook` (pure over plain record arrays) and
`NameBookCache`, the `INameBook` (`ports/INameBook.ts`) implementation
`LayoutService`/`ReservationService`/`TopologyService` each take as an optional
trailing constructor parameter, defaulting to the inert `INERT_NAME_BOOK` so
the ~60 pre-#54 test construction sites kept compiling untouched. The cache is
refreshed at four points — startup, every topology write (via
`LayoutService.reloadTopology`, before it loads topology so a fatal-violation
Safe-Stop reason is already named), every sensor-config write, and every
block/point/loco route handler after its repo write — a missed refresh costs a
stale display name, never unsafe behaviour. `NameBookCache.refresh` narrowly
catches `BlockEdgeRowInvalidError` only, falling back to an empty edges map, so
a corrupt `block_edges` row can never let the name-book refresh (which now runs
before `loadTopology` inside `reloadTopology`) regress #10's Safe-Stop-not-throw
guarantee. Persisted/published reasons (a reservation's `reason`, a
`RouteFault`/`SensorFault`, `SystemHealth.topologyReason`) render through the
book at generation time, not on demand — `system/status.reason` goes out over
MQTT and cannot be re-rendered later; the one HTTP-422-body exception renders
at the transport edge, since that body is neither persisted nor published.
Route ids stay bare everywhere (`block-locked`/`point-locked`/
`loco-already-routed`, braking's `manual-authority`/`route-not-active`) — a
route is runtime state with a different invalidation lifetime than the rest of
the book, deliberately deferred. Frontend: `packages/frontend/src/naming.ts`
mirrors the backend helpers (no shared workspace package exists to import
instead) and `EdgesTab`/`RoutesPanel` build a local `NameBook` from props
already in scope rather than re-implementing `describeViolation` a second
time. Full design record (D1–D10, Q1–Q3) is `docs/naming.md` — read it before
touching `domain/naming.ts`, `services/nameBook.ts`, or any `describe*`
function.
