// Token exchange for the MCP OAuth authorization-code callback. Tokens and client secrets must never be logged or sent to a browser.
// Client authentication is chosen by the OPERATOR when the provider is registered ('none' or 'client_secret_post'); the secret is resolved server-side and is only
// ever sent to the token endpoint that was pinned from verified authorization-server metadata. The response shape is likewise a pinned, provider-specific profile.
// The protected-resource URL is passed as RFC 8707 'resource'. A returned opaque
// token's audience must additionally be enforced by the resource server.
import http from 'node:http';
import https from 'node:https';
import { NagexError } from '../common/errors.js';
import { assertSafeMcpUrl, createGuardedLookup, readMcpUrlPolicyFromEnv, type McpUrlPolicyOptions } from './mcp-url-policy.js';
import type { PendingMcpOAuth } from './mcp-oauth-state.js';

export const MCP_OAUTH_TOKEN_TIMEOUT_MS = 5000;
export const MCP_OAUTH_TOKEN_MAX_BYTES = 16 * 1024;

interface TokenHttpResponse { status: number; contentType: string; body: string }
export type TokenPost = (url: URL, body: string, policy: McpUrlPolicyOptions) => Promise<TokenHttpResponse>;

function fail(reason: string): never {
  throw new NagexError({
    code: 'MCP_OAUTH_TOKEN_EXCHANGE_FAILED', category: 'PROVIDER',
    message: 'Could not securely complete MCP authorization.',
    details: { reason },
  });
}

export type McpOAuthTokenAuthMethod = 'none' | 'client_secret_post';
// 'rfc6749': { access_token, token_type: Bearer, ... }. 'slack-user-v2': Slack's oauth.v2.user.access (HTTP 200 with ok:true|false, token_type "user",
// scopes comma-separated in authed_user.scope or scope).
export type McpOAuthResponseProfile = 'rfc6749' | 'slack-user-v2';
export interface McpOAuthClientAuthentication { method: McpOAuthTokenAuthMethod; clientSecret?: string }

export interface McpOAuthTokens {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number | null;
  refreshToken: string | null;
  scope: string[];
}

function splitScopes(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

function parseSlackUserTokenResponse(raw: unknown): McpOAuthTokens {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('INVALID_RESPONSE');
  const v = raw as Record<string, unknown>;
  // Slack answers HTTP 200 even for a failed exchange.
  if (v.ok !== true) {
    const code = typeof v.error === 'string' && /^[a-z_]{1,64}$/.test(v.error) ? v.error : 'unknown';
    return fail('PROVIDER_REJECTED:' + code);
  }
  if (v.token_type !== 'user') return fail('UNSUPPORTED_TOKEN_TYPE');
  const top = typeof v.scope === 'string' ? v.scope : undefined;
  const nested = v.authed_user && typeof v.authed_user === 'object' && typeof (v.authed_user as Record<string, unknown>).scope === 'string' ? String((v.authed_user as Record<string, unknown>).scope) : undefined;
  if (v.scope !== undefined && top === undefined) return fail('SCOPE');
  if (top !== undefined && nested !== undefined && splitScopes(top).sort().join(' ') !== splitScopes(nested).sort().join(' ')) return fail('SCOPE_AMBIGUOUS');
  const scopeText = top ?? nested;
  if (scopeText !== undefined && scopeText.length > 4096) return fail('SCOPE');
  // The token is later presented to the MCP server as a Bearer credential; the profile only differs in how the exchange response is spelled.
  return parseTokenResponse({ ...v, token_type: 'Bearer', scope: scopeText === undefined ? undefined : splitScopes(scopeText).join(' ') });
}

function parseTokenResponse(raw: unknown): McpOAuthTokens {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('INVALID_RESPONSE');
  const v = raw as Record<string, unknown>;
  if (v.token_type !== 'Bearer') return fail('UNSUPPORTED_TOKEN_TYPE');
  if (typeof v.access_token !== 'string' || !v.access_token || v.access_token.length > 8192) return fail('ACCESS_TOKEN');
  if (v.refresh_token !== undefined && (typeof v.refresh_token !== 'string' || !v.refresh_token || v.refresh_token.length > 8192)) return fail('REFRESH_TOKEN');
  if (v.expires_in !== undefined && (!Number.isSafeInteger(v.expires_in) || (v.expires_in as number) <= 0 || (v.expires_in as number) > 31536000)) return fail('EXPIRY');
  if (v.scope !== undefined && (typeof v.scope !== 'string' || v.scope.length > 4096)) return fail('SCOPE');
  const scope = typeof v.scope === 'string' ? [...new Set(v.scope.split(' ').filter(Boolean))] : [];
  return { accessToken: v.access_token, tokenType: 'Bearer', expiresIn: typeof v.expires_in === 'number' ? v.expires_in : null, refreshToken: typeof v.refresh_token === 'string' ? v.refresh_token : null, scope };
}

export const guardedMcpOAuthTokenPost: TokenPost = (url, body, policy) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'http:' ? http : https).request(url, {
    method: 'POST', lookup: createGuardedLookup(policy), agent: false, timeout: MCP_OAUTH_TOKEN_TIMEOUT_MS,
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(Buffer.byteLength(body)) },
  }, (response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MCP_OAUTH_TOKEN_MAX_BYTES) { request.destroy(new Error('TOKEN_RESPONSE_TOO_LARGE')); return; }
      chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => resolve({
      status: response.statusCode ?? 0,
      contentType: String(response.headers['content-type'] ?? ''),
      body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  request.on('timeout', () => request.destroy(new Error('TOKEN_TIMEOUT')));
  request.on('error', reject);
  request.end(body);
});

export async function exchangeMcpOAuthCode(
  pending: PendingMcpOAuth,
  authorizationCode: string,
  tokenEndpoint: string,
  requestId: string,
  options: { policy?: McpUrlPolicyOptions; post?: TokenPost; clientAuth?: McpOAuthClientAuthentication; responseProfile?: McpOAuthResponseProfile } = {},
): Promise<McpOAuthTokens> {
  if (!pending || typeof authorizationCode !== 'string' || !authorizationCode || authorizationCode.length > 4096 ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(pending.codeVerifier) ||
    typeof pending.clientId !== 'string' || !pending.clientId ||
    typeof pending.resource !== 'string' || typeof pending.redirectUri !== 'string') return fail('INVALID_CONTEXT');
  const clientAuth: McpOAuthClientAuthentication = options.clientAuth ?? { method: 'none' };
  if (clientAuth.method === 'client_secret_post') {
    // The secret is operator-held and server-resolved; refuse anything that could not be a plain form value.
    if (typeof clientAuth.clientSecret !== 'string' || clientAuth.clientSecret.length === 0 || clientAuth.clientSecret.length > 1024 || /[\u0000-\u001f\u007f]/.test(clientAuth.clientSecret)) return fail('CLIENT_SECRET_UNAVAILABLE');
  } else if (clientAuth.method !== 'none' || clientAuth.clientSecret !== undefined) return fail('CLIENT_AUTH_INVALID');
  const profile = options.responseProfile ?? 'rfc6749';
  if (profile !== 'rfc6749' && profile !== 'slack-user-v2') return fail('RESPONSE_PROFILE_INVALID');
  const policy = options.policy ?? readMcpUrlPolicyFromEnv();
  const endpoint = await assertSafeMcpUrl(tokenEndpoint, requestId, policy);
  // Never accept parameters supplied by the token endpoint itself.
  if (endpoint.search || endpoint.hash) return fail('TOKEN_URL_PARAMETERS');
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: pending.redirectUri,
    client_id: pending.clientId,
    code_verifier: pending.codeVerifier,
    resource: pending.resource,
  });
  if (clientAuth.method === 'client_secret_post') form.set('client_secret', clientAuth.clientSecret as string);
  let response: TokenHttpResponse;
  try {
    response = await (options.post ?? guardedMcpOAuthTokenPost)(endpoint, form.toString(), policy);
  } catch {
    return fail('TRANSPORT');
  }
  if (response.status >= 300 && response.status < 400) return fail('REDIRECT');
  if (response.status !== 200) return fail('HTTP_STATUS');
  if (!/^(application\/json|application\/[\w.+-]+\+json)(?:\s*;|\s*$)/i.test(response.contentType)) return fail('CONTENT_TYPE');
  if (Buffer.byteLength(response.body, 'utf8') > MCP_OAUTH_TOKEN_MAX_BYTES) return fail('RESPONSE_TOO_LARGE');
  let parsed: unknown;
  try { parsed = JSON.parse(response.body); } catch { return fail('INVALID_JSON'); }
  return profile === 'slack-user-v2' ? parseSlackUserTokenResponse(parsed) : parseTokenResponse(parsed);
}
