// Policy engine — loads and classifies commands against permissions.yaml.
//
// Tier precedence: deny → password → ask → allow. First match wins.
// Unmatched commands return { tier: 'default' } (caller treats as deny).
//
// Pattern syntax: literal prefix OR glob with `*` wildcard. The first `*`
// and any subsequent chars match any characters (including whitespace).

import { readFileSync, statSync } from 'node:fs';
import yaml from 'js-yaml';

export type Tier = 'deny' | 'password' | 'ask' | 'allow';

export interface PolicyEntry {
  pattern: string;
  class?: string;   // only for password tier
  reason?: string;  // optional rule description
}

export interface Scope {
  deny: PolicyEntry[];
  password: PolicyEntry[];
  ask: PolicyEntry[];
  allow: PolicyEntry[];
}

export interface Operator {
  telegramUserId: number;
  slackUserId: string;
}

export interface Policy {
  operator: Operator;
  passphrases: Record<string, string>;
  scopes: Record<string, Partial<Scope>>;
}

export interface Classification {
  tier: Tier | 'default';
  matchedRule?: PolicyEntry;
  passwordClass?: string;
}

const EMPTY_SCOPE: Scope = { deny: [], password: [], ask: [], allow: [] };

/** Convert a glob-with-* pattern to a regex matching from the start of the command. */
function patternToRegex(pattern: string): RegExp {
  // Escape regex metachars except `*`, then turn `*` into `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped);
}

function matchEntry(entry: PolicyEntry, command: string): boolean {
  return patternToRegex(entry.pattern).test(command);
}

function normalizeEntries(raw: unknown, tier: Tier, scopeName: string): PolicyEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`Scope "${scopeName}" tier "${tier}" must be an array, got ${typeof raw}`);
  }
  return raw.map((item, i) => {
    if (typeof item === 'string') {
      if (tier === 'password') {
        throw new Error(`Scope "${scopeName}" tier "password" entry #${i} must be { pattern, class }, not a string`);
      }
      return { pattern: item };
    }
    if (typeof item === 'object' && item && typeof (item as any).pattern === 'string') {
      const entry: PolicyEntry = { pattern: (item as any).pattern };
      if ((item as any).class !== undefined) entry.class = String((item as any).class);
      if ((item as any).reason !== undefined) entry.reason = String((item as any).reason);
      if (tier === 'password' && !entry.class) {
        throw new Error(`Scope "${scopeName}" password entry #${i} missing "class"`);
      }
      return entry;
    }
    throw new Error(`Scope "${scopeName}" tier "${tier}" entry #${i} is malformed`);
  });
}

function normalizeScope(raw: unknown, scopeName: string): Partial<Scope> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Scope "${scopeName}" must be a mapping`);
  }
  const obj = raw as Record<string, unknown>;
  const result: Partial<Scope> = {};
  if ('deny' in obj) result.deny = normalizeEntries(obj.deny, 'deny', scopeName);
  if ('password' in obj) result.password = normalizeEntries(obj.password, 'password', scopeName);
  if ('ask' in obj) result.ask = normalizeEntries(obj.ask, 'ask', scopeName);
  if ('allow' in obj) result.allow = normalizeEntries(obj.allow, 'allow', scopeName);
  return result;
}

/** Parse and validate a policy YAML string. Throws on malformed input. */
export function parsePolicy(raw: string): Policy {
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err: any) {
    throw new Error(`YAML parse error: ${err.message}`);
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('Policy must be a YAML mapping at the top level');
  }
  const root = doc as Record<string, unknown>;

  const operatorRaw = root.operator as Record<string, unknown> | undefined;
  if (!operatorRaw || typeof operatorRaw !== 'object') {
    throw new Error('Policy missing "operator" section');
  }
  const tg = operatorRaw.telegram_user_id;
  const sl = operatorRaw.slack_user_id;
  if (typeof tg !== 'number' || typeof sl !== 'string') {
    throw new Error('operator.telegram_user_id must be number and operator.slack_user_id must be string');
  }

  const passphrasesRaw = root.passphrases;
  if (!passphrasesRaw || typeof passphrasesRaw !== 'object' || Array.isArray(passphrasesRaw)) {
    throw new Error('Policy missing "passphrases" mapping');
  }
  const passphrases: Record<string, string> = {};
  for (const [k, v] of Object.entries(passphrasesRaw as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(`passphrases.${k} must be a string`);
    }
    passphrases[k] = v;
  }

  const scopesRaw = root.scopes;
  if (!scopesRaw || typeof scopesRaw !== 'object' || Array.isArray(scopesRaw)) {
    throw new Error('Policy missing "scopes" mapping');
  }
  const scopes: Record<string, Partial<Scope>> = {};
  for (const [name, raw] of Object.entries(scopesRaw as Record<string, unknown>)) {
    scopes[name] = normalizeScope(raw, name);
  }
  if (!scopes.default) {
    throw new Error('Policy missing required scope "default"');
  }

  // Validate password entries point at known classes.
  for (const [scopeName, scope] of Object.entries(scopes)) {
    for (const entry of scope.password ?? []) {
      if (entry.class && !(entry.class in passphrases)) {
        throw new Error(`Scope "${scopeName}" password entry references unknown class "${entry.class}"`);
      }
    }
  }

  return {
    operator: { telegramUserId: tg, slackUserId: sl },
    passphrases,
    scopes,
  };
}

/**
 * Resolve effective scope for a target: per-bot (or "self") overrides override
 * individual tiers on top of the `default` scope. Unspecified tiers inherit.
 */
export function resolveScope(policy: Policy, botOrSelf: string): Scope {
  const def = policy.scopes.default ?? {};
  const override = policy.scopes[botOrSelf] ?? {};
  return {
    deny: override.deny ?? def.deny ?? [],
    password: override.password ?? def.password ?? [],
    ask: override.ask ?? def.ask ?? [],
    allow: override.allow ?? def.allow ?? [],
  };
}

/** Classify a command against a resolved scope. First match wins in tier order. */
export function classify(policy: Policy, botOrSelf: string, command: string): Classification {
  const scope = resolveScope(policy, botOrSelf);
  const cmd = command.trim();

  if (cmd.includes('\n') || cmd.includes('\r')) {
    return {
      tier: 'deny',
      matchedRule: {
        pattern: '<newline-injection guard>',
        reason: 'command contains newline or carriage return',
      },
    };
  }

  for (const e of scope.deny) {
    if (matchEntry(e, cmd)) return { tier: 'deny', matchedRule: e };
  }
  for (const e of scope.password) {
    if (matchEntry(e, cmd)) return { tier: 'password', matchedRule: e, passwordClass: e.class };
  }
  for (const e of scope.ask) {
    if (matchEntry(e, cmd)) return { tier: 'ask', matchedRule: e };
  }
  for (const e of scope.allow) {
    if (matchEntry(e, cmd)) return { tier: 'allow', matchedRule: e };
  }
  return { tier: 'default' };
}

// ─── File loader with mtime-based caching ───────────────────────────────────

interface CacheEntry {
  mtimeMs: number;
  policy: Policy | null;
  error: Error | null;
}

let cache: { path: string; entry: CacheEntry } | null = null;

/**
 * Load (or reload) the policy from a YAML file. Caches by mtime — if the file
 * changes, the next call reparses. Errors are cached too: once malformed,
 * every caller sees the error until the file is fixed (fail-closed).
 */
export function loadPolicyFromFile(path: string): Policy {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (err: any) {
    throw new Error(`Policy file not found or unreadable at ${path}: ${err.message}`);
  }

  if (cache && cache.path === path && cache.entry.mtimeMs === mtimeMs) {
    if (cache.entry.error) throw cache.entry.error;
    return cache.entry.policy!;
  }

  try {
    const raw = readFileSync(path, 'utf8');
    const policy = parsePolicy(raw);
    cache = { path, entry: { mtimeMs, policy, error: null } };
    return policy;
  } catch (err: any) {
    const wrapped = new Error(`Policy load failed: ${err.message}`);
    cache = { path, entry: { mtimeMs, policy: null, error: wrapped } };
    throw wrapped;
  }
}

/** @internal Test helper — drop the file cache. */
export function _resetPolicyCache(): void {
  cache = null;
}
