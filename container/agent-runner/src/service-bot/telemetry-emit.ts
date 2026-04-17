// Telemetry emission — sends service_action events to the UTI telemetry service.

import { getBotConfig } from './config.js';

export interface ServiceAction {
  targetBot: string; // bot name (e.g. "db", "nook")
  action: string; // e.g. "restart", "config_edit", "log_review", "health_check", "bash_command"
  trigger: 'ticket' | 'watcher' | 'manual';
  ticketRef?: string; // GitHub Issue URL if applicable
  result: 'success' | 'failed' | 'rejected' | 'denied' | 'timed_out' | 'wrong_passphrase';
  summary: string;
  /** Optional extra structured payload — e.g. bash-tool scope / tier. */
  extra?: Record<string, unknown>;
}

export interface BashCommandEvent {
  scope: string;             // "self" or a bot name
  tier: string;              // "deny" | "password" | "ask" | "allow" | "default"
  decision: 'executed' | 'denied' | 'timed_out' | 'wrong_passphrase' | 'rejected';
  exitCode?: number;
  commandSnippet: string;    // already truncated by caller
}

/**
 * Emit a bash_command telemetry event. This is a thin wrapper over
 * emitServiceAction that enforces the 200-char command cap at the
 * telemetry layer. Passphrases are NEVER logged — callers must not
 * include passphrase text in `commandSnippet`.
 */
export async function emitBashCommand(ev: BashCommandEvent): Promise<void> {
  const snippet = ev.commandSnippet.length > 200
    ? ev.commandSnippet.slice(0, 200)
    : ev.commandSnippet;

  const resultMap: Record<BashCommandEvent['decision'], ServiceAction['result']> = {
    executed: 'success',
    denied: 'denied',
    timed_out: 'timed_out',
    wrong_passphrase: 'wrong_passphrase',
    rejected: 'rejected',
  };

  await emitServiceAction({
    targetBot: ev.scope,
    action: 'bash_command',
    trigger: 'manual',
    result: resultMap[ev.decision],
    summary: `bash ${ev.decision} [${ev.tier}] on ${ev.scope}: "${snippet}"` +
      (ev.exitCode !== undefined ? ` — exit ${ev.exitCode}` : ''),
    extra: {
      scope: ev.scope,
      tier: ev.tier,
      decision: ev.decision,
      exit_code: ev.exitCode,
      command: snippet,
    },
  });
}

const TELEMETRY_TIMEOUT_MS = 3000;

/**
 * Resolve a bot name to its UTI telemetry bot_id.
 * Returns undefined if the bot has no telemetryBotId configured.
 */
function resolveTargetBotId(botName: string): string | undefined {
  // "self" scope refers to X's own host — report under X's own telemetry ID.
  if (botName === 'self') {
    return process.env.TELEMETRY_BOT_ID;
  }
  try {
    const config = getBotConfig(botName);
    return config.telemetryBotId;
  } catch {
    return undefined;
  }
}

/**
 * Emit a service_action event to the telemetry service.
 * Fails silently (logs warning) — telemetry should never block bot actions.
 */
export async function emitServiceAction(action: ServiceAction): Promise<void> {
  const telemetryUrl = process.env.TELEMETRY_URL;
  const token = process.env.TELEMETRY_REGISTRATION_TOKEN;
  const botId = process.env.TELEMETRY_BOT_ID;

  if (!telemetryUrl || !token || !botId) {
    console.warn(
      '[telemetry] Missing env vars (TELEMETRY_URL, TELEMETRY_REGISTRATION_TOKEN, or TELEMETRY_BOT_ID). Skipping emit.',
    );
    return;
  }

  const targetBotId = resolveTargetBotId(action.targetBot);
  if (!targetBotId) {
    console.warn(
      `[telemetry] No telemetryBotId configured for bot "${action.targetBot}". Skipping emit.`,
    );
    return;
  }

  const event = {
    timestamp: new Date().toISOString(),
    bot_id: botId,
    event_type: 'service_action',
    payload: {
      target_bot_id: targetBotId,
      action: action.action,
      trigger: action.trigger,
      ticket_ref: action.ticketRef,
      result: action.result,
      summary: action.summary,
      ...(action.extra ? { extra: action.extra } : {}),
    },
  };

  try {
    const response = await fetch(`${telemetryUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(
        `[telemetry] Ingest returned HTTP ${response.status}: ${response.statusText}`,
      );
    }
  } catch (err: any) {
    console.warn(`[telemetry] Failed to emit service_action: ${err.message}`);
  }
}
