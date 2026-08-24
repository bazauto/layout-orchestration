# Local Authentication — Decision Record

This document records the design behind local username/password authentication
(`domain/auth.ts`, `ports/IAuthRepository.ts`, `adapters/db/authRepository.ts`,
`services/AuthService.ts`, `services/bootstrapAdmin.ts`,
`transport/http/auth/`, `transport/http/routes/auth.ts`). It is not binding in
the way `docs/mqtt-contract.md` is, but it explains *why* the scheme is shaped
the way it is, and — most importantly — records the threat model it actually
provides, so nobody later assumes stronger properties than exist.

## Why local username/password, not Google OAuth or a shared PIN

Google OAuth fails the local-first rule outright: an internet outage would
lock the operator out of hardware sitting three feet away, and every
workaround (device-bound session, long-lived local token, break-glass
credential) is itself a local credential scheme with weaker properties than
building the local scheme directly. A shared PIN in `.env` was rejected too —
it has no identity, no revocation without a restart, and no path to roles.
Passkeys/WebAuthn are the right answer eventually but require a secure
context, which `http://layout.local:3000` isn't yet (see "TLS" below). mTLS
client certificates are the right answer for the ESP controllers, not for a
phone opened on the sofa.

## The scheme

- **Password** — argon2id via `@node-rs/argon2` (prebuilt native bindings,
  no build toolchain required to install this workspace), stored in `users`.
  Not bcrypt, not a hand-rolled PBKDF2.
- **Session** — an opaque, cryptographically random token
  (`domain/auth.ts#generateSessionToken`, 256 bits). The `sessions` table
  stores a SHA-256 hash of it, never the token itself — the same posture as
  password hashing: a database read (backup, dump, accidental log line) must
  not directly yield a usable session, only a lookup key.
- **Delivery** — an `HttpOnly; SameSite=Lax` cookie, not a Bearer token. The
  browser `WebSocket` constructor cannot set headers, but it does send
  cookies automatically on the upgrade request — a cookie is what lets
  `transport/websocket/index.ts` (indirectly, via the shared `onRequest`
  hook) reject an unauthenticated upgrade before the socket ever completes
  the protocol switch.
- **Enforcement** — one Fastify `onRequest` hook
  (`transport/http/auth/hook.ts`), registered once on the root instance
  before any route, so it covers everything registered afterward — REST
  routes and the `/ws` upgrade alike. `@fastify/websocket` dispatches the
  upgrade request through the normal hook pipeline before switching
  protocols, so *authentication* — is there a valid session at all — needs
  no separate check in the WebSocket transport code. **This still holds**
  after #63: the WebSocket transport now also reads `request.user.role`, but
  only once, at the same moment the hook has already run, into a
  per-connection constant (D2 below) — it is a second fact captured at the
  connection edge, not a second enforcement point checked mid-connection.
  The distinction that survives is authentication (hook, HTTP-layer,
  connection-or-nothing) versus authorisation-by-role (per-connection
  constant, checked per message against a value that cannot change without a
  new connection).
- **Roles** — `admin` may edit topology and config; `operator` may drive;
  `monitor` (issue #63) may only watch — situational awareness with no
  authority to move anything. `admin`/`operator` writes are enforced by a
  `requireAdmin` preHandler on every topology/config write route (blocks,
  points, sensors, locos, layouts, grid tiles, edges, `topology/revalidate`).
  Config *reads* are not role-gated beyond requiring *some* authenticated
  session — a monitor needs the same block/point/loco/sensor records an
  operator's screen already reads unauthenticated (see "Config reads stay
  ungated, and must" below). The WebSocket driving commands
  (`THROTTLE_COMMAND`/`POINT_COMMAND`/`FUNCTION_COMMAND`/`SET_MODE`) *are* now
  role-gated, refusing a `monitor` connection specifically — see "The monitor
  role" below. The frontend mirrors both cuts by showing each role only the
  screens/actions it can act on — see "Operator UI scope" below, which is an
  affordance rule, not a second enforcement point.
- **Sliding expiry** — 30 days (`domain/auth.ts#SESSION_TTL_MS`), refreshed
  on every validated request: `AuthService#validateSession` extends
  `sessions.expires_at` server-side, and the `onRequest` hook reissues the
  cookie with a fresh `Max-Age` in the same request, so the browser-side
  expiry tracks the server-side one instead of expiring 30 days after login
  regardless of continued use.

## Three deliberate decisions

### Emergency Stop stays unauthenticated

`POST /api/emergency-stop` is in the `onRequest` hook's exemption list,
alongside `GET /health` and `POST /api/auth/login`. This deliberately
contradicts "unauthenticated requests to control endpoints are rejected" —
it is called out rather than quietly done. Emergency Stop can only move the
system in the fail-safe direction; requiring a login before someone can halt
a runaway is the wrong trade for a system that moves physical hardware. The
cost is that anyone on the LAN can nuisance-stop the layout — on a home
network that's acceptable, and it's still the safe direction. Every other
control path (throttle, points, functions, mode changes) requires auth.

The route exists specifically because the WebSocket upgrade itself now
requires a session: the pre-existing `EMERGENCY_STOP` `ClientMessage` still
works over an already-authenticated socket, but a client with no session (or
one that just expired) has no socket to send it over, so a plain
unauthenticated HTTP endpoint is the fail-safe path when the authenticated
one isn't available. It is a thin transport wrapper around the same
`LayoutService.handleEmergencyStop()` the WebSocket path calls — no
duplicated logic.

### No `AUTH_ENABLED` flag

It's the obvious way to keep tests and simulator mode working, and it's a
footgun that eventually ships enabled-off. Instead:

- Integration tests log in for real via Fastify `inject()` —
  `tests/integration/testAuthHelpers.ts` provides a real in-memory
  `IAuthRepository` (real argon2id hashes) and a helper that performs an
  actual `POST /api/auth/login` and carries the resulting cookie on
  subsequent requests.
- The Playwright e2e suite mocks the entire network already (see the doc
  comment on `installMockWebSocket` in `tests/e2e/helpers.ts` — it exists so
  specs don't need a real backend process); `installMockAuth` extends that
  same pattern for `GET /api/auth/me` rather than standing up a real backend
  and real login for every spec. `tests/e2e/auth.spec.ts` covers the login
  screen itself the same way. The real login route being reachable and
  correct end-to-end is exercised by the Vitest integration suite instead.
- Bootstrap is a required `INITIAL_ADMIN_PASSWORD` on first run, plus a CLI
  reset command (below). Simulator mode keeps its "no external dependency"
  property — a local password table is not an external dependency.

### Roles

> **Three route postures, not two** (#149). `requireAdmin` guards topology and config writes;
> no guard at all means any authenticated role, used for driving-adjacent recovery like
> acknowledging a fault; and `requireNotMonitor` admits `admin` and `operator` for actions
> that **move or energise the layout** without being config edits. Track power is the first
> of the third kind, and it is the most literal form of the authority `monitor` does not
> have: energising the rails is what makes every other command capable of an effect.
>
> It is written as a deny-list of one rather than an allow-list of two on purpose. A role
> added later should have to be considered here explicitly, and the failure mode of
> forgetting is then "the new role cannot switch the power on", not "the new role silently
> can". ship in the first cut

A `role` column on `users` from the start, not retrofitted later: `admin`
may edit topology and config, `operator` may drive. This maps to a real
distinction — a guest running a train at an open day should not be able to
delete a `block_edge` — and retrofitting a column onto a live-deployed
SQLite database is exactly what `CLAUDE.md` warns against. Cheap now,
expensive later.

## Bootstrap and recovery

`services/bootstrapAdmin.ts` runs once at startup, before the server starts
listening. If the `users` table is completely empty, it creates a single
admin account from `INITIAL_ADMIN_PASSWORD` — and refuses to start if that
env var isn't set. A fresh deployment with zero accounts and no way to log in
is a permanent lockout, which is a worse failure than not starting. The check
is against the whole table (`hasAnyUsers`), never a specific username, so an
operator who has since renamed or deleted the default admin account is never
silently overridden by a stale `INITIAL_ADMIN_PASSWORD` still sitting in
`.env` on a later restart.

`scripts/bootstrap-admin.ts` (`npm run bootstrap-admin --workspace=packages/backend -- <username> <password>`)
is the CLI reset path: it creates the named account as admin if it doesn't
exist, or resets its password and revokes its existing sessions if it does.
Physical/shell access to this machine already implies access to track power,
so a local recovery path here is not a new hole. It stays the break-glass
path and its own scope is unchanged by the user-management work below — see
that section for why the last-admin guard doesn't obstruct it.

## User and role management (issue #53)

Before this work, nothing in the system could create an `operator` account:
`bootstrapAdmin.ts` creates the first account only, always as `admin`, and
`scripts/bootstrap-admin.ts` hardcoded `role: 'admin'` on its create path.
The entire `operator` half of the authorisation model — reads and driving,
but not topology/config edits — was unreachable short of hand-editing SQLite
on a live layout. `IAuthRepository` gained three methods (`listUsers`,
`updateUserRole`, `deleteUser`); `AuthService` owns the policy
(`listUsers`/`createUser`/`changeUserRole`/`deleteUser`/`resetUserPassword`/
`changeOwnPassword`), matching how `ReservationService` owns route-locking
policy over `LayoutStateManager` — the repository stays storage. Six routes:
`GET|POST /api/users`, `PATCH|DELETE /api/users/:id`,
`POST /api/users/:id/password` (all `requireAdmin`), and
`POST /api/auth/change-password` (any authenticated user, not admin-gated).
The decisions below were made once, as a set, and are recorded here so a
later session does not re-open them piecemeal:

- **Q1 — Last-admin protection is enforced at both layers.** `AuthService`
  refuses the demotion or deletion with `LastAdminError` (409) after a
  `listUsers()` pre-check (`domain/users.ts#wouldRemoveLastAdmin`); SQLite
  triggers `users_last_admin_no_demote`/`users_last_admin_no_delete`
  (migration `0006_users_last_admin_guard.sql`) abort it at the database,
  closing the interleave between the service's read and its write — #11's
  posture on route exclusivity, applied here because the service-level race
  is real: two concurrent demotions can each observe two admins and both
  proceed, leaving zero. The DB half is a trigger pair, not a partial unique
  index, because a unique index expresses "at most one" and this is "at
  least one", which SQLite can express no other way. The triggers are
  therefore invisible in `schema.ts` (see the comment above the `users`
  table there) and the migration was produced with
  `drizzle-kit generate --custom` rather than `db:generate` — the one
  migration in this repo that lands without a structural schema change.
  `BEFORE UPDATE OF role` does not fire for a password update, so
  `scripts/bootstrap-admin.ts` (which only ever inserts or updates
  `password_hash`, never `role`, never deletes) is unaffected by either
  trigger.
- **Q2 — A role change and a deletion both revoke the user's live
  sessions** via `deleteSessionsForUser`, called only after the write
  succeeds (so an aborting trigger leaves sessions intact for a change that
  didn't happen). Auth is enforced only at the connection edge, never
  mid-connection — see "Enforcement" above — so a demoted admin holding an
  open `/ws` would otherwise keep admin authority, and a deleted user's
  session would otherwise keep working entirely, until the session expired
  on its own.
- **Q3 — Self-service password change requires the current password and is
  rate-limited at login parity** (`{ max: 5, timeWindow: '1 minute' }`),
  because verifying the old password makes `POST /api/auth/change-password`
  the same guessing oracle `POST /api/auth/login` is. An admin reset
  (`POST /api/users/:id/password`) verifies nothing, is `requireAdmin`, and
  carries no rate limit — deliberately: an admin session can already reset
  any other admin's password, so requiring proof of the *old* password before
  an admin can reset someone else's would buy nothing, and the same argument
  applies to an admin resetting their own. A wrong current password on the
  self-service route returns **403**, not 401 — `packages/frontend/src/api.ts`
  routes every 401 to the app-wide unauthorized handler, which would bounce
  the user to the login screen on a typo, an actively wrong outcome. A
  successful self-service change revokes **every** session the user holds,
  including the caller's — no "keep this one" carve-out — clears the cookie,
  and returns 204; the frontend's `ChangePasswordDialog` then resets local
  auth state the same way a deliberate "Log out" does, rather than waiting
  for the next 401.
- **Q4 — An operator may not list users.** All five `/api/users` routes
  carry `requireAdmin`; an operator's own identity is already available from
  `GET /api/auth/me`, and the pre-TLS threat model below argues for the
  smaller surface. The Configure screen's Users tab is rendered only for
  `role === 'admin'` — now one of several places the frontend consults
  `role`, per "Operator UI scope" below, which widened it to the whole
  screen.
- **Q5 — A new account's password is set by the admin at creation**,
  required in the `POST /api/users` payload, no invite or first-login flow —
  this is a local-first single-household system where the admin and the new
  user are typically in the same room. `MIN_PASSWORD_LENGTH` (8) moved from
  `scripts/bootstrap-admin.ts` into `domain/auth.ts` (alongside the new
  `MAX_PASSWORD_LENGTH`, 256) so the CLI and every HTTP schema share one
  rule; `loginSchema` is deliberately not capped, since a login password may
  predate the cap.
- **Q6 — `passwordHash: null` is unreachable through these routes.**
  `password` is a required non-empty string in `userCreateSchema`, and
  `AuthService.createUser` independently throws `PasswordPolicyError`, so a
  non-HTTP caller cannot bypass it either. The column stays nullable —
  WebAuthn is still the reason (see "Nothing here forecloses adding
  passkeys later" below).
- **Self-mutation is refused.** An admin may not change their own role or
  delete themselves (409 `SelfMutationError`), even when another admin
  exists — handover is "create the second admin, then they demote you", and
  this removes a whole class of "I deleted my own session mid-operation"
  surprises. Self *password* change and self password reset are both still
  allowed: a hijacked admin session can already reset any other admin's
  password, so blocking self-reset would buy nothing.
- **Password reset is its own route**, `POST /api/users/:id/password`, not a
  field on `PATCH /api/users/:id`. `PATCH` carries `{ role }` only,
  `.strict()` — a PATCH that can silently rotate a credential reads
  identically in logs to one that only changes a role, and the two have
  different audit meaning.
- **Usernames remain case-sensitive**, trimmed on creation only
  (`domain/auth.ts#normaliseUsername`). `Paul` and `paul` would be distinct
  accounts. A case-insensitive (`NOCASE`) unique index would mean a table
  rebuild migration on the live layout database for a two-user household —
  recorded here as a known limit rather than closed.
- **`LastAdminError`/`UsernameTakenError` are declared on
  `ports/IAuthRepository.ts`**, not in `AuthService`. Both layers throw them
  — the service from its pre-checks, `DrizzleAuthRepository` when
  translating a SQLite constraint/trigger abort — so the port is the one
  contract both sides share, and neither imports the other's module for an
  error type.

## The monitor role (issue #63)

A third `Role`: situational awareness with no authority to move anything.
The motivating case is a wall display or a tablet handed to a visitor at an
open day — someone who should be able to watch the layout work without
being able to touch it. **A monitor is meant to see a purpose-built
situational-awareness view, not a stripped Operate screen** — see "Why not
a read-only Configure or a read-only track view" below, which already made
this argument for `operator` and named `monitor` as where it actually
belongs. This document, and #63's backend work landing with it, covers only
the role itself: the `Role` vocabulary, the migration, and the WebSocket
enforcement below. The frontend view is a separate, later PR. Four
decisions, made once and recorded here so a later session does not re-open
them:

- **D1 — `Role` gains a third value, `monitor`.** `admin` may edit topology
  and config; `operator` may drive; `monitor` may only watch. Widening the
  `users_role_valid` CHECK constraint is a table-rebuild migration
  (`migrations/0011_users_monitor_role.sql`), because SQLite cannot alter a
  CHECK in place — the same class of change `CLAUDE.md` warns about. The
  rebuild's generated `DROP TABLE users` drops every trigger attached to the
  table, so the migration ends with the same two `CREATE TRIGGER` statements
  as `migrations/0006_users_last_admin_guard.sql`, appended by hand and
  re-tested end to end (`tests/integration/migrations.test.ts`): both
  triggers exist post-rebuild, both still actually abort, the CHECK accepts
  `monitor` and still rejects a junk role, and existing rows keep their role
  through the rebuild. `domain/users.ts#wouldRemoveLastAdmin` needed no
  change — it already checks `nextRole !== 'admin'`, not
  `nextRole === 'operator'`, so demoting the sole admin to `monitor` is
  refused by the exact same rule that refuses demoting to `operator`.
- **D2 — Enforcement is a per-connection capability captured at the
  WebSocket upgrade, not a per-message role lookup.** The "Enforcement"
  section above states auth is enforced *only at the connection edge, never
  mid-connection on a live socket* — nothing tears a socket down for an auth
  reason while a train might be moving. `transport/websocket/index.ts`
  reads `request.user.role` exactly once, at the point the upgrade handler
  runs (`registerAuthHook` has already populated it before the upgrade
  completes — see that module's own header comment), into a `const role`
  closed over by the connection's `message` handler for the socket's whole
  lifetime. Re-reading the session per message would have broken that
  property for the first time since #20; this is the substantive backend
  work in #63. **This re-confirms the "Enforcement" claim above, rather than
  contradicting it**: the role check is still done exactly once, at the
  edge — it is simply a second fact (role, not just "authenticated")
  captured at the same moment as the first.
- **D3 — A refused driving command is an `ERROR` message, never a socket
  close.** Same reasoning as D2: closing a `monitor` socket over an
  authorisation refusal would be indistinguishable, from the operator's
  seat, from a network fault, and — more to the point — is exactly the kind
  of mid-connection teardown D2 exists to rule out. `THROTTLE_COMMAND`,
  `POINT_COMMAND`, `FUNCTION_COMMAND` and `SET_MODE` sent by a `monitor`
  connection get an `ERROR` reply naming the refused message type; the
  socket stays open and the next message is evaluated on its own merits.
- **D4 — `EMERGENCY_STOP` remains available to every role, including
  `monitor`.** It was already reachable by every authenticated role before
  #63 (and, via `POST /api/emergency-stop`, by an unauthenticated LAN client
  at all — see "Emergency Stop stays unauthenticated" above); #63 item 3
  asked for that to be stated as a decision rather than carried forward by
  accident. It only moves the system in the fail-safe direction, so a role
  with no authority to *start* or *change* movement still has every reason
  to be able to *stop* it. `DRIVING_MESSAGE_TYPES` in
  `transport/websocket/index.ts` is deliberately a positive list of what is
  gated, not `ClientMessage` minus an exclusion — `EMERGENCY_STOP` is simply
  absent from it, so a future read-only message type needs no change there
  either.

## Operator UI scope (issue #61)

**Shipped.** `App.tsx` derives one `visibleTabs` list from `role`, which the
nav and the panel render guards both read.

**The nav is now a table, not a branch** (`TABS_BY_ROLE` in `App.tsx`):

| Role | Tabs |
|---|---|
| `admin` | Operate, Control, Track Editor, Configure |
| `operator` | Operate, Control |
| `monitor` | Monitor — the same view, with no controls rendered |

**One view, two labels (#165).** The mimic became the screen the layout is
driven from, so for the roles that may drive it the tab reads **Control**. For
a `monitor` it still reads **Monitor**, because that session gets the mimic and
none of the controls: labelling it "Control" would promise an authority the
WebSocket transport will refuse, and there is no second view to send that role
to instead. `tabLabel` in `App.tsx` is the whole of that rule.

Nothing about enforcement moved. `DRIVING_MESSAGE_TYPES` (D2/D3 above) already
refused `THROTTLE_COMMAND` and `POINT_COMMAND` from a `monitor` connection
before #165 existed, which is why putting those controls on this view needed no
new gate — only the affordance to match.

A `monitor` briefly shared the operator's nav — every control on it refused
server-side by "The monitor role" above (D2/D3), but with the screen not
saying so, which is exactly the greyed-out-control problem this section argues
against. That gap is closed: a monitor is offered the purpose-built view and
nothing else, and `appTab` initialises to the role's *first* visible tab
rather than the constant `'operate'`, so the role cannot land on a screen its
nav has no way back to.

**An operator gets the Control view as well**, which "an operator sees the
Operate screen and nothing else" below does not literally allow. That sentence
predates the view. This same section rejects a read-only Configure and a
read-only track view on the grounds that what an operator actually wants is
"a purpose-built situational-awareness view … tracked separately as the
`monitor` role, issue #63" — this is that view, and withholding it would
honour the letter of the sentence against its own argument. The sentence is
kept as written because the rest of it still holds exactly: what an operator
does *not* get is the authoring UI.

**An operator sees no authoring UI.** The Track Editor
and Configure entries are absent from the nav for a non-admin, and their
panels are not rendered. Absent, not disabled: a greyed-out control still
poses a question ("why can't I?") whose honest answer is "you may not", and a
nav entry that says so by not existing says it better than a tooltip does.

### What this replaces

`App.tsx` built its nav from a fixed `['operate', 'grid', 'configure']`
array and never consulted `role`, even though `role` is in scope there and
printed two lines away in the session label. `ConfigPanel` used it for
exactly one thing, Q4's Users tab; `GridEditor` was not passed it at all. An
operator was therefore offered all five authoring tabs, the per-row rename
and delete controls, the sensor in-service checkbox and the whole track
editor — and every save bounced off the backend's `requireAdmin` with a 403.
The controls were real, the authority was not.

### This is affordance, not authorisation

The `requireAdmin` preHandler stays the enforcement, and stays load-bearing:
hiding a tab does nothing to `curl`, a stale browser tab, or a second client.
Nobody should later drop a route guard on the grounds that "the UI doesn't
offer it" — the UI is a convenience over a boundary that is enforced
server-side, in that order and not the other way round. What #61 fixes is
that the frontend was misrepresenting the operator's authority to them, not
that it was granting any.

### What an operator keeps

Hiding Configure deliberately costs an operator nothing they are permitted to
do, which is worth stating because the two obvious candidates both look like
casualties and are not:

- **Sensor-fault acknowledgement** — `POST /sensors/:id/acknowledge-fault` is
  the one non-admin write in the system (D5, `docs/sensor-fault-recovery.md`),
  and it is reached from `SensorFaultBanner`, which renders *above* the nav
  on every tab rather than inside Configure's Sensors tab. An operator
  recovering a latched sensor fault never needed the Configure screen.
- **Route-fault acknowledgement, cancel and resume** live in `RoutesPanel` on
  the Operate tab.

Changing their own password and logging out are in the nav's session block,
which is not tab-scoped either.

### Config *reads* stay ungated, and must

The Operate screen is assembled from them: `useLayoutConfig`'s block, point,
loco and sensor records feed `ThrottlePanel`, `LayoutPanel`, `RoutesPanel`
and the fault banner's sensor names. "Operators don't get Configure" is a
statement about the authoring UI only — turning it into a `requireAdmin` on
`GET /api/layouts/:id/blocks` would empty the operator's own screen. The
split stated under "Roles" above is unchanged by this decision.

### Why not a read-only Configure or a read-only track view

Because that is a different feature wearing this one's clothes. What an
operator would actually want to see — live point positions, block occupancy,
and which loco is where — is not "Configure with the buttons off"; it is a
purpose-built situational-awareness view, and it is wanted by a third role
that has no driving authority at all (a wall display at an open day). That is
tracked separately as the `monitor` role, issue #63. Stubbing it here as a
disabled editor would pre-empt that design with the wrong shape and then be
the thing someone has to undo.

## CORS

`transport/http/server.ts` replaces `origin: true` with an explicit,
env-driven allowlist (`CORS_ALLOWED_ORIGINS`, comma-separated) plus
`credentials: true`. Together with the cookie's `SameSite=Lax` this is what
actually closes the drive-by-web-page case that motivated this work in the
first place — the two mechanisms are independent and both are wanted:
`SameSite=Lax` stops the cookie being sent on a cross-site request in the
first place; the CORS allowlist stops a script on an unlisted origin from
reading the response even for the (same-site, browser-permitted) requests
`SameSite=Lax` does allow through.

## The threat model, stated plainly

**Until TLS is in place**, the honest goal of this scheme is: *stop a stray
device, a curious guest, or a web page the operator's browser happened to
load from issuing commands.* It is explicitly **not**: *resist an attacker
with an existing foothold on the LAN.* Over plain HTTP, both the login
password and the session cookie are sniffable by anything already on the
network — a passive observer on the same Wi-Fi/switch can read both directly
off the wire. That is a reasonable goal for a home layout control system; it
is written down here so nobody later assumes stronger properties than exist.

Session revocation on a role change and on a deletion (Q2, issue #53) exists
*because* of the "enforced only at the connection edge, never mid-connection"
property above, stated plainly here too: without it, an admin just demoted
to operator — or removed outright — who is holding an open `/ws` connection
would keep driving with their old authority until that socket happened to
close and the browser reconnected with the now-invalid cookie. `AuthService`
calling `deleteSessionsForUser` immediately after the write is what forces
that reconnect (and the accompanying 401) to happen on the *next* request
over the socket's underlying HTTP session, rather than leaving a stale
authority live indefinitely.

The design does not assume plaintext stays forever, and nothing here needs to
change shape when TLS lands — only configuration:

- The session cookie's `Secure` flag is config-driven (`COOKIE_SECURE`), not
  hardcoded off. It must stay `false` until TLS is in place — a `Secure`
  cookie over plain HTTP is silently refused by the browser, which would
  make every session fail closed in a confusing way, not a safe one. Once
  Paul's planned internal CA (step-ca or similar) issues the orchestrator
  host a certificate, set `COOKIE_SECURE=true` and the cookie stops being
  sent over any downgraded plain-HTTP connection too.
- The CORS allowlist is env-driven, so adding an `https://` origin is a
  config edit (`CORS_ALLOWED_ORIGINS`), not a code change.
- Nothing here forecloses adding passkeys later. `users.password_hash` is
  nullable specifically so a WebAuthn-only account (no password credential
  at all) is representable; a WebAuthn credential itself would live in a new
  `webauthn_credentials` table keyed on `user_id`, attaching to the existing
  `users` table as a second credential type rather than replacing this
  model. WebAuthn becomes viable the moment TLS lands, since it requires a
  secure context.

## Out of scope

MQTT and the ESP firmware. Those get broker-level credentials
(`MQTT_USERNAME`/`MQTT_PASSWORD`, already in `config.ts`) and mosquitto ACLs.
No amendment to `docs/mqtt-contract.md` was needed for this work, because
broker auth is connection-level, not topic-level, and the contract governs
topics and payloads, not who may connect to the broker.
