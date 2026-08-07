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
so a local recovery path here is not a new hole.

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
