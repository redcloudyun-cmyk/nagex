// Token exchange primitive for a future MCP OAuth authorization-code callback.
// No HTTP route invokes this code yet. Tokens must never be logged or sent to a browser.
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

export interface McpOAuthTokens {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number | null;
  refreshToken: string | null;
  scope: string[];
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
  options: { policy?: McpUrlPolicyOptions; post?: TokenPost } = {},
): Promise<McpOAuthTokens> {
  if (!pending || typeof authorizationCode !== 'string' || !authorizationCode || authorizationCode.length > 4096 ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(pending.codeVerifier) ||
    typeof pending.clientId !== 'string' || !pending.clientId ||
    typeof pending.resource !== 'string' || typeof pending.redirectUri !== 'string') return fail('INVALID_CONTEXT');
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
  return parseTokenResponse(parsed);
}
