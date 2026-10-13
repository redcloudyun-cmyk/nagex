// How an MCP connection refers to the OAuth credential it uses. The binding is NOT a secret: it names the credential tuple (resource, issuer, client) in the
// owner's encrypted vault. The access token itself never enters the connection record, a view, a log or a browser.
export interface McpOAuthBinding {
  providerId: string;
  resource: string;
  issuer: string;
  clientId: string;
  // Scopes the owner granted (as reported by the provider and verified against the registration), for display.
  scopes: string[];
}

// MISSING: nothing stored (never connected, removed, or the store is unavailable). EXPIRED: stored but past its provider-declared lifetime.
// Both mean REAUTH_REQUIRED: no consequential call is ever attempted with them.
export type McpOAuthBearer = { state: 'OK'; token: string } | { state: 'MISSING' | 'EXPIRED' };

export interface McpOAuthOwnerRef { tenantId: string; principalId: string }

export interface McpOAuthBearerResolver {
  bearerFor(owner: McpOAuthOwnerRef, binding: McpOAuthBinding, now?: number): McpOAuthBearer;
  // Local removal of the stored credential (disconnect). Provider-side revocation is only done where the provider documents it and the owner approves.
  remove(owner: McpOAuthOwnerRef, binding: McpOAuthBinding): void;
}
