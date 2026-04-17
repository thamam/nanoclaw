// Key management tools — switch and monitor multi-subscription OAuth keys.
// These are X's self-management tools — they SSH to XPS where NanoClaw runs.

import type { SshExecutor } from './ssh.js';
import { emitServiceAction } from './telemetry-emit.js';

// XPS SSH target — X runs on this machine
const XPS_TARGET = process.env.XPS_SSH_TARGET || 'xps';
const KEYS_CONFIG_PATH = '~/nanoclaw/config/keys.json';
const ACTIVE_KEY_PATH = '~/nanoclaw/data/active-key.json';

// ─── Types ──────────────────────────────────────────────────────────────────

interface KeyEntry {
  label: string;
  description: string;
  proxy_port: number;
  added_at: string;
}

interface KeysConfig {
  keys: Record<string, KeyEntry>;
}

interface ActiveKeyState {
  active: string;
  switched_at: string;
  switched_by: string;
}

interface TelemetryEvent {
  bot_id: string;
  event_type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

// Per-key usage summary from telemetry
interface KeyUsageSummary {
  input_tokens: number;
  output_tokens: number;
  event_count: number;
}

// ─── switchKey ──────────────────────────────────────────────────────────────

/**
 * Switch the active subscription key. Operator-only action.
 * Writes active-key.json atomically on XPS.
 */
export async function switchKey(
  label: string,
  ssh: SshExecutor,
): Promise<string> {
  if (!label || !label.trim()) {
    return 'Error: Key label is required.';
  }

  const trimmedLabel = label.trim().toLowerCase();

  // Read current keys config
  const configResult = await ssh(XPS_TARGET, `cat ${KEYS_CONFIG_PATH}`);
  if (configResult.exitCode !== 0) {
    return `Error: Could not read keys config: ${configResult.stderr.trim() || 'file not found'}. Is multi-key mode configured?`;
  }

  let keysConfig: KeysConfig;
  try {
    keysConfig = JSON.parse(configResult.stdout);
  } catch {
    return 'Error: keys.json is malformed JSON.';
  }

  if (!keysConfig.keys || typeof keysConfig.keys !== 'object') {
    return 'Error: keys.json has invalid structure (missing "keys" object).';
  }

  // Validate label exists
  if (!(trimmedLabel in keysConfig.keys)) {
    const available = Object.keys(keysConfig.keys).join(', ');
    return `Error: Key "${trimmedLabel}" not found. Available keys: ${available}`;
  }

  // Read current active key for the "from" field
  let previousLabel = '(none)';
  const activeResult = await ssh(XPS_TARGET, `cat ${ACTIVE_KEY_PATH}`);
  if (activeResult.exitCode === 0) {
    try {
      const activeState: ActiveKeyState = JSON.parse(activeResult.stdout);
      previousLabel = activeState.active;
    } catch {
      // corrupt — that's fine, we're overwriting it
    }
  }

  // Don't switch to the already-active key
  if (previousLabel === trimmedLabel) {
    return `Key "${trimmedLabel}" is already active. No switch needed.`;
  }

  // Atomic write: temp file + mv
  const newState = JSON.stringify({
    active: trimmedLabel,
    switched_at: new Date().toISOString(),
    switched_by: 'operator',
  });

  const writeCmd = [
    `mkdir -p ~/nanoclaw/data`,
    `printf '%s' '${newState.replace(/'/g, "'\\''")}' > ${ACTIVE_KEY_PATH}.tmp`,
    `mv ${ACTIVE_KEY_PATH}.tmp ${ACTIVE_KEY_PATH}`,
  ].join(' && ');

  const writeResult = await ssh(XPS_TARGET, writeCmd);
  if (writeResult.exitCode !== 0) {
    return `Error: Failed to write active-key.json: ${writeResult.stderr.trim()}`;
  }

  // Emit key.switched telemetry event (fire-and-forget)
  emitKeySwitch(previousLabel, trimmedLabel).catch(() => {});

  const keyInfo = keysConfig.keys[trimmedLabel];
  return `Switched active key: ${previousLabel} → ${trimmedLabel} (${keyInfo?.description || 'no description'}). Next container spawn will use this subscription.`;
}

// ─── keyStatus ──────────────────────────────────────────────────────────────

/**
 * Show current key status: active key, all available keys, per-key usage.
 */
export async function keyStatus(
  ssh: SshExecutor,
): Promise<string> {
  // Read keys config
  const configResult = await ssh(XPS_TARGET, `cat ${KEYS_CONFIG_PATH}`);
  if (configResult.exitCode !== 0) {
    return 'Multi-key mode is not configured (no keys.json found). X is using a single subscription key.';
  }

  let keysConfig: KeysConfig;
  try {
    keysConfig = JSON.parse(configResult.stdout);
  } catch {
    return 'Error: keys.json is malformed JSON.';
  }

  if (!keysConfig.keys || Object.keys(keysConfig.keys).length === 0) {
    return 'Error: keys.json exists but contains no keys.';
  }

  // Read active key state
  let activeLabel = '(unknown)';
  let switchedAt = '';
  const activeResult = await ssh(XPS_TARGET, `cat ${ACTIVE_KEY_PATH}`);
  if (activeResult.exitCode === 0) {
    try {
      const activeState: ActiveKeyState = JSON.parse(activeResult.stdout);
      activeLabel = activeState.active;
      switchedAt = activeState.switched_at;
    } catch {
      activeLabel = '(corrupt state file)';
    }
  } else {
    // No active-key file — first key is the default
    activeLabel = Object.keys(keysConfig.keys)[0] ?? '(none)';
  }

  // Query per-key usage from telemetry (best-effort)
  const perKeyUsage = await queryPerKeyUsage();

  // Build output
  const lines: string[] = ['**Key Status**', ''];

  // Active key
  lines.push(`Active: **${activeLabel}**`);
  if (switchedAt) {
    lines.push(`Switched at: ${switchedAt}`);
  }
  lines.push('');

  // All keys table
  lines.push('Available keys:');
  for (const [label, entry] of Object.entries(keysConfig.keys)) {
    const marker = label === activeLabel ? ' ← active' : '';
    lines.push(`  ${label}: ${entry.description || '(no description)'} (port ${entry.proxy_port})${marker}`);
  }

  // Per-key usage (if telemetry data available)
  if (perKeyUsage && Object.keys(perKeyUsage).length > 0) {
    lines.push('');
    lines.push('Usage today (per key):');
    for (const [label, usage] of Object.entries(perKeyUsage)) {
      const total = usage.input_tokens + usage.output_tokens;
      lines.push(`  ${label}: ${total.toLocaleString()} tokens (${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out) — ${usage.event_count} requests`);
    }
  } else if (perKeyUsage !== null) {
    lines.push('');
    lines.push('Usage today: no per-key token data yet.');
  }

  return lines.join('\n');
}

// ─── Telemetry query helpers ───────────────────────────────────────────────

const TELEMETRY_QUERY_TIMEOUT_MS = 5000;

/**
 * Query per-key token usage from the telemetry events API for today.
 * Returns a map of key_label -> usage summary, or null if telemetry is unavailable.
 */
export async function queryPerKeyUsage(): Promise<Record<string, KeyUsageSummary> | null> {
  const telemetryUrl = process.env.TELEMETRY_URL;
  const botId = process.env.TELEMETRY_BOT_ID;

  if (!telemetryUrl || !botId) return null;

  try {
    const params = new URLSearchParams({
      bot_id: botId,
      type: 'token_usage',
      since: '24h',
      fields: 'key_label',
      limit: '1000',
    });

    const response = await fetch(`${telemetryUrl}/api/events?${params}`, {
      signal: AbortSignal.timeout(TELEMETRY_QUERY_TIMEOUT_MS),
    });

    if (!response.ok) return null;

    const events = (await response.json()) as TelemetryEvent[];
    const usage: Record<string, KeyUsageSummary> = {};

    for (const event of events) {
      const keyLabel = event.payload?.key_label as string | undefined;
      if (!keyLabel) continue;

      if (!usage[keyLabel]) {
        usage[keyLabel] = { input_tokens: 0, output_tokens: 0, event_count: 0 };
      }

      usage[keyLabel].input_tokens += (event.payload?.input_tokens as number) || 0;
      usage[keyLabel].output_tokens += (event.payload?.output_tokens as number) || 0;
      usage[keyLabel].event_count += 1;
    }

    return usage;
  } catch {
    return null; // telemetry unavailable — don't block status
  }
}

// ─── Telemetry emit helpers ────────────────────────────────────────────────

async function emitKeySwitch(fromKey: string, toKey: string): Promise<void> {
  const telemetryUrl = process.env.TELEMETRY_URL;
  const token = process.env.TELEMETRY_REGISTRATION_TOKEN;
  const botId = process.env.TELEMETRY_BOT_ID;

  if (!telemetryUrl || !token || !botId) return;

  const event = {
    timestamp: new Date().toISOString(),
    bot_id: botId,
    event_type: 'key.switched',
    payload: {
      from_key: fromKey,
      to_key: toKey,
      switched_by: 'operator',
    },
  };

  try {
    await fetch(`${telemetryUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // silent — telemetry should never block key operations
  }
}
