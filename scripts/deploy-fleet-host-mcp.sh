#!/bin/bash
# Idempotent deploy / drift-check for the fleet-host-mcp service on a destination host.
#
# Usage:
#   scripts/deploy-fleet-host-mcp.sh <ssh-host-alias>            # apply
#   scripts/deploy-fleet-host-mcp.sh --check <ssh-host-alias>    # dry-run, exit non-zero on drift
#
# Source of truth for fleet-host-mcp itself lives at github.com/<your-org>/fleet-host-mcp
# (or your private fork). This script assumes the target already has a clone at
# ~/fleet-host-mcp on the SSH host; it does NOT bootstrap from scratch — for a
# first-time install on a virgin host, also clone the repo there first, then run
# this script.
#
# What this checks / applies:
#   1. ~/fleet-host-mcp exists and is a git repo on the expected branch
#   2. ~/.config/systemd/user/fleet-host-mcp.service is installed and active
#   3. ~/fleet-host-mcp/deploy/secrets.env exists, has GITHUB_TOKEN AND GH_TOKEN
#      synced to the same value (catches the rotation-drift bug from 2026-06-01)
#   4. /run/user/$(id -u)/fleet-host-mcp.sock is being listened on
#   5. (optional) The token in secrets.env matches the token in ~/nanoclaw/.env
#      if both files exist on the same host. This is the "no drift between
#      nanoclaw and fleet-host-mcp" invariant — the exact failure mode that
#      had Relay blocked on 401 for ~2 hours on 2026-06-01.
#
# In --check mode, prints findings and exits non-zero on any drift.
# In apply mode, repairs what's drifted (re-syncs token from nanoclaw/.env if
# present, restarts the service if it's not active, etc.).

set -uo pipefail

MODE=apply
if [ "${1:-}" = "--check" ]; then
  MODE=check
  shift
fi

HOST="${1:?Usage: $0 [--check] <ssh-host-alias>}"

# Run the actual checks remotely via a single SSH invocation to minimize round-trips.
ssh "$HOST" "MODE='$MODE' bash -s" <<'REMOTE_EOF'
set -uo pipefail
MODE="${MODE:-apply}"
RC=0
diff() {
  echo "[DRIFT] $*"
  RC=1
}
note() { echo "[ok]    $*"; }
act()  {
  if [ "$MODE" = "check" ]; then
    diff "would: $*"
  else
    echo "[apply] $*"
    eval "$*"
  fi
}

# 1. repo presence + branch
if [ ! -d "$HOME/fleet-host-mcp/.git" ]; then
  diff "~/fleet-host-mcp is not a git repo (manual clone required first)"
else
  BR="$(cd ~/fleet-host-mcp && git rev-parse --abbrev-ref HEAD)"
  note "fleet-host-mcp repo present, branch=$BR"
fi

# 2. systemd unit
if ! systemctl --user is-active --quiet fleet-host-mcp; then
  diff "fleet-host-mcp.service not active"
  act "systemctl --user restart fleet-host-mcp"
else
  note "fleet-host-mcp.service active"
fi

# 3. secrets.env exists + GH+GITHUB tokens present + equal
SECRETS="$HOME/fleet-host-mcp/deploy/secrets.env"
if [ ! -f "$SECRETS" ]; then
  diff "$SECRETS missing"
else
  GHV="$(grep -E '^GITHUB_TOKEN=' "$SECRETS" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  GTV="$(grep -E '^GH_TOKEN='     "$SECRETS" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  if [ -z "$GHV" ]; then
    diff "GITHUB_TOKEN missing from $SECRETS"
  fi
  if [ -z "$GTV" ]; then
    diff "GH_TOKEN missing from $SECRETS"
  fi
  if [ -n "$GHV" ] && [ -n "$GTV" ] && [ "$GHV" != "$GTV" ]; then
    diff "GITHUB_TOKEN and GH_TOKEN in $SECRETS differ — they should match"
  elif [ -n "$GHV" ]; then
    note "secrets.env tokens present + matched (suffix ${GHV: -4})"
  fi
fi

# 4. socket listening
SOCK="/run/user/$(id -u)/fleet-host-mcp.sock"
if [ ! -S "$SOCK" ]; then
  diff "socket $SOCK missing"
else
  note "socket $SOCK present"
fi

# 5. cross-check vs ~/nanoclaw/.env if both exist (the rotation-drift invariant)
NANO_ENV="$HOME/nanoclaw/.env"
if [ -f "$NANO_ENV" ] && [ -f "$SECRETS" ]; then
  NANO_TOKEN="$(grep -E '^GITHUB_TOKEN=' "$NANO_ENV" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  if [ -n "$NANO_TOKEN" ] && [ -n "$GHV" ] && [ "$NANO_TOKEN" != "$GHV" ]; then
    diff "TOKEN MISMATCH: ~/nanoclaw/.env GITHUB_TOKEN suffix '${NANO_TOKEN: -4}' != fleet-host-mcp secrets.env suffix '${GHV: -4}'"
    act "cp '$SECRETS' '${SECRETS}.bak-\$(date +%Y-%m-%d-%H%M%S)'"
    act "sed -i 's|^GITHUB_TOKEN=.*|GITHUB_TOKEN=${NANO_TOKEN}|' '$SECRETS'"
    act "sed -i 's|^GH_TOKEN=.*|GH_TOKEN=${NANO_TOKEN}|' '$SECRETS'"
    act "systemctl --user restart fleet-host-mcp"
  elif [ -n "$NANO_TOKEN" ]; then
    note "rotation-drift invariant holds (nanoclaw/.env token == fleet-host-mcp secrets.env token)"
  fi
fi

echo
if [ "$RC" -eq 0 ]; then
  echo "RESULT: clean on $(hostname)"
else
  if [ "$MODE" = "check" ]; then
    echo "RESULT: drift found on $(hostname). Run without --check to repair."
  else
    echo "RESULT: drift was found and repaired on $(hostname)."
  fi
fi
exit "$RC"
REMOTE_EOF
