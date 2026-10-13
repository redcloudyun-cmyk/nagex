// Pending OAuth authorization-code transactions for remote MCP connections.
// This is a preparation component, not an HTTP route or live connector.
// State and PKCE verifiers are only held server-side and never serialized to a browser.
import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';

export const MCP_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const MCP_OAUTH_MAX_PENDING = 256;
// One account can hold only a few unfinished flows: starting more retires its oldest, so a single signed-in user can never exhaust the global pending table.
export const MCP_OAUTH_MAX_PENDING_PER_OWNER = 5;

export interface McpOAuthOwner { tenantId: string; principalId: string }
export interface PendingMcpOAuth {
  owner: McpOAuthOwner;
  resource: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  // The RFC 8707 "resource" value exactly as the provider published it (e.g. "https://mcp.slack.com" with no trailing slash). The canonical form above is used
  // for identity binding; providers may compare this parameter as a plain string, so the published spelling is what goes on the wire.
  resourceParameter?: string;
  codeVerifier: string;
  createdAt: number;
}
export interface NewMcpOAuth {
  state: string;
  codeChallenge: string;
  expiresAt: number;
}
export interface McpOAuthStateStore {
  issue(owner: McpOAuthOwner, context: Omit<PendingMcpOAuth, 'owner' | 'codeVerifier' | 'createdAt'>, now?: number): NewMcpOAuth;
  consume(state: string, owner: McpOAuthOwner, now?: number): PendingMcpOAuth | null;
}

function invalid(reason: string): never {
  throw new NagexError({ code: 'MCP_OAUTH_START_REJECTED', category: 'VALIDATION', message: 'Cannot start MCP OAuth.', details: { reason } });
}
function validOwner(owner: McpOAuthOwner): boolean {
  return !!(owner && typeof owner.tenantId === 'string' && owner.tenantId.trim() && typeof owner.principalId === 'string' && owner.principalId.trim());
}
function validHttps(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
}
export function createMcpOAuthStateStore(): McpOAuthStateStore {
  const pending = new Map<string, PendingMcpOAuth>();
  const sweep = (now: number): void => {
    for (const [state, item] of pending) {
      if (now < item.createdAt || now - item.createdAt >= MCP_OAUTH_STATE_TTL_MS) pending.delete(state);
    }
  };
  return {
    issue(owner, context, now = Date.now()) {
      if (!validOwner(owner)) return invalid('OWNER');
      if (!context || !validHttps(context.resource) || !validHttps(context.issuer) || !validHttps(context.redirectUri)
        || typeof context.clientId !== 'string' || !context.clientId.trim() || context.clientId.length > 512) return invalid('CONTEXT');
      if (context.resourceParameter !== undefined && (!validHttps(context.resourceParameter) || new URL(context.resourceParameter).href !== new URL(context.resource).href)) return invalid('CONTEXT');
      sweep(now);
      const mine = [...pending.entries()].filter(([, item]) => item.owner.tenantId === owner.tenantId && item.owner.principalId === owner.principalId);
      for (const [oldState] of mine.slice(0, Math.max(0, mine.length - (MCP_OAUTH_MAX_PENDING_PER_OWNER - 1)))) pending.delete(oldState);
      if (pending.size >= MCP_OAUTH_MAX_PENDING) return invalid('PENDING_LIMIT');
      const state = crypto.randomBytes(32).toString('base64url');
      const codeVerifier = crypto.randomBytes(32).toString('base64url');
      const codeChallenge = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
      pending.set(state, { ...context, owner: { tenantId: owner.tenantId, principalId: owner.principalId }, codeVerifier, createdAt: now });
      return { state, codeChallenge, expiresAt: now + MCP_OAUTH_STATE_TTL_MS };
    },
    consume(state, owner, now = Date.now()) {
      if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
      const record = pending.get(state);
      pending.delete(state); // one-time even on owner mismatch; no replay or probing
      if (!record || !validOwner(owner) || record.owner.tenantId !== owner.tenantId || record.owner.principalId !== owner.principalId
        || now < record.createdAt || now - record.createdAt >= MCP_OAUTH_STATE_TTL_MS) return null;
      return record;
    },
  };
}

export function buildMcpOAuthAuthorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope?: string[];
  request: NewMcpOAuth;
}): string {
  if (!validHttps(input.authorizationEndpoint) || !validHttps(input.redirectUri) || !validHttps(input.resource)
    || !input.clientId || input.clientId.length > 512 || !/^[A-Za-z0-9_-]{43}$/.test(input.request.state)
    || !/^[A-Za-z0-9_-]{43}$/.test(input.request.codeChallenge)) return invalid('AUTHORIZATION_URL');
  if (input.scope !== undefined && (!Array.isArray(input.scope) || input.scope.length > 32
    || input.scope.some((scope) => typeof scope !== 'string' || !/^[\x21-\x7E]{1,255}$/.test(scope) || /[\s]/.test(scope)))) return invalid('SCOPE');
  const url = new URL(input.authorizationEndpoint);
  // Refuse pre-populated protocol parameters rather than silently override server metadata.
  for (const parameter of ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'resource', 'scope']) {
    if (url.searchParams.has(parameter)) return invalid('PREPOPULATED_PARAMETER');
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.request.state);
  url.searchParams.set('code_challenge', input.request.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', input.resource);
  if (input.scope?.length) url.searchParams.set('scope', [...new Set(input.scope)].join(' '));
  return url.toString();
}
