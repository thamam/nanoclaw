#!/bin/bash
# nanoclaw-ssh-gate — forced-command wrapper for X's service SSH key
#
# Installed at /usr/local/bin/nanoclaw-ssh-gate on every host X can SSH to.
# Pinned to X's authorized_keys entry via `command="..."` so X cannot bypass.
#
# Three tiers:
#   AUTO_OK     — read-only, runs immediately (no log)
#   ASK_FIRST   — service-mutating; denied unless allowlisted in approved.json with valid TTL.
#                 Always logged to journald + Slack webhook so Doc sees the request.
#   FORBIDDEN   — destructive; always denied, logged as alert.
#
# Allowlist format (~/.config/nanoclaw/approved.json on this host):
#   [{"pattern": "^systemctl restart lettabot$", "expires_at": "2026-06-01T18:30:00Z", "note": "ops"}]
# Doc appends with a TTL when X asks. Wrapper re-reads on every invocation.
#
# Updated 2026-06-01: initial install. Maintained by Dispatch.

set -u
CMD="${SSH_ORIGINAL_COMMAND:-}"
WHO="$(whoami)@$(hostname)"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
APPROVED="${HOME}/.config/nanoclaw/approved.json"
SLACK_WEBHOOK_FILE="${HOME}/.config/nanoclaw/slack-webhook.url"  # one-line file; empty/missing = no Slack alert

# Empty command = interactive shell request — deny politely.
if [ -z "$CMD" ]; then
  echo "nanoclaw-ssh-gate: interactive shell not allowed. Pass a command to ssh." >&2
  logger -t nanoclaw-ssh-gate "DENIED interactive-shell who=$WHO"
  exit 1
fi

# --- FORBIDDEN patterns (hard reject, alert) ---
FORBIDDEN_RE='(^|[[:space:];|&])(rm[[:space:]]+-[a-z]*r|dd[[:space:]]+if=|mkfs|sudo|su[[:space:]]+-|chmod[[:space:]]+[0-9]+[[:space:]]+/(\.ssh|etc|boot|root)|rm[[:space:]]+-rf|>[[:space:]]*/etc/|>[[:space:]]*~/.ssh|halt|poweroff|reboot|init[[:space:]]+[0-9])'
if printf '%s' "$CMD" | grep -qE "$FORBIDDEN_RE"; then
  echo "nanoclaw-ssh-gate: FORBIDDEN — destructive op blocked: $CMD" >&2
  logger -t nanoclaw-ssh-gate "FORBIDDEN who=$WHO cmd=$CMD"
  if [ -f "$SLACK_WEBHOOK_FILE" ]; then
    URL="$(head -1 "$SLACK_WEBHOOK_FILE")"
    [ -n "$URL" ] && curl -s -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\":no_entry: nanoclaw-ssh-gate FORBIDDEN on $WHO at $TS\\n\\\`\\\`\\\`$CMD\\\`\\\`\\\`\"}" \
      "$URL" >/dev/null 2>&1 &
  fi
  exit 1
fi

# --- AUTO_OK patterns (read-only, runs immediately) ---
# Anchored at command head; only the first token / first pipeline segment is checked.
# We accept the full command line as a single shell pipeline if every executable head matches.
AUTO_OK_RE='^(echo|true|false|pwd|whoami|hostname|uptime|date|id|env|printenv|uname|w|who|users|last|ps|free|df|du|ls|cat|head|tail|tac|nl|wc|grep|egrep|fgrep|find|stat|file|readlink|sort|uniq|cut|awk|sed|tr|md5sum|sha256sum|systemctl[[:space:]]+(status|is-active|is-enabled|show|list-units|list-unit-files|cat)|journalctl|docker[[:space:]]+(ps|logs|inspect|images|stats|version|info|top|port|history)|git[[:space:]]+(status|log|diff|show|branch|remote|rev-parse|describe|ls-files|ls-tree)|gh[[:space:]]+(pr|issue|repo|run|workflow|api)[[:space:]]+(view|list|status|status))($|[[:space:]])'

# Helper: check if a single pipeline component is auto-ok
is_auto_ok() {
  printf '%s' "$1" | grep -qE "$AUTO_OK_RE"
}

# Split command into pipeline segments by | (preserve quoted segments roughly)
ok=1
oldIFS="$IFS"; IFS='|'
for seg in $CMD; do
  # trim leading/trailing whitespace
  seg_trimmed="$(printf '%s' "$seg" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -z "$seg_trimmed" ] && continue
  if ! is_auto_ok "$seg_trimmed"; then
    ok=0
    break
  fi
done
IFS="$oldIFS"

if [ "$ok" -eq 1 ]; then
  # Auto-OK — execute via bash -lc so user shell rc is sourced (PATH etc.)
  exec /bin/bash -lc "$CMD"
fi

# --- ASK_FIRST tier: not auto-ok, not forbidden ---
# Check approved.json for a matching pattern with valid TTL.
approved=0
if [ -f "$APPROVED" ] && command -v python3 >/dev/null 2>&1; then
  approved=$(python3 - "$CMD" "$APPROVED" <<'PYEOF'
import json, sys, re, datetime
cmd = sys.argv[1]
path = sys.argv[2]
try:
    with open(path) as f:
        entries = json.load(f)
except Exception:
    print(0); sys.exit(0)
now = datetime.datetime.now(datetime.timezone.utc)
for e in entries:
    if not isinstance(e, dict):
        continue
    pat = e.get("pattern", "")
    exp = e.get("expires_at", "")
    try:
        exp_dt = datetime.datetime.fromisoformat(exp.replace("Z", "+00:00"))
    except Exception:
        continue
    if exp_dt < now:
        continue
    try:
        if re.search(pat, cmd):
            print(1); sys.exit(0)
    except re.error:
        continue
print(0)
PYEOF
)
fi

if [ "$approved" = "1" ]; then
  logger -t nanoclaw-ssh-gate "APPROVED-EXEC who=$WHO cmd=$CMD"
  # Slack-notify the actual execution too so the audit trail is complete
  if [ -f "$SLACK_WEBHOOK_FILE" ]; then
    URL="$(head -1 "$SLACK_WEBHOOK_FILE")"
    [ -n "$URL" ] && curl -s -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\":white_check_mark: nanoclaw-ssh-gate APPROVED-EXEC on $WHO at $TS\\n\\\`\\\`\\\`$CMD\\\`\\\`\\\`\"}" \
      "$URL" >/dev/null 2>&1 &
  fi
  exec /bin/bash -lc "$CMD"
fi

# Not auto-ok, not approved — deny and post an ask-request to Slack.
echo "nanoclaw-ssh-gate: command not in auto-ok allowlist." >&2
echo "To approve: append to ~/.config/nanoclaw/approved.json on $(hostname) with a TTL." >&2
echo "  pattern matching: $CMD" >&2
logger -t nanoclaw-ssh-gate "ASK-DENY who=$WHO cmd=$CMD"
if [ -f "$SLACK_WEBHOOK_FILE" ]; then
  URL="$(head -1 "$SLACK_WEBHOOK_FILE")"
  [ -n "$URL" ] && curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\":hourglass: nanoclaw-ssh-gate ASK on $WHO at $TS\\nRequested by X:\\n\\\`\\\`\\\`$CMD\\\`\\\`\\\`\\nTo approve, append a JSON entry to \`~/.config/nanoclaw/approved.json\` on \`$(hostname)\` with a TTL.\"}" \
    "$URL" >/dev/null 2>&1 &
fi
exit 1
