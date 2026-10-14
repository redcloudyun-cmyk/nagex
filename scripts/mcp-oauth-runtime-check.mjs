#!/usr/bin/env node
// Operator check for MCP OAuth. Reads the SAME environment the server reads, reports each provider's availability exactly as the Connections screen would
// (DISABLED / SETUP_REQUIRED / UNAVAILABLE / AVAILABLE), and for a configured provider performs only the read-only public metadata GETs (SSRF-guarded, no
// redirects). It NEVER starts a sign-in, exchanges a code or contacts the provider with a credential, and never prints a secret, client id or token.
// Run after `npm run build`:  NAGEX_MCP_OAUTH_ENABLED=1 ... node scripts/mcp-oauth-runtime-check.mjs
// Exit codes: 0 = at least one provider AVAILABLE, 1 = none available, 2 = usage / unexpected error.
import { McpOAuthRuntime } from '../dist/src/mcp/mcp-oauth-runtime.js';

if (process.argv.length > 2) {
  console.error('Usage: node scripts/mcp-oauth-runtime-check.mjs   (configuration is read from the environment)');
  process.exit(2);
}
try {
  // The credential store is opened exactly as in production, so a wrong key or corrupt file is reported here too.
  const runtime = new McpOAuthRuntime();
  const statuses = await runtime.statuses();
  const report = statuses.map((s) => ({
    provider: s.id,
    state: s.state,
    missing: s.missing,
    reason: s.reason,
    requestedScopes: s.scopes,
    // A provider is only ever AVAILABLE after its published metadata verified (resource, issuer, PKCE S256, advertised client authentication, scopes).
    metadataVerified: s.state === 'AVAILABLE',
    realOAuthConnected: false,
    tokenExchangeTested: false,
  }));
  console.log(JSON.stringify({ check: 'MCP_OAUTH_RUNTIME', providers: report, note: 'Configuration and public metadata only. No account was connected and no credential was sent.' }, null, 2));
  process.exit(report.some((r) => r.state === 'AVAILABLE') ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({ check: 'MCP_OAUTH_RUNTIME', error: error?.code || 'UNEXPECTED_ERROR' }));
  process.exit(2);
}
