#!/usr/bin/env bash
#
# The half of a deploy that runs on the layout box (#143).
#
# Not invoked directly. `deploy/deploy.sh` pipes it over SSH stdin
# (`ssh host bash -s -- <ref> <dir>`), which is what keeps the whole thing free
# of nested shell quoting and means the deploy logic always comes from the
# machine you ran it on, not from whatever commit happens to be checked out on
# the target.
#
#   $1  git ref to deploy
#   $2  deployment directory
set -euo pipefail

REF="$1"
DEPLOY_DIR="$2"

cd "$DEPLOY_DIR"

# ── Refuse to deploy onto a configuration that will not start ────────────────
# The unit reads .env via systemd EnvironmentFile, and the backend reads the
# same file via dotenv. systemd is the stricter of the two — no `export`
# prefix, no shell expansion — and a line it cannot parse makes the unit fail
# with an error naming the file rather than the line. Cheaper to catch here.
if [ ! -f .env ]; then
  echo "No .env in $DEPLOY_DIR — see docs/deployment.md" >&2
  exit 1
fi
if grep -nE '^[[:space:]]*export[[:space:]]' .env; then
  echo 'The lines above use `export`, which systemd EnvironmentFile does not accept.' >&2
  exit 1
fi

echo "== fetching"
git fetch --all --tags --prune
git checkout --detach "$REF"
git --no-pager log --oneline -1

# `npm ci`, not `npm install`: the lockfile is the deployed dependency set, and
# native modules (better-sqlite3, serialport, @node-rs/argon2) are built here
# because a Windows build is not a Linux one.
echo "== installing"
npm ci

echo "== building"
npm run build --workspace=packages/backend
npm run build --workspace=packages/frontend

echo "== restarting"
# Migrations apply automatically on startup from MIGRATIONS_PATH, so a restart
# is the entire upgrade procedure — there is no separate migrate step to
# forget, and adding one would race the in-process migrator.
sudo systemctl restart layout-orchestrator
sleep 3
systemctl --no-pager --lines=20 status layout-orchestrator

echo "== health"
curl -fsS http://127.0.0.1:3000/health
echo
