// Operator-curated remote MCP OAuth registration. Never accept a client id,
// authorization URL, redirect URI, or token endpoint from an end-user request.
// Registry records must be provisioned only after resource/issuer metadata
// discovery and contractual verification; this registry does not do discovery.
import { buildMcpOAuthAuthorizeUrl, type McpOAuthOwner, type McpOAuthStateStore, type PendingMcpOAuth } from './mcp-oauth-state.js';
import { parseProtectedResourceMetadata, parseAuthorizationServerMetadata } from './mcp-oauth-metadata.js';

export interface McpOAuthProviderRegistration {
  id: string;
  clientId: string;
  redirectUri: string;
  requestedScopes: string[];
  protectedResourceMetadata: unknown;
  authorizationServerMetadata: unknown;
  resource: string;
  issuer: string;
}

interface VerifiedRegistration {
  id: string; clientId: string; redirectUri: string; requestedScopes: string[];
  resource: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string;
}

function validateRegistration(reg: McpOAuthProviderRegistration): VerifiedRegistration {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(reg.id) || !reg.clientId || reg.clientId.length > 512) throw new Error('MCP_OAUTH_REGISTRATION_INVALID');
  const resource = parseProtectedResourceMetadata(reg.protectedResourceMetadata, reg.resource);
  const auth = parseAuthorizationServerMetadata(reg.authorizationServerMetadata, reg.issuer);
  if (!resource.authorizationServers.includes(auth.issuer)) throw new Error('MCP_OAUTH_ISSUER_NOT_AUTHORIZED');
  const callback = new URL(reg.redirectUri);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash ||
      callback.search || callback.pathname !== '/api/v1/oauth/mcp/callback') throw new Error('MCP_OAUTH_REDIRECT_REJECTED');
  if (!Array.isArray(reg.requestedScopes) || reg.requestedScopes.length > 32 ||
      reg.requestedScopes.some((scope) => typeof scope !== 'string' || !scope || !/^[\x21-\x7E]+$/.test(scope) || /\s/.test(scope))) throw new Error('MCP_OAUTH_SCOPES_INVALID');
  if (reg.requestedScopes.some((scope) => !resource.scopesSupported.includes(scope))) throw new Error('MCP_OAUTH_UNADVERTISED_SCOPE');
  return { id: reg.id, resource: resource.resource, issuer: auth.issuer, clientId: reg.clientId,
    redirectUri: callback.href, requestedScopes: [...new Set(reg.requestedScopes)],
    authorizationEndpoint: auth.authorizationEndpoint, tokenEndpoint: auth.tokenEndpoint };
}

export class McpOAuthProviderRegistry {
  private readonly providers = new Map<string, VerifiedRegistration>();
  constructor(registrations: readonly McpOAuthProviderRegistration[]) {
    for (const item of registrations) {
      const verified = validateRegistration(item);
      if (this.providers.has(verified.id)) throw new Error('MCP_OAUTH_DUPLICATE_PROVIDER');
      this.providers.set(verified.id, verified);
    }
  }
  public start(providerId: string, owner: McpOAuthOwner, states: McpOAuthStateStore): string {
    const registration = this.providers.get(providerId);
    if (!registration) throw new Error('MCP_OAUTH_PROVIDER_NOT_AVAILABLE');
    const issued = states.issue(owner, { resource: registration.resource, issuer: registration.issuer,
      clientId: registration.clientId, redirectUri: registration.redirectUri });
    return buildMcpOAuthAuthorizeUrl({ authorizationEndpoint: registration.authorizationEndpoint,
      clientId: registration.clientId, redirectUri: registration.redirectUri,
      resource: registration.resource, scope: registration.requestedScopes, request: issued });
  }
  public requestedScopesFor(pending: PendingMcpOAuth): string[] {
    const registration = [...this.providers.values()].find((provider) =>
      provider.resource === pending.resource && provider.issuer === pending.issuer &&
      provider.clientId === pending.clientId && provider.redirectUri === pending.redirectUri);
    if (!registration) throw new Error('MCP_OAUTH_REGISTRATION_CHANGED');
    return [...registration.requestedScopes];
  }

  public resolveTrustedTokenEndpoint(pending: PendingMcpOAuth): string {
    const registration = [...this.providers.values()].find((provider) =>
      provider.resource === pending.resource && provider.issuer === pending.issuer &&
      provider.clientId === pending.clientId && provider.redirectUri === pending.redirectUri);
    if (!registration) throw new Error('MCP_OAUTH_REGISTRATION_CHANGED');
    return registration.tokenEndpoint;
  }
}
