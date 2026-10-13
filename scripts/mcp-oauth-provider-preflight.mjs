#!/usr/bin/env node
// Read-only preflight for an operator-chosen public MCP OAuth provider.
// NO account connection, NO token acquisition, NO writes, NO access to a
// private provider's authenticated data. Verifies only protected metadata.
// Run after npm run build; exits nonzero if metadata is missing or unsafe.
import { getMcpOAuthMetadata } from '../dist/src/mcp/mcp-oauth-discovery.js';
import { parseProtectedResourceMetadata, parseAuthorizationServerMetadata } from '../dist/src/mcp/mcp-oauth-metadata.js';

const CANDIDATES = Object.freeze({
  slack: {
    // Slack's RFC9728 protected resource identifier is its origin, not the
    // /mcp Streamable HTTP endpoint. These serve distinct protocol roles.
    mcpEndpoint: 'https://mcp.slack.com/mcp',
    resource: 'https://mcp.slack.com',
    protectedMetadata: 'https://mcp.slack.com/.well-known/oauth-protected-resource',
    authorizationMetadata: 'https://mcp.slack.com/.well-known/oauth-authorization-server',
  },
});

const id = process.argv[2] || 'slack';
const candidate = CANDIDATES[id];
if (!candidate || process.argv.length > 3) {
  console.error('Usage: node scripts/mcp-oauth-provider-preflight.mjs [slack]');
  process.exitCode = 2;
} else {
  try {
    const document = await getMcpOAuthMetadata(candidate.protectedMetadata, 'req_mcp_preflight');
    const metadata = parseProtectedResourceMetadata(document, candidate.resource);
    // This is a vendor-documented endpoint, not a guessed URL or a link
    // followed blindly from untrusted metadata.
    const authRaw = await getMcpOAuthMetadata(candidate.authorizationMetadata, 'req_mcp_preflight_auth');
    const auth = parseAuthorizationServerMetadata(authRaw, candidate.resource);
    if (!metadata.authorizationServers.includes(auth.issuer)) throw new Error('MCP_OAUTH_ISSUER_NOT_AUTHORIZED');
    const supportedMethods = Array.isArray(authRaw?.token_endpoint_auth_methods_supported)
      ? authRaw.token_endpoint_auth_methods_supported.filter((method) => typeof method === 'string')
      : [];
    const result = {
      provider: id,
      resourceVerified: metadata.resource === new URL(candidate.resource).href,
      preflight: 'METADATA_VERIFIED',
      protectedMetadataRead: true,
      authorizationMetadataVerified: true,
      pkceS256: auth.codeChallengeMethodsSupported.includes('S256'),
      requiredTokenClientAuth: supportedMethods,
      // This probe checks metadata only, not whether NAgex implements the
      // provider's confidential-client exchange or has any provider keys.
      providerOAuthReady: false,
      issuerCount: metadata.authorizationServers.length,
      scopeCount: metadata.scopesSupported.length,
      // We do not print metadata endpoints or credentials into CI logs.
      realOAuthConnected: false,
      tokenExchangeTested: false,
      mcpToolsCertified: false,
    };
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      provider: id,
      preflight: 'BLOCKED',
      reason: error?.code || 'METADATA_NOT_VERIFIED',
      realOAuthConnected: false,
    }));
    process.exitCode = 1;
  }
}
