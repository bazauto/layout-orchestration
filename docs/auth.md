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
  protocols, so no separate check lives in the WebSocket transport code.
- **Roles** — `admin` may edit topology and config; `operator` may drive.
  Enforced by a `requireAdmin` preHandler on every topology/config write
  route (blocks, points, sensors, locos, layouts, grid tiles, edges,
  `topology/revalidate`). Reads, and every WebSocket driving command
  (`THROTTLE_COMMAND`/`POINT_COMMAND`/`FUNCTION_COMMAND`/`SET_MODE`), are not
  role-gated beyond requiring *some* authenticated session.
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

### Roles ship in the first cut

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
  `role === 'admin'`.
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
