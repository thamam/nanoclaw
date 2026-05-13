/**
 * Credential proxy — sits between containers and the Anthropic API.
 * Injects real credentials into requests, replacing container placeholders.
 *
 * Auth modes:
 *   - api-key:  Uses ANTHROPIC_API_KEY from .env (never expires until revoked)
 *   - oauth:    Uses CLAUDE_CODE_OAUTH_TOKEN from .env (1-year token via `claude setup-token`)
 *
 * No auto-refresh logic — tokens are either long-lived API keys or 1-year
 * setup-tokens that don't need runtime refresh.
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding']);

/**
 * Walk an /v1/messages request body and add ttl: "1h" to every
 * cache_control: { type: "ephemeral" } block that does not already have a TTL.
 *
 * The Claude Code Agent SDK marks the static parts of the prompt (system,
 * tools, CLAUDE.md preamble) with cache_control: { type: "ephemeral" } and
 * leaves TTL unset, which the API defaults to 5 minutes. Upgrading to 1h
 * amortizes the cache-write cost across ~12x more turns, cutting the
 * cache_create spend that dominates this fleet bill. The 1h-write price is
 * 2x base vs 1.25x for 5m; break-even is ~2 reuses inside the hour.
 */
export function upgradeCacheControlTtl(
  body: Buffer,
  urlPath: string,
): { body: Buffer; modified: boolean; upgradedCount: number } {
  if (!urlPath.startsWith("/v1/messages")) {
    return { body, modified: false, upgradedCount: 0 };
  }
  if (body.length === 0) {
    return { body, modified: false, upgradedCount: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf-8"));
  } catch {
    return { body, modified: false, upgradedCount: 0 };
  }
  let upgradedCount = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const cc = obj.cache_control;
    if (cc && typeof cc === "object" && !Array.isArray(cc)) {
      const ccObj = cc as Record<string, unknown>;
      if (ccObj.type === "ephemeral" && ccObj.ttl == null) {
        ccObj.ttl = "1h";
        upgradedCount++;
      }
    }
    for (const key of Object.keys(obj)) visit(obj[key]);
  };
  visit(parsed);
  if (upgradedCount === 0) {
    return { body, modified: false, upgradedCount: 0 };
  }
  return {
    body: Buffer.from(JSON.stringify(parsed), "utf-8"),
    modified: true,
    upgradedCount,
  };
}


/** Detect auth mode by checking for ANTHROPIC_API_KEY in .env */
export function detectAuthMode(): AuthMode {
  const env = readEnvFile(['ANTHROPIC_API_KEY']);
  return env.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

/**
 * Start the credential proxy HTTP server.
 *
 * @param port - Port to listen on (0 for random)
 * @param host - Bind address (default '127.0.0.1')
 * @param envOverrides - When provided, skips .env reading (for tests)
 */
export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  envOverrides?: Record<string, string>,
): Promise<http.Server> {
  // Load environment
  const env = envOverrides ?? readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const apiKey = env.ANTHROPIC_API_KEY;
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  const upstreamBase = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const mode: AuthMode = apiKey ? 'api-key' : 'oauth';

  if (mode === 'oauth' && !oauthToken) {
    logger.warn(
      'OAuth mode but CLAUDE_CODE_OAUTH_TOKEN is empty. ' +
      'Run `claude setup-token` to generate a 1-year token and add it to .env',
    );
  }

  // --- Proxy server ---
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('error', (err) => {
      logger.error({ err }, 'Client request error');
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Bad Request');
      }
    });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const upstream = new URL(req.url || '/', upstreamBase);
      const isHttps = upstream.protocol === 'https:';
      const transport = isHttps ? https : http;

      // Cost-opt: upgrade ephemeral cache_control blocks to 1h TTL on the way out.
      const { body, modified: cacheUpgraded, upgradedCount } = upgradeCacheControlTtl(
        rawBody,
        upstream.pathname,
      );
      if (cacheUpgraded) {
        logger.debug(
          { upgradedCount, path: upstream.pathname },
          'Upgraded ephemeral cache_control to 1h TTL',
        );
      }

      // Build headers
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        if (typeof value === 'string') {
          headers[key] = value;
        } else if (Array.isArray(value)) {
          headers[key] = value.join(', ');
        }
      }

      // Replace host
      headers['host'] = upstream.host;
      // Update content-length
      headers['content-length'] = String(body.length);

      // Inject credentials
      if (mode === 'api-key' && apiKey) {
        headers['x-api-key'] = apiKey;
      } else if (mode === 'oauth' && oauthToken) {
        // Remove placeholder x-api-key and inject real OAuth token
        delete headers['x-api-key'];
        headers['authorization'] = `Bearer ${oauthToken}`;
      }

      const upstreamReq = transport.request(
        {
          hostname: upstream.hostname,
          port: upstream.port || (isHttps ? 443 : 80),
          path: upstream.pathname + upstream.search,
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );

      upstreamReq.on('error', (err) => {
        logger.error({ err }, 'Upstream request failed');
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('Bad Gateway');
        } else {
          res.destroy();
        }
      });

      upstreamReq.write(body);
      upstreamReq.end();
    });
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address() as { port: number };
      logger.info({ port: addr.port, mode }, 'Credential proxy started');
      resolve(server);
    });
  });
}
