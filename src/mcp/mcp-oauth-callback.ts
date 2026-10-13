// Internal MCP OAuth callback transaction. Not wired to a public route yet.
// Ownership comes from a verified NAgex session, never from callback query data.
// Token endpoint is resolved from SERVER-TRUSTED issuer metadata, not caller input.
import { NagexError } from '../common/errors.js';
import { exchangeMcpOAuthCode, type McpOAuthTokens } from './mcp-oauth-token.js';
import type { McpOAuthOwner, McpOAuthStateStore, PendingMcpOAuth } from './mcp-oauth-state.js';
import type { McpOAuthCredentialIdentity } from './mcp-oauth-credential-vault.js';

export interface McpOAuthCredentialWriter {
  save(identity: McpOAuthCredentialIdentity, tokens: McpOAuthTokens, now?: number): void;
}
export interface McpOAuthCallbackDeps {
  stateStore: McpOAuthStateStore;
  vault: McpOAuthCredentialWriter;
  // Must consult trusted discovery metadata pinned during authorization start.
  // This callback must NOT accept a token URL supplied by browser parameters.
  resolveTrustedTokenEndpoint: (pending: PendingMcpOAuth) => Promise<string>;
  // Resolved exclusively from the operator-vetted provider registry; never from query params.
  resolveRequestedScopes: (pending: PendingMcpOAuth) => string[];
  exchange?: typeof exchangeMcpOAuthCode;
}

function invalid(reason: string): never {
  throw new NagexError({
    code: 'MCP_OAUTH_CALLBACK_REJECTED',
    category: 'AUTHORIZATION',
    message: 'This MCP authorization could not be completed. Please reconnect.',
    details: { reason },
  });
}

export async function completeMcpOAuthCallback(
  deps: McpOAuthCallbackDeps,
  owner: McpOAuthOwner,
  query: { state?: unknown; code?: unknown; error?: unknown },
  requestId: string,
  now: number = Date.now(),
): Promise<{ status: 'CREDENTIAL_STORED'; resource: string; issuer: string }> {
  // Consume state BEFORE checking provider success. A denied callback must not
  // be replayable later with an injected authorization code.
  const state = typeof query.state === 'string' ? query.state : undefined;
  const pending = deps.stateStore.consume(state ?? '', owner, now);
  if (!pending) return invalid('STATE_INVALID_OR_OWNER_MISMATCH');
  if (query.error !== undefined) return invalid('PROVIDER_DENIED');
  if (typeof query.code !== 'string' || !query.code || query.code.length > 4096) return invalid('CODE_INVALID');
  const endpoint = await deps.resolveTrustedTokenEndpoint(pending);
  // The actual token transport re-validates outbound endpoint DNS/SSRF.
  const requestedScopes = deps.resolveRequestedScopes(pending);
  if (!Array.isArray(requestedScopes) || requestedScopes.some((scope) => typeof scope !== 'string' || !scope)) return invalid('SCOPE_POLICY_INVALID');
  const tokens = await (deps.exchange ?? exchangeMcpOAuthCode)(pending, query.code, endpoint, requestId);
  // Never store a token carrying an unexpected elevation. If scopes were
  // requested, require an explicit provider-reported scope list; an omitted
  // grant cannot be assumed to match the authorization request.
  if ((requestedScopes.length > 0 && tokens.scope.length === 0) ||
      tokens.scope.some((scope) => !requestedScopes.includes(scope))) return invalid('TOKEN_SCOPE_MISMATCH');
  const identity: McpOAuthCredentialIdentity = {
    tenantId: pending.owner.tenantId, principalId: pending.owner.principalId,
    resource: pending.resource, issuer: pending.issuer, clientId: pending.clientId,
  };
  // Must be synchronous and durable or throw. No success reply on save error.
  deps.vault.save(identity, tokens, now);
  return { status: 'CREDENTIAL_STORED', resource: pending.resource, issuer: pending.issuer };
}
