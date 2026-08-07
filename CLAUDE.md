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
| `docs/claude-review.md`, `docs/gpt-review.md` | Open design questions |
| `docs/topology.md` | Track graph (`block_edges`) decision record |
| `docs/route-locking.md` | Route reservation and locking (D1–D14) decision record |
| `docs/auth.md` | Local authentication scheme and threat model |

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

`lockBlock` / `lockPoint` in `domain/layoutState.ts` do populate `lockedByRoute`. Nothing
calls them — there is no reservation engine to supply a `RouteId`, and the locking
semantics are undecided (#3).

Phase 3 is therefore gated on #3 (locking semantics) alone. The graph, its persistence,
and its authoring surface are all done. Route reservation (#4),
per-loco braking (#6), and collision avoidance (#7) follow those. Note for #4: edge writes
are not yet refused while a route is reserved — see the deferred note in
`docs/topology.md`.

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
silently undo it — and there is still no "acknowledge and clear" operator
action; recovery today means restarting the backend process. Audited the
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
