// Security boundary for OAuth-protected remote MCP resource metadata.
// Parsing metadata NEVER authorizes a connection. Every discovered URI must pass
// the existing MCP outbound URL policy again before any network call, including DNS
// and connect-time checks. This module deliberately does not fetch arbitrary URLs.
import { NagexError } from '../common/errors.js';

function reject(reason: string): never {
  throw new NagexError({
    code: 'MCP_OAUTH_METADATA_REJECTED', category: 'VALIDATION',
    message: 'The MCP server supplied invalid OAuth metadata.',
    details: { reason },
  });
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject('NOT_OBJECT');
  return value as Record<string, unknown>;
}

function secureMetadataUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return reject('INVALID_URL');
  let parsed: URL;
  try { parsed = new URL(value); } catch { return reject('INVALID_URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return reject('INSECURE_URL');
  return parsed.href;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

export function parseProtectedResourceMetadata(raw: unknown, expectedResource: string): ProtectedResourceMetadata {
  const metadata = object(raw);
  const canonicalResource = secureMetadataUrl(expectedResource);
  const resource = secureMetadataUrl(metadata.resource);
  if (resource !== canonicalResource) return reject('RESOURCE_MISMATCH');
  const servers = metadata.authorization_servers;
  if (!Array.isArray(servers) || servers.length === 0 || servers.length > 8) return reject('AUTH_SERVERS_INVALID');
  if (!servers.every((server) => typeof server === 'string')) return reject('AUTH_SERVER_TYPE');
  const authorizationServers = [...new Set(servers.map(secureMetadataUrl))];
  if (authorizationServers.length === 0) return reject('AUTH_SERVERS_INVALID');
  const scopes = metadata.scopes_supported;
  if (scopes !== undefined && (!Array.isArray(scopes) || scopes.length > 128 || !scopes.every((scope) => typeof scope === 'string' && scope.length > 0 && scope.length < 256))) return reject('SCOPES_INVALID');
  return { resource, authorizationServers, scopesSupported: scopes === undefined ? [] : [...new Set(scopes as string[])] };
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  codeChallengeMethodsSupported: string[];
  // As advertised (RFC 8414 section 2). null when the metadata does not say; the RFC default would then be client_secret_basic.
  tokenEndpointAuthMethodsSupported: string[] | null;
}

export function parseAuthorizationServerMetadata(raw: unknown, discoveredIssuer: string): AuthorizationServerMetadata {
  const metadata = object(raw);
  const issuer = secureMetadataUrl(metadata.issuer);
  if (issuer !== secureMetadataUrl(discoveredIssuer)) return reject('ISSUER_MISMATCH');
  const authorizationEndpoint = secureMetadataUrl(metadata.authorization_endpoint);
  const tokenEndpoint = secureMetadataUrl(metadata.token_endpoint);
  const methods = metadata.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes('S256')) return reject('PKCE_S256_NOT_SUPPORTED');
  const authMethods = metadata.token_endpoint_auth_methods_supported;
  if (authMethods !== undefined && (!Array.isArray(authMethods) || authMethods.length > 16 || !authMethods.every((m) => typeof m === 'string' && m.length > 0 && m.length < 64))) return reject('TOKEN_AUTH_METHODS_INVALID');
  return { issuer, authorizationEndpoint, tokenEndpoint, codeChallengeMethodsSupported: ['S256'], tokenEndpointAuthMethodsSupported: authMethods === undefined ? null : [...new Set(authMethods as string[])] };
}
