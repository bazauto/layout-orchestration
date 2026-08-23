# Deployment and operations

**Issue:** #143.
**Target:** the bench box — a Linux Mint 22.3 machine on the private network at
`172.18.10.240`, with the PicoDCC command station on `/dev/picodcc-dccex` and a
mosquitto broker on `localhost:1883`. The PicoDCC project calls the same machine
"bench".

Everything about running this stack somewhere other than a developer's shell: how the
code gets there, what starts it, what backs the database up, and how long the logs live.

---

## The problem this closes

Before #143 the only documented way to start the backend was `npm run dev:backend` — a
watch-mode dev command, in a terminal, on someone's desktop. Nothing survived a reboot,
nothing survived the terminal closing, nothing copied the database anywhere, and the
operator UI was a Vite dev server.

Two facts made it worth closing before the first live session rather than after:

- **The live database cannot be reset.** It carries 90 drawn tiles, 9 blocks, a compiled
  and applied 22-edge graph, tape-measured sensor positions and per-loco calibration. All
  hand-authored, none reproducible.
- **The WAL trap is a live foot-gun.** `layout.db` runs in WAL mode with a log reaching
  megabytes. Copying the `.db` alone yields a backup that restores cleanly and is missing
  the last session's work — it has already cost one round of wrong conclusions on this
  project.

---

## D1 — One process, one port, one unit

The backend serves the built SPA itself. `FRONTEND_DIST_PATH` points at
`packages/frontend/dist`; when set, `@fastify/static` is registered and the operator UI
answers on the same port as the API and the `/ws` upgrade.

The alternative was a second server (nginx, or `vite preview`) on its own port proxying
`/api` and `/ws` back. Rejected: it is a second thing to install, start, keep running and
keep in sync, in exchange for nothing. Serving from one process also makes every browser
request **same-origin**, which removes CORS, `SameSite` and the credentialed-fetch
question from a real deployment entirely — they remain configured, but nothing depends on
getting them right.

Unset in development, on purpose. `npm run dev:frontend` serves the UI from Vite with hot
reload and proxies `/api` and `/ws` to :3000. Setting `FRONTEND_DIST_PATH` in development
serves a *stale* `dist/` from a second URL, which is a confusing way to spend an
afternoon, so this is opt-in rather than "serve it if the directory happens to exist".

## D2 — The frontend addresses its own origin, never a hardcoded host

`API_BASE` was the literal string `http://localhost:3000` and `WS_URL` pinned port 3000
explicitly. That is correct exactly when the browser is on the same machine as the
backend, and this deployment is the case where it is not: served from the bench, the UI
loaded in a browser here and then sent every request to port 3000 of *this* machine.

Both are now derived from `window.location`. This works in all three deployments without
a build-time variable: in production the page origin *is* the API origin (D1); under
`npm run dev:frontend` Vite's proxy forwards `/api` and `/ws` to :3000; and Playwright
drives that same dev server. A hardcoded host can only ever be right for one of the
three.

`WS_URL` picks `wss:` when the page is `https:`. Nothing serves TLS yet — `docs/auth.md`
records why that is a separate decision — but a `ws://` socket opened from an `https://`
page is blocked outright by the browser, and this must not be the thing that fails on the
day TLS lands.

## D3 — The SPA is public; everything else stays behind the auth hook

The static files are exempt from authentication, by an explicit predicate handed to
`registerAuthHook`. They have to be: one of them is the login screen, and a 401 on
`index.html` is a deployment nobody can log into. Serving the bundle anonymously gives
nothing away — it is the same compiled JavaScript that is public in this repository, and
it carries no layout data. Every byte of layout state still arrives over `/api` or `/ws`.

**Registering the plugin before the hook is not sufficient**, and this was found the hard
way: `@fastify/static` registers inside its own encapsulation context, which inherits the
root instance's `onRequest` hooks whenever they were added. The static routes 401'd
despite being registered first. The exemption has to be explicit.

The predicate is **deny-by-default** and lists exactly what `vite build` emits for this
app — `/`, `/index.html`, and `/assets/*` — rather than the tempting inverse ("anything
that is not `/api` or `/ws`"). The two fail in opposite directions. A forgotten public
asset under the explicit rule is a 401 in the browser, immediate and harmless. A route
added outside `/api` under the inverse rule becomes anonymous silently. In a system that
moves hardware, the noisy failure is the right one.

## D4 — The deployed `.env` uses absolute paths

`DATABASE_PATH`, `MIGRATIONS_PATH`, `FRONTEND_DIST_PATH` and `BACKUP_DIR` are all
absolute on the box, and this is not cosmetic. In development the backend runs with a cwd
of `packages/backend`, so `./data/layout.db` and `./migrations` resolve inside that
workspace. The unit's `WorkingDirectory` is the **repository root**, so the same two
relative values would resolve to `/opt/layout-orchestrator/data` (right, by luck) and
`/opt/layout-orchestrator/migrations` (which does not exist — migrations live under
`packages/backend/`). A migrations path that resolves to nothing is a backend that starts
against an unmigrated database.

Absolute paths remove the question rather than answering it.

## D5 — One `.env`, read by two parsers

The unit's `EnvironmentFile` names the same file `dotenv` loads. Two files would be two
things that can disagree about `DATABASE_PATH`, and the way that failure presents — a
backup job faithfully snapshotting a database nothing is writing to — is not one anybody
would guess.

The cost is that the file must satisfy the stricter of the two parsers. systemd accepts
plain `KEY=value` and nothing else: no `export` prefix, no shell expansion, no command
substitution. `deploy/remote-update.sh` greps for `export` and refuses to deploy, because
the alternative is a unit that fails to start with an error naming the file and not the
line.

## D6 — `VACUUM INTO`, never a file copy

`deploy/backup-db.cjs` asks SQLite for a consistent snapshot of the *logical* database,
WAL included, and writes it as one self-contained file. A `cp layout.db` is not merely
crude here, it is wrong — and wrong in the worst way, producing a backup that restores
cleanly and is missing the most recent session's work.

The script is plain CommonJS with no build step and no new dependency: it resolves
`better-sqlite3` from the backend workspace, which is already installed and is the same
SQLite build the backend writes with. A `sqlite3` CLI would be a second,
differently-versioned SQLite on the box, and is not installed there anyway.

Three details that are deliberate:

- **`fileMustExist: true`.** Without it, a mistyped `DATABASE_PATH` makes better-sqlite3
  create an empty database, and the job then cheerfully backs up nothing, every night,
  until someone needs a restore.
- **The source is opened read-write**, though the snapshot never modifies it. A readonly
  connection to a WAL database still has to map the `-shm` file, which is the one thing
  that fails for reasons unrelated to the backup.
- **Retention only ever considers this script's own naming** (`layout-<stamp>.db`), so a
  hand-made copy left in the same directory is never deleted by the timer.

Snapshots land in `/opt/layout-orchestrator/backups`, which is the **same disk** as the
database. That is a real limitation of a single-disk bench box and not a design position:
it protects against corruption, a bad migration and an accidental delete, and not against
the disk failing. Pulling a snapshot to the development machine periodically is what
closes that, and it is a manual step today.

## D7 — Log retention is a journald decision, not logrotate

The backend writes structured JSON straight to stdout through the hand-rolled
`{info,warn,error}` interface. **Pino is not a dependency of any workspace**, despite what
`docs/project-plan.md` said until this change corrected it. Under systemd, stdout lands in
the journal — so there is no log file, and nothing for logrotate to rotate. Retention is
`SystemMaxUse` and `MaxRetentionSec` in a `journald.conf.d` drop-in.

**Severity does not survive the trip into the journal**, and this is worth knowing before
you go looking for an error that is there. Everything the logger writes goes to
`process.stdout`, which journald records at `info` priority for the whole unit — the
severity lives in a `level` field *inside* the JSON, which journald does not parse. So
`journalctl -p err -u layout-orchestrator` returns nothing at all, cheerfully, whatever
has happened; filter on the payload (`grep '"level":"error"'`) instead. Making `-p` work
would mean emitting systemd's `<N>` prefixes and setting `SyslogLevelPrefix`, which is a
change to the logging interface rather than to this deployment, and is not worth making
until something wants it.

journald has no per-unit retention, so both settings are host-wide. Acceptable on a
dedicated bench box, and the reason the numbers are modest (500 MB, 30 days) rather than
generous.

**Rate limiting is switched off**, deliberately. The default — 10000 messages per 30 s per
service — is sensible protection for a chatty web app and the wrong trade for a control
system: the moment worth having a log of is a fault cascade, which is exactly the moment
that trips the limit and starts dropping the lines that explain it. "Suppressed N
messages" in place of the evidence is not a log. `SystemMaxUse` bounds the disk instead.

## D8 — A restart is the whole upgrade procedure

Migrations apply automatically on startup from `MIGRATIONS_PATH`, so `systemctl restart`
after a build is the entire deployment. There is deliberately **no** separate migrate step
in the unit or in `remote-update.sh`: a second migrator racing the in-process one is the
failure this arrangement avoids, and a step that can be forgotten is a step that will be.

## D9 — No start-rate limit, and a missing serial port is a crash

`StartLimitIntervalSec=0`. A missing or unplugged command station is a startup throw, not
a degraded mode: the process exits and systemd retries every 5 s. Under the default limit
systemd gives up after five attempts and leaves the unit `failed`, which is the wrong
resting state — a control system that cannot reach its hardware should keep saying so,
not go quiet.

## D10 — Deploy from a commit, build on the box

`deploy/deploy.sh` never copies source. The target checks out a git ref from GitHub, so
what runs on the layout is always a commit that exists in the repository and never
someone's uncommitted working tree.

`node_modules` is installed on the box regardless of where the code came from:
`serialport` and `@node-rs/argon2` are native modules, and a Windows build is not a Linux
one. `better-sqlite3` is native too but is N-API since v13 and ships a prebuilt
`linux-x64.node` inside the package, so it loads without compiling — see the pin note
below for why the floor is v13.

**`better-sqlite3` floor is `>=13`, and this is a hard requirement, not housekeeping.**
Node 24.19.0 added self-removing cleanup hooks to `node::ObjectWrap`
([nodejs/node#63642](https://github.com/nodejs/node/pull/63642)); the NAN-style
`ObjectWrap` that better-sqlite3 v11 used calls `RemoveEnvironmentCleanupHook` from a
statement destructor that runs under GC with no entered context, so the process aborts
(`Assertion failed: (env) != nullptr` at `hooks.cc:142`, SIGABRT). It fires on garbage
collection, not on any particular request, so it looks intermittent and unrelatable to
what the operator was doing. v13's node-addon-api rewrite removes that code path
entirely — the prebuilt binary does not import the symbol. The abort is **not**
fail-safe: a loco under power keeps running until systemd restarts the unit ~5 s later,
which is the one way this stack moves hardware without meaning to. Do not downgrade the
driver below 13, and do not pin Node back below 24.19 to "fix" a build — the driver floor
is the fix. This also raises the root `engines.node` to `>=22` (v13's floor).

The remote half lives in `deploy/remote-update.sh` and is **piped over SSH stdin** rather
than run from the target's own checkout. That keeps the whole thing free of nested shell
quoting, and means the deploy logic comes from the machine you invoked it on rather than
from whatever commit happens to be checked out on the target. `bash -s` is explicit
because the account's login shell on the bench is fish, in which none of these scripts are
valid syntax.

## D11 — Node from NodeSource, not a version manager

systemd starts the service with no login shell, so a version manager living in a shell
profile is invisible to it. NodeSource puts a real `/usr/bin/node` on the box, which is
the path the unit names.

## D12 — What the unit is *not* allowed to do

The hardening block is `ProtectSystem=strict` plus the usual `Protect*`/`Restrict*` set,
with two paths named read-write: `data/` and `backups/`.

`PrivateDevices=yes` is **deliberately absent** from the main unit. It hides `/dev/ttyACM*`
and the command station link would never open. It *is* set on the backup unit, which has
no business touching a serial port.

---

## Out of scope, and why

- **TLS and `COOKIE_SECURE=true`.** A separate decision with its own recorded threat model
  in `docs/auth.md`. The network is private; `.env.example` already warns that flipping the
  cookie flag before TLS exists makes every session fail closed.
- **Provisioning the host itself** — the OS, the udev rule that names
  `/dev/picodcc-dccex`, the broker. `bootstrap.sh` installs Node, the units and the
  journald drop-in; everything under it is the operator's.
- **Exposing mosquitto on the LAN.** It listens on `127.0.0.1:1883` only, which is
  sufficient because the orchestrator runs on the same box. The ESP sensor and point
  controllers cannot reach it until a listener is opened, and that is a firmware-session
  concern with an authentication question attached — see `docs/mqtt-contract.md`.

---

## Runbook

One-time, on the bench box:

```bash
curl -fsSL https://raw.githubusercontent.com/bazauto/layout-orchestration/main/deploy/bootstrap.sh | bash
# then write /opt/layout-orchestrator/.env, and put a database in data/
sudo systemctl enable --now layout-orchestrator
```

Thereafter, from the development machine:

```bash
bash deploy/deploy.sh                # origin/main
bash deploy/deploy.sh <tag|sha>      # anything else
```

| Task | Command |
|---|---|
| Follow the logs | `journalctl -u layout-orchestrator -f` |
| Errors since boot | `journalctl -u layout-orchestrator -b \| grep '"level":"error"'` |
| Service state | `systemctl status layout-orchestrator` |
| Back up now | `sudo systemctl start layout-orchestrator-backup` |
| Backup history | `journalctl -u layout-orchestrator-backup` |
| When is the next backup | `systemctl list-timers layout-orchestrator-backup` |
| Restore a snapshot | stop the service, copy the snapshot over `data/layout.db`, **delete `layout.db-wal` and `layout.db-shm`**, start |
| Pull a snapshot off the box | `scp pbarrett@172.18.10.240:/opt/layout-orchestrator/backups/layout-*.db .` |

The restore step's parenthesis is the important half: a `VACUUM INTO` snapshot is a
complete database on its own, and leaving the old WAL beside it under the same name is how
you resurrect the state you were trying to roll back.
