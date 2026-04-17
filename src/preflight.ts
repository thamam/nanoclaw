import { readEnvFile } from './env.js';
import { logger } from './logger.js';

/**
 * Preflight credential validation for fail-fast startup.
 *
 * Runs in main() before channel connects. If a required credential is
 * invalid at boot, exit non-zero so systemd marks the unit Failed
 * (loudly visible via `systemctl status`) instead of running
 * silently degraded.
 *
 * Matches the discipline Telegram.connect() already enforces via
 * getMe() — extend to other keys where silent failure is painful.
 */

export interface PreflightResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate GROQ_API_KEY by hitting the /models endpoint.
 *
 * TODO(user): decide the predicate for fail-vs-warn.
 *
 * Constraints / trade-offs to consider:
 *  - 401/403 → definitely invalid key. Should fail startup.
 *  - 5xx / network timeout → Groq outage, key may be fine. Fail startup
 *    means X can't boot during any Groq blip. Warn-and-continue means
 *    we boot deaf (back to today's behavior) if key happens to also
 *    be bad. Which is worse?
 *  - 429 rate-limited at boot → probably indicates a valid key.
 *  - Timeout duration: too short = false failures on slow network;
 *    too long = slow restarts.
 *
 * Fill in the body. Return { ok: false, reason } to fail startup.
 */
export async function validateGroqKey(): Promise<PreflightResult> {
  const env = readEnvFile(['GROQ_API_KEY']);
  const apiKey = env.GROQ_API_KEY || process.env.GROQ_API_KEY;
  if (!apiKey) {
    // No key configured — this is a config gap, not a runtime failure.
    // Warn and continue; smart-trigger will log per-call if anyone
    // tries to use it.
    logger.warn('preflight: GROQ_API_KEY not configured — smart-trigger groups will be disabled');
    return { ok: true };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, reason: `Groq auth failed: ${resp.status}` };
    }
    return { ok: true };
  } catch (err) {
    logger.warn({ err }, 'preflight: Groq probe failed (transient) — booting anyway');
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run all preflight checks. Exits process on fatal failure.
 */
export async function runPreflight(): Promise<void> {
  const checks: Array<[string, () => Promise<PreflightResult>]> = [
    ['groq', validateGroqKey],
  ];

  for (const [name, check] of checks) {
    const result = await check();
    if (!result.ok) {
      logger.fatal({ check: name, reason: result.reason }, 'preflight failed');
      process.exit(1);
    }
    logger.info({ check: name }, 'preflight ok');
  }
}
