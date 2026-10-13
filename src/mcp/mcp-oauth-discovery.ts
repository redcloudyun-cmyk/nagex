// Bounded, fail-closed HTTP GET for MCP OAuth discovery metadata.
// These untrusted endpoints require URL validation before every connection and
// DNS validation at socket connect. Redirects are never followed.
import http from 'node:http';
import https from 'node:https';
import { NagexError } from '../common/errors.js';
import { assertSafeMcpUrl, createGuardedLookup, readMcpUrlPolicyFromEnv, type McpUrlPolicyOptions } from './mcp-url-policy.js';

export const MCP_OAUTH_METADATA_MAX_BYTES = 64 * 1024;
export const MCP_OAUTH_METADATA_TIMEOUT_MS = 5000;

type MetadataHttpResponse = { status: number; contentType: string; body: string };
export type MetadataGet = (url: URL, policy: McpUrlPolicyOptions) => Promise<MetadataHttpResponse>;

function error(reason: string): NagexError {
  return new NagexError({
    code: 'MCP_OAUTH_DISCOVERY_FAILED', category: 'PROVIDER',
    message: 'Could not safely discover this MCP server\'s OAuth configuration.',
    details: { reason },
  });
}

export const guardedMetadataGet: MetadataGet = (url, policy) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'http:' ? http : https).request(url, {
    method: 'GET',
    lookup: createGuardedLookup(policy),
    agent: false,
    timeout: MCP_OAUTH_METADATA_TIMEOUT_MS,
    headers: { Accept: 'application/json' },
  }, (response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    response.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MCP_OAUTH_METADATA_MAX_BYTES) {
        request.destroy(error('RESPONSE_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('error', reject);
    response.on('end', () => resolve({
      status: response.statusCode ?? 0,
      contentType: String(response.headers['content-type'] ?? ''),
      body: Buffer.concat(chunks).toString('utf8'),
    }));
  });
  request.on('timeout', () => request.destroy(error('TIMEOUT')));
  request.on('error', reject);
  request.end();
});

export async function getMcpOAuthMetadata(
  rawUrl: string,
  requestId: string,
  options: { policy?: McpUrlPolicyOptions; get?: MetadataGet } = {},
): Promise<unknown> {
  const policy = options.policy ?? readMcpUrlPolicyFromEnv();
  const url = await assertSafeMcpUrl(rawUrl, requestId, policy);
  let response: MetadataHttpResponse;
  try {
    response = await (options.get ?? guardedMetadataGet)(url, policy);
  } catch (cause) {
    if (cause instanceof NagexError) throw cause;
    throw error('NETWORK_ERROR');
  }
  if (response.status >= 300 && response.status < 400) throw error('REDIRECT_REFUSED');
  if (response.status !== 200) throw error('HTTP_STATUS');
  if (!/^(application\/json|application\/[\w.+-]+\+json)(?:\s*;|\s*$)/i.test(response.contentType)) throw error('CONTENT_TYPE');
  if (Buffer.byteLength(response.body, 'utf8') > MCP_OAUTH_METADATA_MAX_BYTES) throw error('RESPONSE_TOO_LARGE');
  try {
    return JSON.parse(response.body) as unknown;
  } catch {
    throw error('INVALID_JSON');
  }
}
