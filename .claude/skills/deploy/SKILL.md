---
name: deploy
description: Deploy the orchestrator to the bench box (the Linux machine wired to the layout) and verify it came up. Use when asked to deploy, ship to the bench, push to the layout, restart the layout service, check what is running there, or move the database between the dev machine and the bench.
---

# Deploying to the bench

The bench box is `pbarrett@172.18.10.240` — Linux Mint, key-based SSH, the PicoDCC command
station on `/dev/picodcc-dccex`, mosquitto on localhost. `bazauto/PicoDCC` calls the same
machine "bench". The deployment lives at `/opt/layout-orchestrator`.

`docs/deployment.md` is the reasoning (D1–D12). **Do not read it to perform a deploy** —
everything a deploy needs is below. Read it only when changing how deployment works.

## Before deploying: is anyone driving?

A deploy **restarts the service**, which drops the DCC link, stops the trains and **clears
any latched fault** — including one an operator is in the middle of reading. On 2026-08-23
a redeploy erased a live `link-lost` Safe-Stop eleven seconds after it latched, while the
operator was driving.

So unless the user has just asked for it in the same breath, check and say what you find:

```bash
curl -s http://172.18.10.240:3000/health
```

`{"status":"online","reason":null}` and nobody at the controls — go ahead. A non-null
`reason`, or a train moving, is a question for the user, not a thing to deploy through.

## The deploy

```bash
bash deploy/deploy.sh              # origin/main
bash deploy/deploy.sh <tag|sha>    # anything else
```

That is the whole task. It checks the ref out **from GitHub** on the box, runs `npm ci`,
builds both workspaces, restarts the unit and prints `/health`. So:

- **Merge first.** An unmerged branch cannot be deployed — nothing is copied from here.
- Do not run `npm ci`, `tsc`, `systemctl` or `git` on the box by hand. The script does it.
- Migrations apply on startup, so a restart is the entire upgrade. Never add a migrate step.

## Verifying

The script's own `/health` line is usually enough. If more is wanted:

```bash
curl -s http://172.18.10.240:3000/health
ssh pbarrett@172.18.10.240 systemctl is-active layout-orchestrator
ssh pbarrett@172.18.10.240 journalctl -u layout-orchestrator -b --no-pager | grep '"level":"error"'
```

Note the shape of the last one: run `journalctl` remotely and **pipe into `grep` locally**.
Doing the pipe on the far side means quoting a JSON pattern through fish inside `bash -lc`
inside single quotes, which is three layers of escaping to get wrong.

**`journalctl -p err` returns nothing here, always.** Every log line goes to stdout, which
journald files at `info`; the severity is a `level` field inside the JSON. Grep the
payload, never filter on priority.

The unit name is in every line, so `journalctl` output includes the *previous* process
after a restart. Check the PID before reporting a fault as current — a fault from the
process a deploy replaced is history, not the state of the layout.

## Do not investigate these — they are the expected state

- **`[DccLink] Main track power is off`.** The station reports power; #148 observes it and
  deliberately does not gate on it. Acting on it is #149.
- **Every sensor-backed block reads `unknown`.** The firmware does not re-assert yet
  (#28 D12, batched into #9/#50). Honest, not a regression.
- **The broker listens on `127.0.0.1:1883` only.** Fine for the orchestrator, which is on
  the same box. It means ESP controllers cannot reach it; opening a LAN listener carries an
  authentication question and is not a deploy-time fix.

## Host facts that are easy to get wrong

- **The login shell is fish.** Every remote command needs `ssh host 'bash -lc "…"'` or
  `bash -s`. POSIX syntax sent bare is a parse error, not a failure you will recognise.
- `sudo` is passwordless. Node is at `/usr/bin/node` (NodeSource, not a version manager —
  systemd has no login shell).
- Native modules (`better-sqlite3`, `serialport`, `@node-rs/argon2`) are built on the box.
  Never copy `node_modules` from Windows.

## The `.env` on the box

`/opt/layout-orchestrator/.env`, read by **both** dotenv and systemd's `EnvironmentFile`.

- **Absolute paths only.** The unit's cwd is the repo root, not `packages/backend`, so a
  relative `MIGRATIONS_PATH` points at a directory that does not exist.
- **systemd's grammar**: plain `KEY=value`. No `export`, no shell expansion. `deploy.sh`
  refuses to deploy a file that breaks this.
- **`SENSOR_SIMULATION` must stay `false`.** It is `true` on the dev machine. It is the one
  control that can make the orchestrator believe a block is clear while a train stands in
  it. Never copy the dev value across.

## Moving the database

**Never copy `layout.db`.** It is WAL-mode; the copy restores cleanly and is missing the
last session's work. Take a snapshot instead:

```bash
DATABASE_PATH=./packages/backend/data/layout.db BACKUP_DIR=<dir> node deploy/backup-db.cjs
```

Note the source path — the dev database is under `packages/backend/data/`, not the repo
root. `scp` the resulting single file. On restore, **delete `layout.db-wal` and
`layout.db-shm`** or you resurrect the state you were rolling back.

The box snapshots itself daily (`layout-orchestrator-backup.timer`, 14 retained, same
disk). Run one now with
`ssh pbarrett@172.18.10.240 'bash -lc "sudo systemctl start layout-orchestrator-backup"'`.

## First-time setup on a new box

Only if there is no `/opt/layout-orchestrator` yet:

```bash
ssh <host> 'bash -lc "curl -fsSL https://raw.githubusercontent.com/bazauto/layout-orchestration/main/deploy/bootstrap.sh | bash"'
```

Then write `.env`, put a database in `data/`, `bash deploy/deploy.sh`, and
`sudo systemctl enable --now layout-orchestrator`. `bootstrap.sh` deliberately starts
nothing.
