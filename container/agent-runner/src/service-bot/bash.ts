// bash tool — policy-governed shell execution for X.
//
// Unlike run_command (allowlist-only, provably safe), bash supports four
// permission tiers from permissions.yaml: deny, password, ask, allow.
// Default-deny for unmatched commands. Self scope executes locally; other
// bots execute via the existing SSH transport.

import { resolve } from 'node:path';
import {
  loadPolicyFromFile,
  classify,
  type Classification,
  type Policy,
  type Tier,
} from './policy.js';
import { localExec, type LocalExecResult } from './local-exec.js';
import { getBotConfig } from './config.js';
import type { SshExecutor } from './ssh.js';
import { awaitReply, APPROVAL_TIMEOUT_MS, type ReplySender } from './approval.js';
import { emitBashCommand } from './telemetry-emit.js';
import type { GitHubClient } from './github.js';

export const DEFAULT_POLICY_PATH =
  process.env.X_BASH_POLICY_PATH || resolve(process.cwd(), 'permissions.yaml');

export const DEFAULT_BASH_TIMEOUT = 60;
export const MAX_BASH_TIMEOUT = 300;
export const AUDIT_ISSUE_REPO = 'neuron-box/x-issues';

export type BashDecision =
  | 'executed'
  | 'denied'
  | 'timed_out'
  | 'wrong_passphrase'
  | 'rejected';

export interface BashResult {
  tier: Tier | 'default';
  decision: BashDecision;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  reason?: string;
  auditIssueUrl?: string;
}

export interface BashOptions {
  passphrase?: string;
  timeout?: number;
  /** Originating channel for ask-tier prompts. Defaults to 'telegram'. */
  originatingChannel?: string;
  /** Caller injects these; defaults wire to real impls in register.ts. */
  policyPath?: string;
  ssh?: SshExecutor;
  github?: GitHubClient | null;
  sendPrompt?: ReplySender;
  /** Override timeout for approval waits (ms). For tests. */
  approvalTimeoutMs?: number;
}

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n) : s;
}

async function fileAuditIssue(params: {
  github: GitHubClient | null;
  scope: string;
  command: string;
  tier: string;
  decision: BashDecision;
  reason?: string;
  originatingChannel?: string;
}): Promise<string | undefined> {
  if (!params.github) return undefined;
  const [owner, repo] = AUDIT_ISSUE_REPO.split('/');
  const title = `bash ${params.decision} [${params.tier}] on ${params.scope}: ${truncate(params.command, 80)}`;
  const body = [
    `**Tool:** bash`,
    `**Scope:** ${params.scope}`,
    `**Tier matched:** ${params.tier}`,
    `**Decision:** ${params.decision}`,
    params.reason ? `**Reason:** ${params.reason}` : '',
    params.originatingChannel ? `**Originating channel:** ${params.originatingChannel}` : '',
    `**Timestamp:** ${new Date().toISOString()}`,
    '',
    '```',
    truncate(params.command, 2000),
    '```',
  ].filter(Boolean).join('\n');

  try {
    const issue = await params.github.createIssue({
      owner,
      repo,
      title,
      body,
      labels: ['bash-approval', 'needs-approval'],
    });
    return issue.html_url;
  } catch (err: any) {
    console.warn(`[bash] Failed to file audit issue: ${err.message}`);
    return undefined;
  }
}

/** Execute the command on the target — locally for 'self', via SSH otherwise. */
async function execute(
  bot: string,
  command: string,
  timeoutSec: number,
  ssh?: SshExecutor,
): Promise<LocalExecResult> {
  if (bot === 'self') {
    return localExec(command, { timeout: timeoutSec });
  }
  if (!ssh) throw new Error('bash: ssh executor required for non-self scope');
  const config = getBotConfig(bot);
  const result = await ssh(config.sshTarget, command, { commandTimeout: timeoutSec });
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

/**
 * Main entry point. `bot` is either "self" or a registered bot name.
 * `command` is the shell command verbatim. `passphrase` required only
 * when the matched tier is "password".
 */
export async function bashCommand(
  bot: string,
  command: string,
  options: BashOptions = {},
): Promise<BashResult> {
  const scope = bot;
  const policyPath = options.policyPath ?? DEFAULT_POLICY_PATH;
  const timeoutSec = Math.min(
    Math.max(1, options.timeout ?? DEFAULT_BASH_TIMEOUT),
    MAX_BASH_TIMEOUT,
  );
  const commandSnippet = truncate(command);

  // Load policy (cached + mtime-checked). Fail closed on parse error.
  let policy: Policy;
  try {
    policy = loadPolicyFromFile(policyPath);
  } catch (err: any) {
    const result: BashResult = {
      tier: 'default',
      decision: 'denied',
      reason: err.message,
    };
    await emitBashCommand({ scope, tier: 'default', decision: 'denied', commandSnippet }).catch(() => {});
    return result;
  }

  const cls: Classification = classify(policy, scope, command);

  switch (cls.tier) {
    case 'allow':
      return handleAllow({ scope, command, commandSnippet, timeoutSec, ssh: options.ssh });

    case 'password':
      return handlePassword({
        scope,
        command,
        commandSnippet,
        passphrase: options.passphrase,
        passwordClass: cls.passwordClass!,
        policy,
        timeoutSec,
        ssh: options.ssh,
        github: options.github ?? null,
        originatingChannel: options.originatingChannel,
      });

    case 'ask':
      return handleAsk({
        scope,
        command,
        commandSnippet,
        policy,
        timeoutSec,
        ssh: options.ssh,
        github: options.github ?? null,
        originatingChannel: options.originatingChannel ?? 'telegram',
        sendPrompt: options.sendPrompt,
        approvalTimeoutMs: options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
      });

    case 'deny': {
      const reason = cls.matchedRule?.reason ?? `matched deny pattern "${cls.matchedRule?.pattern}"`;
      const issueUrl = await fileAuditIssue({
        github: options.github ?? null,
        scope,
        command,
        tier: 'deny',
        decision: 'denied',
        reason,
        originatingChannel: options.originatingChannel,
      });
      await emitBashCommand({ scope, tier: 'deny', decision: 'denied', commandSnippet }).catch(() => {});
      return { tier: 'deny', decision: 'denied', reason, auditIssueUrl: issueUrl };
    }

    case 'default':
    default: {
      const reason = 'no policy match';
      const issueUrl = await fileAuditIssue({
        github: options.github ?? null,
        scope,
        command,
        tier: 'default',
        decision: 'denied',
        reason,
        originatingChannel: options.originatingChannel,
      });
      await emitBashCommand({ scope, tier: 'default', decision: 'denied', commandSnippet }).catch(() => {});
      return { tier: 'default', decision: 'denied', reason, auditIssueUrl: issueUrl };
    }
  }
}

// ─── tier handlers ──────────────────────────────────────────────────────────

async function handleAllow(p: {
  scope: string;
  command: string;
  commandSnippet: string;
  timeoutSec: number;
  ssh?: SshExecutor;
}): Promise<BashResult> {
  const out = await execute(p.scope, p.command, p.timeoutSec, p.ssh);
  await emitBashCommand({
    scope: p.scope,
    tier: 'allow',
    decision: 'executed',
    exitCode: out.exitCode,
    commandSnippet: p.commandSnippet,
  }).catch(() => {});
  return {
    tier: 'allow',
    decision: 'executed',
    stdout: out.stdout,
    stderr: out.stderr,
    exitCode: out.exitCode,
  };
}

async function handlePassword(p: {
  scope: string;
  command: string;
  commandSnippet: string;
  passphrase?: string;
  passwordClass: string;
  policy: Policy;
  timeoutSec: number;
  ssh?: SshExecutor;
  github: GitHubClient | null;
  originatingChannel?: string;
}): Promise<BashResult> {
  const expected = p.policy.passphrases[p.passwordClass];
  if (!expected) {
    // Should have been caught in parsePolicy; treat as denied defensively.
    const reason = `unknown password class "${p.passwordClass}"`;
    await emitBashCommand({
      scope: p.scope, tier: 'password', decision: 'denied', commandSnippet: p.commandSnippet,
    }).catch(() => {});
    return { tier: 'password', decision: 'denied', reason };
  }
  if (!p.passphrase || p.passphrase !== expected) {
    const issueUrl = await fileAuditIssue({
      github: p.github,
      scope: p.scope,
      command: p.command,
      tier: 'password',
      decision: 'wrong_passphrase',
      reason: `risk class "${p.passwordClass}"`,
      originatingChannel: p.originatingChannel,
    });
    await emitBashCommand({
      scope: p.scope,
      tier: 'password',
      decision: 'wrong_passphrase',
      commandSnippet: p.commandSnippet,
    }).catch(() => {});
    return {
      tier: 'password',
      decision: 'wrong_passphrase',
      reason: `passphrase missing or incorrect for risk class "${p.passwordClass}"`,
      auditIssueUrl: issueUrl,
    };
  }

  const out = await execute(p.scope, p.command, p.timeoutSec, p.ssh);
  await emitBashCommand({
    scope: p.scope,
    tier: 'password',
    decision: 'executed',
    exitCode: out.exitCode,
    commandSnippet: p.commandSnippet,
  }).catch(() => {});
  return {
    tier: 'password',
    decision: 'executed',
    stdout: out.stdout,
    stderr: out.stderr,
    exitCode: out.exitCode,
  };
}

async function handleAsk(p: {
  scope: string;
  command: string;
  commandSnippet: string;
  policy: Policy;
  timeoutSec: number;
  ssh?: SshExecutor;
  github: GitHubClient | null;
  originatingChannel: string;
  sendPrompt?: ReplySender;
  approvalTimeoutMs: number;
}): Promise<BashResult> {
  if (!p.sendPrompt) {
    // No channel wired — fail closed rather than auto-approve.
    const reason = 'ask-tier command with no channel sender configured';
    await emitBashCommand({
      scope: p.scope, tier: 'ask', decision: 'denied', commandSnippet: p.commandSnippet,
    }).catch(() => {});
    return { tier: 'ask', decision: 'denied', reason };
  }

  const operatorId = p.originatingChannel === 'slack'
    ? p.policy.operator.slackUserId
    : String(p.policy.operator.telegramUserId);

  if (!operatorId || operatorId === '0' || operatorId === 'REPLACE_ME') {
    const reason = 'operator identity not configured for ask tier';
    await emitBashCommand({
      scope: p.scope, tier: 'ask', decision: 'denied', commandSnippet: p.commandSnippet,
    }).catch(() => {});
    return { tier: 'ask', decision: 'denied', reason };
  }

  const prompt = `X wants to run \`${truncate(p.command, 400)}\` on \`${p.scope}\` — reply \`approve\` or \`deny\` within 5 minutes.`;
  const approval = await awaitReply({
    channel: p.originatingChannel,
    userId: operatorId,
    timeoutMs: p.approvalTimeoutMs,
    promptText: prompt,
    sendPrompt: p.sendPrompt,
  });

  if (approval.outcome === 'timed_out') {
    const issueUrl = await fileAuditIssue({
      github: p.github,
      scope: p.scope,
      command: p.command,
      tier: 'ask',
      decision: 'timed_out',
      reason: '5-minute approval window elapsed with no reply',
      originatingChannel: p.originatingChannel,
    });
    await emitBashCommand({
      scope: p.scope, tier: 'ask', decision: 'timed_out', commandSnippet: p.commandSnippet,
    }).catch(() => {});
    return { tier: 'ask', decision: 'timed_out', reason: 'approval timed out', auditIssueUrl: issueUrl };
  }

  if (approval.outcome === 'denied') {
    await emitBashCommand({
      scope: p.scope, tier: 'ask', decision: 'rejected', commandSnippet: p.commandSnippet,
    }).catch(() => {});
    return { tier: 'ask', decision: 'rejected', reason: 'operator replied deny' };
  }

  // approved
  const out = await execute(p.scope, p.command, p.timeoutSec, p.ssh);
  await emitBashCommand({
    scope: p.scope,
    tier: 'ask',
    decision: 'executed',
    exitCode: out.exitCode,
    commandSnippet: p.commandSnippet,
  }).catch(() => {});
  return {
    tier: 'ask',
    decision: 'executed',
    stdout: out.stdout,
    stderr: out.stderr,
    exitCode: out.exitCode,
  };
}
