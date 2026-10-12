// GitHub OAuth (OAuth App web flow). Provider-specific mechanics live here and in this folder only; the rest of NAgex
// sees GitHub through GitHubConnectionService and the Capability Broker.
//
// Scopes: `read:user` identifies the account; `repo` is required for GitHub to return PRIVATE repositories to an OAuth App
// (there is no read-only private-repo scope for OAuth Apps). NAgex implements read operations only, and every write
// would have to go through the Capability Broker with REQUIRED approval. The requested set can be narrowed per
// deployment with GITHUB_OAUTH_SCOPES (e.g. `read:user public_repo`); the scopes the user actually granted are stored and
// the connection reports what it can really do.
import { NagexError } from '../../common/errors.js';

export const GITHUB_DEFAULT_SCOPES = ['read:user', 'repo'] as const;
export const GITHUB_PROVIDER_TIMEOUT_MS = 10_000;

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface GitHubTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  // epoch ms; null when the token does not expire (the default for OAuth Apps)
  expiresAt: number | null;
  scope: string;
  tokenType: string | null;
}

type FetchFn = typeof fetch;

export function readGitHubOAuthConfig(env: NodeJS.ProcessEnv = process.env): GitHubOAuthConfig | null {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const redirectUri = env.GITHUB_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  const configured = (env.GITHUB_OAUTH_SCOPES ?? '').split(/[\s,]+/).map((scope) => scope.trim()).filter((scope) => /^[a-z:_]+$/i.test(scope));
  return { clientId, clientSecret, redirectUri, scopes: configured.length > 0 ? configured : [...GITHUB_DEFAULT_SCOPES] };
}

export function buildGitHubAuthorizeUrl(config: GitHubOAuthConfig, state: string): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('state', state);
  // The user picks the account on GitHub's own screen; NAgex never assumes one.
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
}

interface GitHubTokenApiPayload {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function isAbortOrTimeout(error: unknown): boolean {
  const name = error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}

async function postToken(body: URLSearchParams, fetchFn: FetchFn, requestId: string, now: () => number): Promise<GitHubTokenResponse> {
  let response: Response;
  try {
    response = await fetchFn('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(GITHUB_PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    if (isAbortOrTimeout(error)) {
      throw new NagexError({ code: 'GITHUB_OAUTH_TIMEOUT', category: 'TIMEOUT', message: 'GitHub did not respond in time.', request_id: requestId });
    }
    throw new NagexError({ code: 'GITHUB_OAUTH_NETWORK_ERROR', category: 'PROVIDER', message: 'Could not reach GitHub.', request_id: requestId });
  }
  const payload = (await response.json().catch(() => ({}))) as GitHubTokenApiPayload;
  // GitHub answers a failed exchange with HTTP 200 and an `error` field.
  if (!response.ok || payload.error || !payload.access_token) {
    throw new NagexError({
      code: 'GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED',
      category: response.status >= 500 ? 'PROVIDER' : 'AUTHENTICATION',
      message: payload.error_description || payload.error || `GitHub token exchange failed with HTTP ${response.status}.`,
      request_id: requestId,
      details: { httpStatus: response.status, oauthError: payload.error ?? null },
    });
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresAt: typeof payload.expires_in === 'number' ? now() + Math.max(0, payload.expires_in - 60) * 1000 : null,
    scope: payload.scope ?? '',
    tokenType: payload.token_type ?? null,
  };
}

export async function exchangeGitHubAuthorizationCode(config: GitHubOAuthConfig, code: string, fetchFn: FetchFn, requestId: string, now: () => number = Date.now): Promise<GitHubTokenResponse> {
  return postToken(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.redirectUri }), fetchFn, requestId, now);
}

// Only relevant when the OAuth App has expiring user tokens enabled (a refresh token is then issued).
export async function refreshGitHubAccessToken(config: GitHubOAuthConfig, refreshToken: string, fetchFn: FetchFn, requestId: string, now: () => number = Date.now): Promise<GitHubTokenResponse> {
  return postToken(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }), fetchFn, requestId, now);
}

// Best-effort: revokes the user's whole authorization of this OAuth App. A failure must never block a local disconnect.
export async function revokeGitHubGrant(config: GitHubOAuthConfig, accessToken: string, fetchFn: FetchFn): Promise<void> {
  try {
    await fetchFn(`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/grant`, {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      },
      body: JSON.stringify({ access_token: accessToken }),
      signal: AbortSignal.timeout(GITHUB_PROVIDER_TIMEOUT_MS),
    });
  } catch {
    /* ignore: local disconnect proceeds regardless */
  }
}
