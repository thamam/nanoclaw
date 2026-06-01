#!/bin/bash
# Idempotent installer for the nanoclaw SSH gate on a destination host (rog, ec2-db, …).
# Run from a workstation that already has SSH access to the target via a name in ~/.ssh/config.
#
# Usage:   scripts/deploy-ssh-gate.sh <ssh-host-alias>
# Example: scripts/deploy-ssh-gate.sh rog
#
# Idempotent: safe to re-run. Backs up authorized_keys + approved.json before
# touching. Skips the authorized_keys patch if it's already in place.
#
# What it deploys on the target:
#   1. /usr/local/bin/nanoclaw-ssh-gate   (the wrapper, from scripts/nanoclaw-ssh-gate.sh here)
#   2. Forced-command line on the x-service-bot@xps key in ~/.ssh/authorized_keys
#   3. ~/.config/nanoclaw/approved.json   (seeded with [] if missing)
#   4. ~/.config/nanoclaw/slack-webhook.url (touched empty; populate to enable Slack alerts)
#
# After running: ssh <alias> 'uptime' from any nanoclaw-agent container exercises
# the gate end-to-end. Read-only ops auto-OK; mutating denied with approve instructions;
# destructive hard-blocked.

set -euo pipefail
HOST="${1:?Usage: $0 <ssh-host-alias>}"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
WRAPPER_SRC="${SCRIPT_DIR}/nanoclaw-ssh-gate.sh"

if [ ! -f "$WRAPPER_SRC" ]; then
  echo "ERROR: wrapper source not found at $WRAPPER_SRC" >&2
  exit 1
fi

echo "[1/4] copying wrapper to $HOST"
scp -q "$WRAPPER_SRC" "$HOST:/tmp/nanoclaw-ssh-gate.sh"

echo "[2/4] installing wrapper to /usr/local/bin/ (needs sudo on target)"
ssh "$HOST" 'sudo install -m 0755 -o root -g root /tmp/nanoclaw-ssh-gate.sh /usr/local/bin/nanoclaw-ssh-gate'

echo "[3/4] patching ~/.ssh/authorized_keys with forced-command (idempotent)"
ssh "$HOST" 'python3 - <<PYEOF
from pathlib import Path
ak = Path.home()/".ssh"/"authorized_keys"
text = ak.read_text() if ak.exists() else ""
out_lines = []
patched = False
already = False
for line in text.splitlines():
    if "x-service-bot@xps" not in line:
        out_lines.append(line); continue
    if "/usr/local/bin/nanoclaw-ssh-gate" in line:
        out_lines.append(line); already = True; continue
    # Find where the key part starts (ssh-ed25519 / ssh-rsa)
    key_start = line.find("ssh-")
    key_part = line[key_start:] if key_start >= 0 else line
    new = "command=\"/usr/local/bin/nanoclaw-ssh-gate\",no-pty,no-X11-forwarding,no-port-forwarding,no-agent-forwarding " + key_part
    out_lines.append(new); patched = True
if patched:
    backup = ak.with_suffix(".bak.before-nanoclaw-gate")
    if not backup.exists():
        backup.write_text(text)
    ak.write_text("\n".join(out_lines) + "\n")
    print("patched (backup at", backup, ")")
elif already:
    print("already gated — no change")
else:
    print("WARNING: no x-service-bot@xps key found in authorized_keys; nothing to patch")
PYEOF'

echo "[4/4] seeding ~/.config/nanoclaw/{approved.json,slack-webhook.url}"
ssh "$HOST" 'mkdir -p ~/.config/nanoclaw && \
  [ -f ~/.config/nanoclaw/approved.json ]      || echo "[]" > ~/.config/nanoclaw/approved.json && \
  [ -f ~/.config/nanoclaw/slack-webhook.url ]  || : > ~/.config/nanoclaw/slack-webhook.url && \
  ls -la ~/.config/nanoclaw/'

echo
echo "Done. Verify with:  ssh $HOST 'uptime'   # should run"
echo "                     ssh $HOST 'rm -rf /tmp/x'   # should FORBIDDEN-block"
