// Operator-managed MCP OAuth providers. A provider is a NAgex-reviewed TEMPLATE (pinned MCP endpoint, RFC 9728 resource, documented metadata URLs, token
// client-authentication method and response profile) plus the operator's OWN registration (client id, exact callback URL, scopes, secret reference) read from
// the server environment. Nothing here comes from an end user: ordinary users never see or supply a client id, a secret, a token URL or an MCP URL.
// Activation is opt-in (NAGEX_MCP_OAUTH_ENABLED=1) and per provider: partial credentials never activate anything, and a missing piece is reported as SETUP_REQUIRED.
import type { McpOAuthResponseProfile, McpOAuthTokenAuthMethod } from './mcp-oauth-token.js';

export interface McpOAuthProviderTemplate {
  id: string;
  displayName: string;
  // Streamable HTTP endpoint where the bearer token is presented. Not the same thing as `resource` for some providers (Slack).
  mcpEndpoint: string;
  // RFC 9728 protected-resource identifier (the audience the token is bound to).
  resource: string;
  protectedResourceMetadataUrl: string;
  authorizationServerMetadataUrl: string;
  tokenAuthMethod: McpOAuthTokenAuthMethod;
  responseProfile: McpOAuthResponseProfile;
  // Environment variable prefix of the operator registration: <PREFIX>_CLIENT_ID, _CLIENT_SECRET, _REDIRECT_URI, _SCOPES.
  envPrefix: string;
  // Read-only scopes requested unless the operator narrows or changes them (still verified against the provider's advertised scopes).
  defaultScopes: string[];
}

// Slack's officially published remote MCP server. Sources: https://docs.slack.dev/ai/slack-mcp-server/ ; metadata at
// https://mcp.slack.com/.well-known/oauth-protected-resource and /oauth-authorization-server (re-verified at runtime, never trusted from this file alone).
// Slack allows only directory-published or internal apps to use MCP, and workspace admins approve the integration.
export const SLACK_MCP_OAUTH_TEMPLATE: McpOAuthProviderTemplate = Object.freeze({
  id: 'slack',
  // Distinct from the built-in "Slack" chat channel (talk to NAgex from Slack): this is the workspace's own tools through Slack's official MCP server.
  displayName: 'Slack workspace',
  mcpEndpoint: 'https://mcp.slack.com/mcp',
  resource: 'https://mcp.slack.com',
  protectedResourceMetadataUrl: 'https://mcp.slack.com/.well-known/oauth-protected-resource',
  authorizationServerMetadataUrl: 'https://mcp.slack.com/.well-known/oauth-authorization-server',
  tokenAuthMethod: 'client_secret_post',
  responseProfile: 'slack-user-v2',
  envPrefix: 'NAGEX_MCP_OAUTH_SLACK',
  defaultScopes: Object.freeze(['search:read.public', 'search:read.users', 'channels:read', 'channels:history', 'users:read']) as unknown as string[],
}) as McpOAuthProviderTemplate;

export const MCP_OAUTH_PROVIDER_TEMPLATES: readonly McpOAuthProviderTemplate[] = Object.freeze([SLACK_MCP_OAUTH_TEMPLATE]);

export type McpOAuthSetupItem = 'ENABLED_FLAG' | 'ENCRYPTION_KEY' | 'CLIENT_ID' | 'CLIENT_SECRET' | 'REDIRECT_URI' | 'SCOPES';

export interface McpOAuthOperatorProvider {
  template: McpOAuthProviderTemplate;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  // The NAME of the environment variable holding the secret, never its value.
  secretRef: string;
}

export interface McpOAuthOperatorProviderStatus {
  id: string;
  displayName: string;
  // DISABLED: the master flag is off. SETUP_REQUIRED: something the operator must provide (see `missing`). CONFIGURED: complete, not yet verified against live metadata.
  state: 'DISABLED' | 'SETUP_REQUIRED' | 'CONFIGURED';
  missing: McpOAuthSetupItem[];
  config: McpOAuthOperatorProvider | null;
}

export const MCP_OAUTH_CALLBACK_PATH = '/api/v1/oauth/mcp/callback';

export function mcpOAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NAGEX_MCP_OAUTH_ENABLED === '1';
}

function validRedirect(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || url.pathname !== MCP_OAUTH_CALLBACK_PATH) return null;
    return url.href;
  } catch { return null; }
}

function validScopes(value: string | undefined, fallback: string[]): string[] | null {
  if (value === undefined || value.trim() === '') return [...fallback];
  const scopes = [...new Set(value.split(',').map((s) => s.trim()).filter(Boolean))];
  return scopes.length > 0 && scopes.length <= 32 && scopes.every((s) => /^[\x21-\x7E]{1,255}$/.test(s)) ? scopes : null;
}

// Reads the operator registration of every template. Reports WHICH setup item is missing or invalid, never any value.
export function readMcpOAuthOperatorConfig(env: NodeJS.ProcessEnv = process.env, templates: readonly McpOAuthProviderTemplate[] = MCP_OAUTH_PROVIDER_TEMPLATES): McpOAuthOperatorProviderStatus[] {
  const enabled = mcpOAuthEnabled(env);
  const keyPresent = typeof env.NAGEX_TOKEN_ENCRYPTION_KEY === 'string' && env.NAGEX_TOKEN_ENCRYPTION_KEY.length > 0;
  return templates.map((template) => {
    const base = { id: template.id, displayName: template.displayName };
    if (!enabled) return { ...base, state: 'DISABLED' as const, missing: ['ENABLED_FLAG' as const], config: null };
    const missing: McpOAuthSetupItem[] = [];
    if (!keyPresent) missing.push('ENCRYPTION_KEY');
    const clientId = env[`${template.envPrefix}_CLIENT_ID`]?.trim();
    if (!clientId || !/^[A-Za-z0-9._-]{1,128}$/.test(clientId)) missing.push('CLIENT_ID');
    const secretRef = `${template.envPrefix}_CLIENT_SECRET`;
    if (template.tokenAuthMethod === 'client_secret_post' && !env[secretRef]) missing.push('CLIENT_SECRET');
    const redirectUri = validRedirect(env[`${template.envPrefix}_REDIRECT_URI`]?.trim());
    if (!redirectUri) missing.push('REDIRECT_URI');
    const scopes = validScopes(env[`${template.envPrefix}_SCOPES`], template.defaultScopes);
    if (!scopes) missing.push('SCOPES');
    if (missing.length > 0 || !clientId || !redirectUri || !scopes) return { ...base, state: 'SETUP_REQUIRED' as const, missing, config: null };
    return { ...base, state: 'CONFIGURED' as const, missing: [], config: { template, clientId, redirectUri, scopes, secretRef } };
  });
}

// Secret references are restricted to the MCP OAuth namespace so a registration can never be used to read an unrelated environment variable.
const SECRET_REF = /^NAGEX_MCP_OAUTH_[A-Z0-9_]{1,64}_CLIENT_SECRET$/;
export function resolveMcpOAuthClientSecret(ref: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!SECRET_REF.test(ref)) return undefined;
  const value = env[ref];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
