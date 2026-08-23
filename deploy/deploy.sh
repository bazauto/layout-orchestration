#!/usr/bin/env bash
#
# Deploy a commit to the layout box (#143).
#
# Run FROM the development machine (Git Bash on Windows is fine):
#
#   bash deploy/deploy.sh              # deploys origin/main
#   bash deploy/deploy.sh v0.2.0       # deploys a tag, branch or SHA
#
# Nothing is copied from here: the target checks out the ref from GitHub, so
# what runs on the layout is always a commit that exists in the repository and
# never someone's uncommitted working tree. node_modules is built on the box —
# better-sqlite3, serialport and @node-rs/argon2 are native modules, and a
# Windows build is not a Linux one.
set -euo pipefail

TARGET="${TARGET:-pbarrett@172.18.10.240}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/layout-orchestrator}"
REF="${1:-origin/main}"

printf '\n\033[1m==> Deploying %s to %s:%s\033[0m\n' "$REF" "$TARGET" "$DEPLOY_DIR"

# remote-update.sh is piped over stdin rather than run from the target's own
# checkout: no nested shell quoting to get wrong, and the deploy logic comes
# from the machine you invoked it on. `bash -s` because the account's login
# shell on the bench is fish, in which none of this is valid syntax.
ssh "$TARGET" "bash -s -- '$REF' '$DEPLOY_DIR'" < "$(dirname "$0")/remote-update.sh"

printf '\n\033[1m==> Deployed. Logs: ssh %s journalctl -u layout-orchestrator -f\033[0m\n' "$TARGET"
