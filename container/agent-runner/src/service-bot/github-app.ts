// GitHub App installation token provider.
// Generates JWTs from the App's private key and exchanges them
// for short-lived installation tokens (cached for 55 minutes).
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export interface AppAuthConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

export interface AppTokenProvider {
  getInstallationToken(): Promise<string>;
}

/**
 * Create a GitHub App installation token provider.
 * Generates JWTs from the App's private key and exchanges them
 * for short-lived installation tokens (cached for 55 minutes).
 */
export function createAppTokenProvider(config: AppAuthConfig): AppTokenProvider {
  if (!fs.existsSync(config.privateKeyPath)) {
    throw new Error(
      `GitHub App private key not found at ${config.privateKeyPath}. ` +
      `Check GITHUB_PRIVATE_KEY_PATH.`,
    );
  }

  // Key is read once at construction; restart the process after rotating the key file.
  const privateKey = fs.readFileSync(config.privateKeyPath, 'utf-8');
  let cached: CachedToken | null = null;

  function generateJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iat: now - 60, // 60s clock drift allowance
        exp: now + 600, // 10 min max for GitHub App JWTs
        iss: config.appId,
      }),
    ).toString('base64url');

    const signature = crypto
      .createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(privateKey, 'base64url');

    return `${header}.${payload}.${signature}`;
  }

  async function getInstallationToken(): Promise<string> {
    // Return cached token if still valid (55 min threshold, tokens last 60 min)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.token;
    }

    const jwt = generateJwt();
    const url = `https://api.github.com/app/installations/${config.installationId}/access_tokens`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Failed to get installation token: ${res.status} ${res.statusText}. ${body}`,
      );
    }

    const data = (await res.json()) as { token: string; expires_at: string };
    cached = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime() - 5 * 60 * 1000, // 5-min safety buffer before actual expiry
    };

    return cached.token;
  }

  return { getInstallationToken };
}
