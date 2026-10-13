// Operator-curated remote MCP OAuth registration. Never accept a client id,
// authorization URL, redirect URI, or token endpoint from an end-user request.
// Registry records must be provisioned only after resource/issuer metadata
// discovery and contractual verification; this registry does not do discovery.
import { buildMcpOAuthAuthorizeUrl, type McpOAuthOwner, type McpOAuthStateStore, type PendingMcpOAuth } from './mcp-oauth-state.js';
import { parseProtectedResourceMetadata, parseAuthorizationServerMetadata } from './mcp-oauth-metadata.js';
import type { McpOAuthResponseProfile, McpOAuthTokenAuthMethod } from './mcp-oauth-token.js';

export interface McpOAuthProviderRegistration {
  id: string;
  clientId: string;
  redirectUri: string;
  requestedScopes: string[];
  protectedResourceMetadata: unknown;
  authorizationServerMetadata: unknown;
  resource: string;
  issuer: string;
  // How NAgex authenticates to the token endpoint. Pinned by the operator at registration; 'none' (default) is a public client with PKCE only.
  // 'client_secret_post' needs a secret reference (never the secret itself) and is accepted only when the authorization server advertises it.
  tokenAuthMethod?: McpOAuthTokenAuthMethod;
  clientSecretRef?: string;
  // The MCP Streamable HTTP endpoint (distinct from the RFC 9728 resource identifier for some providers, e.g. Slack). Same origin as the resource.
  mcpEndpoint?: string;
  responseProfile?: McpOAuthResponseProfile;
  displayName?: string;
}

interface VerifiedRegistration {
  id: string; clientId: string; redirectUri: string; requestedScopes: string[];
  resource: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string;
  tokenAuthMethod: McpOAuthTokenAuthMethod; clientSecretRef: string | null; mcpEndpoint: string; responseProfile: McpOAuthResponseProfile; displayName: string;
}

export interface McpOAuthProviderSummary { id: string; displayName: string; mcpEndpoint: string; resource: string; scopes: string[] }

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
  const tokenAuthMethod = reg.tokenAuthMethod ?? 'none';
  if (tokenAuthMethod !== 'none' && tokenAuthMethod !== 'client_secret_post') throw new Error('MCP_OAUTH_TOKEN_AUTH_UNSUPPORTED');
  const advertised = auth.tokenEndpointAuthMethodsSupported;
  // A confidential method must be advertised explicitly; a public client is tolerated when the server says nothing (the RFC default is not usable for it either way).
  if (tokenAuthMethod === 'client_secret_post' ? !advertised?.includes('client_secret_post') : advertised !== null && !advertised.includes('none')) throw new Error('MCP_OAUTH_TOKEN_AUTH_NOT_ADVERTISED');
  const secretRef = reg.clientSecretRef ?? null;
  if (tokenAuthMethod === 'client_secret_post' ? !secretRef || !/^[A-Za-z0-9_.:-]{1,128}$/.test(secretRef) : secretRef !== null) throw new Error('MCP_OAUTH_CLIENT_SECRET_REF_INVALID');
  const responseProfile = reg.responseProfile ?? 'rfc6749';
  if (responseProfile !== 'rfc6749' && responseProfile !== 'slack-user-v2') throw new Error('MCP_OAUTH_RESPONSE_PROFILE_INVALID');
  // The MCP endpoint is where the bearer token is presented: it must stay on the origin of the verified protected resource.
  const mcpEndpoint = new URL(reg.mcpEndpoint ?? resource.resource);
  if (mcpEndpoint.protocol !== 'https:' || mcpEndpoint.username || mcpEndpoint.password || mcpEndpoint.hash || mcpEndpoint.origin !== new URL(resource.resource).origin) throw new Error('MCP_OAUTH_MCP_ENDPOINT_REJECTED');
  return { id: reg.id, resource: resource.resource, issuer: auth.issuer, clientId: reg.clientId,
    redirectUri: callback.href, requestedScopes: [...new Set(reg.requestedScopes)],
    authorizationEndpoint: auth.authorizationEndpoint, tokenEndpoint: auth.tokenEndpoint,
    tokenAuthMethod, clientSecretRef: secretRef, mcpEndpoint: mcpEndpoint.href, responseProfile, displayName: (reg.displayName ?? reg.id).slice(0, 60) };
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
  // Non-secret summaries for the Connections UI. Nothing here can be used to obtain a credential.
  public list(): McpOAuthProviderSummary[] {
    return [...this.providers.values()].map((p) => ({ id: p.id, displayName: p.displayName, mcpEndpoint: p.mcpEndpoint, resource: p.resource, scopes: [...p.requestedScopes] }));
  }
  public has(providerId: string): boolean { return this.providers.has(providerId); }

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

  private registrationFor(pending: PendingMcpOAuth): VerifiedRegistration {
    const registration = [...this.providers.values()].find((provider) =>
      provider.resource === pending.resource && provider.issuer === pending.issuer &&
      provider.clientId === pending.clientId && provider.redirectUri === pending.redirectUri);
    if (!registration) throw new Error('MCP_OAUTH_REGISTRATION_CHANGED');
    return registration;
  }

  public resolveTrustedTokenEndpoint(pending: PendingMcpOAuth): string {
    return this.registrationFor(pending).tokenEndpoint;
  }

  // The pinned client-authentication contract of the registration this flow started from (never taken from the callback).
  public tokenClientAuthFor(pending: PendingMcpOAuth): { method: McpOAuthTokenAuthMethod; secretRef: string | null; responseProfile: McpOAuthResponseProfile } {
    const r = this.registrationFor(pending);
    return { method: r.tokenAuthMethod, secretRef: r.clientSecretRef, responseProfile: r.responseProfile };
  }

  public providerFor(pending: PendingMcpOAuth): { id: string; displayName: string; mcpEndpoint: string } {
    const r = this.registrationFor(pending);
    return { id: r.id, displayName: r.displayName, mcpEndpoint: r.mcpEndpoint };
  }
}
