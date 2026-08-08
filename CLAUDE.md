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
| `docs/auth.md` | Local authentication scheme and the pre-TLS threat model |
| `docs/sensor-fault-recovery.md` | Sensor-fault latch recovery and the per-sensor occupancy model |
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

Migrations are applied automatically on backend startup from `MIGRATIONS_PATH`.
**Any change to `src/adapters/db/schema.ts` requires a generated migration in the same
commit** — this system is deployed to a live layout and cannot be reset.

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
  - **Backend** — CommonJS (`"module": "CommonJS"`, `"moduleResolution": "Node"`, no
    `"type"` field). Relative imports carry **no extension**: `from './types'`. Adding
    `.js` breaks `tsc`.
  - **Frontend** — ESM (`"type": "module"`, `"module": "ESNext"`, bundler resolution).
- Structured logging with Pino; always include `layoutId`, and `locoAddress` / `blockId` /
  `pointId` where relevant.
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
existing priority order (MQTT, DCC, topology, sensor faults, then recovered routes).
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

Phase 3 was gated on #3 (locking semantics) alone; that gate is now clear. Pathfinding
(#4) takes an explicit ordered edge list from `ReservationService.grant` — #3 deliberately
does not search the graph. Per-loco braking (#6) and collision avoidance (#7) follow #4.
Two limits #3 records rather than closes: a point lock is an authority guarantee ("no
other authority will command this point"), not a physical position guarantee — there is
still no point-position feedback channel (#25) — and the locking model does not catch two
routes fouling at a plain (non-switched) diamond crossing, since neither shares a block or
a point (#26; Westgate Hollow has none today).

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
