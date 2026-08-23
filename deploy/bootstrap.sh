#!/usr/bin/env bash
#
# One-time host preparation for the layout box (#143).
#
# Run ON the target machine, once:
#
#   curl -fsSL https://raw.githubusercontent.com/bazauto/layout-orchestration/main/deploy/bootstrap.sh | bash
#
# or, from an existing checkout, `bash deploy/bootstrap.sh`.
#
# Idempotent: every step checks before it acts, so re-running after a partial
# failure is safe and is the intended way to fix one.
#
# What it deliberately does NOT do:
#   - write .env      — that is per-host configuration and carries a password
#   - copy a database — see docs/deployment.md; a WAL database must be moved
#                       with VACUUM INTO, not scp'd file by file
#   - start the service — nothing should drive trains until an operator has
#                       looked at the configuration
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/bazauto/layout-orchestration.git}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/layout-orchestrator}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
NODE_MAJOR="${NODE_MAJOR:-24}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the account that will own the deployment, not as root." >&2
  echo "It calls sudo for the few steps that need it." >&2
  exit 1
fi

# ── Node ─────────────────────────────────────────────────────────────────────
# NodeSource rather than nvm: systemd starts the service with no login shell,
# so a version manager that lives in a shell profile is invisible to it.
# /usr/bin/node is the path the unit file names.
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  say "Node $(node -v) already present"
else
  say "Installing Node ${NODE_MAJOR}.x from NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# better-sqlite3, serialport and @node-rs/argon2 are native modules. Prebuilt
# binaries usually cover this platform, but build-essential and python3 are
# what make `npm ci` fall back to compiling instead of failing.
say "Ensuring build tools for native modules"
sudo apt-get install -y build-essential python3 git

# ── Deployment directory ─────────────────────────────────────────────────────
if [ ! -d "$DEPLOY_DIR/.git" ]; then
  say "Cloning $REPO_URL into $DEPLOY_DIR"
  sudo mkdir -p "$DEPLOY_DIR"
  sudo chown "$SERVICE_USER":"$SERVICE_USER" "$DEPLOY_DIR"
  git clone "$REPO_URL" "$DEPLOY_DIR"
else
  say "$DEPLOY_DIR is already a checkout — leaving it alone"
fi

mkdir -p "$DEPLOY_DIR/data" "$DEPLOY_DIR/backups"
# The database and its snapshots are the only irreplaceable thing on the box.
chmod 700 "$DEPLOY_DIR/data" "$DEPLOY_DIR/backups"

# ── systemd ──────────────────────────────────────────────────────────────────
say "Installing systemd units and the journald drop-in"
for unit in layout-orchestrator.service layout-orchestrator-backup.service layout-orchestrator-backup.timer; do
  sudo install -m 0644 "$DEPLOY_DIR/deploy/$unit" "/etc/systemd/system/$unit"
done
sudo mkdir -p /etc/systemd/journald.conf.d
sudo install -m 0644 "$DEPLOY_DIR/deploy/journald-layout-orchestrator.conf" \
  /etc/systemd/journald.conf.d/layout-orchestrator.conf

sudo systemctl daemon-reload
sudo systemctl restart systemd-journald
sudo systemctl enable layout-orchestrator-backup.timer
sudo systemctl start layout-orchestrator-backup.timer

# ── Serial port ──────────────────────────────────────────────────────────────
if ! id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx dialout; then
  say "Adding $SERVICE_USER to dialout (needed for the DCC serial port)"
  sudo usermod -aG dialout "$SERVICE_USER"
  echo "Log out and back in for the group to apply to your shell."
fi

say "Host prepared."
cat <<'NEXT'
Remaining, in order — see docs/deployment.md:

  1. Write /opt/layout-orchestrator/.env      (start from .env.example)
  2. Move the layout database into data/      (VACUUM INTO snapshot, not scp of the .db)
  3. From the dev machine: bash deploy/deploy.sh
  4. sudo systemctl enable --now layout-orchestrator

Nothing is running yet, and that is on purpose.
NEXT
