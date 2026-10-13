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
    const result = {
      provider: id,
      resourceVerified: metadata.resource === new URL(candidate.resource).href,
      protectedMetadataRead: true,
      issuerCount: metadata.authorizationServers.length,
      scopeCount: metadata.scopesSupported.length,
      // We do not print metadata endpoints or credentials into CI logs.
      realOAuthConnected: false,
      tokenExchangeTested: false,
      mcpToolsCertified: false,
    };
    // This probe deliberately does not assume an authorization server's
    // well-known URL can be guessed from its issuer. A separate approved
    // discovery plan must validate the RFC8414 or OIDC metadata path.
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
