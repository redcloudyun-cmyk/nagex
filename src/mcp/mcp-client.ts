// Minimal MCP client over the Streamable HTTP transport (JSON-RPC 2.0 over POST). Deliberately NOT supported:
//   - stdio servers: they would spawn processes on the API server (arbitrary code execution) - never offered;
//   - redirects: a 3xx is an error (the policy was applied to the registered URL, not to wherever it points).
// Responses are size-capped and time-bounded. Everything a server returns is untrusted data.
import http from 'node:http';
import https from 'node:https';
import { NagexError } from '../common/errors.js';
import { createGuardedLookup, readMcpUrlPolicyFromEnv, type McpUrlPolicyOptions } from './mcp-url-policy.js';
import { MCP_MAX_TOOLS } from './mcp-schema.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_TIMEOUT_MS = 15_000;
export const MCP_MAX_RESPONSE_BYTES = 512 * 1024;
export const MCP_MAX_RESULT_TEXT = 100 * 1024;

export interface McpTransportRequest {
  url: URL;
  // POST for every JSON-RPC message; DELETE only to end the server-side session (best effort).
  method?: 'POST' | 'DELETE';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxBytes: number;
}
export interface McpTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
export type McpTransport = (request: McpTransportRequest) => Promise<McpTransportResponse>;

export function createHttpMcpTransport(policy: McpUrlPolicyOptions = readMcpUrlPolicyFromEnv()): McpTransport {
  const lookup = createGuardedLookup(policy);
  return (request) => new Promise<McpTransportResponse>((resolve, reject) => {
    const client = request.url.protocol === 'http:' ? http : https;
    const req = client.request(request.url, { method: request.method ?? 'POST', headers: { ...request.headers, 'Content-Length': String(Buffer.byteLength(request.body)) }, lookup, agent: false, timeout: request.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxBytes) { req.destroy(Object.assign(new Error('response too large'), { code: 'MCP_RESPONSE_TOO_LARGE' })); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
        resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'MCP_TIMEOUT' })));
    req.on('error', reject);
    req.end(request.body);
  });
}

export interface McpServerIdentity {
  serverName: string;
  serverVersion: string;
  protocolVersion: string;
}

export interface McpCallResult {
  isError: boolean;
  text: string;
  truncated: boolean;
  // Non-text content (images, resources) is reported by type only; it is never forwarded or rendered.
  otherContent: string[];
  untrusted: true;
}

function fail(code: string, category: ConstructorParameters<typeof NagexError>[0]['category'], message: string, requestId: string, details?: Record<string, unknown>): NagexError {
  return new NagexError({ code, category, message, request_id: requestId, details });
}

function classifyTransportError(error: unknown, requestId: string): NagexError {
  if (error instanceof NagexError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (code === 'MCP_TIMEOUT' || code === 'ETIMEDOUT') return fail('MCP_TIMEOUT', 'TIMEOUT', 'The MCP server did not respond in time.', requestId);
  if (code === 'MCP_RESPONSE_TOO_LARGE') return fail('MCP_RESPONSE_TOO_LARGE', 'PROVIDER', 'The MCP server response was too large.', requestId);
  if (code === 'MCP_PRIVATE_ADDRESS') return fail('MCP_URL_REJECTED', 'VALIDATION', 'Local network addresses are not allowed for MCP servers.', requestId, { reason: 'PRIVATE_ADDRESS' });
  return fail('MCP_UNREACHABLE', 'PROVIDER', 'The MCP server could not be reached.', requestId);
}

// Parses a JSON or text/event-stream body and returns the JSON-RPC message answering `id`.
function extractMessage(response: McpTransportResponse, id: number, requestId: string): Record<string, unknown> {
  const contentType = response.headers['content-type'] ?? '';
  const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return undefined; } };
  const candidates: unknown[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const event of response.body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) candidates.push(parse(data));
    }
  } else {
    candidates.push(parse(response.body));
  }
  for (const candidate of candidates.flat()) {
    if (candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === id) return candidate as Record<string, unknown>;
  }
  throw fail('MCP_PROTOCOL_ERROR', 'PROVIDER', 'The MCP server returned an unexpected response.', requestId);
}

export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private negotiatedVersion: string | null = null;

  constructor(private readonly options: { url: URL; bearerToken?: string | null; transport: McpTransport; requestId: string; timeoutMs?: number }) {}

  private async post(message: Record<string, unknown>, expectResponse: boolean): Promise<Record<string, unknown> | null> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.options.bearerToken) headers.Authorization = `Bearer ${this.options.bearerToken}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.negotiatedVersion) headers['MCP-Protocol-Version'] = this.negotiatedVersion;
    let response: McpTransportResponse;
    try {
      response = await this.options.transport({ url: this.options.url, headers, body: JSON.stringify(message), timeoutMs: this.options.timeoutMs ?? MCP_TIMEOUT_MS, maxBytes: MCP_MAX_RESPONSE_BYTES });
    } catch (error) {
      throw classifyTransportError(error, this.options.requestId);
    }
    const rid = this.options.requestId;
    if (response.status >= 300 && response.status < 400) throw fail('MCP_REDIRECT_BLOCKED', 'PROVIDER', 'The MCP server tried to redirect; redirects are not followed.', rid);
    if (response.status === 401 || response.status === 403) throw fail('MCP_SERVER_AUTH_FAILED', 'AUTHENTICATION', 'The MCP server rejected the credentials.', rid, { httpStatus: response.status });
    if (response.status === 429) throw fail('MCP_RATE_LIMITED', 'RATE_LIMIT', 'The MCP server is limiting requests.', rid);
    if (response.status >= 400) throw fail('MCP_SERVER_ERROR', 'PROVIDER', `The MCP server answered HTTP ${response.status}.`, rid, { httpStatus: response.status });
    if (response.headers['mcp-session-id']) this.sessionId = response.headers['mcp-session-id'];
    if (!expectResponse) return null;
    const reply = extractMessage(response, message.id as number, rid);
    if (reply.error && typeof reply.error === 'object') {
      const err = reply.error as { code?: unknown; message?: unknown };
      throw fail('MCP_RPC_ERROR', 'PROVIDER', typeof err.message === 'string' ? err.message.slice(0, 300) : 'The MCP server reported an error.', rid, { rpcCode: typeof err.code === 'number' ? err.code : null });
    }
    return reply;
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, ...(params ? { params } : {}) }, true);
    const result = reply?.result;
    if (!result || typeof result !== 'object') throw fail('MCP_PROTOCOL_ERROR', 'PROVIDER', 'The MCP server returned an unexpected response.', this.options.requestId);
    return result as Record<string, unknown>;
  }

  public async initialize(): Promise<McpServerIdentity> {
    const result = await this.request('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'NAgex', version: '1.0.0' } });
    const info = result.serverInfo && typeof result.serverInfo === 'object' ? (result.serverInfo as Record<string, unknown>) : {};
    const serverName = typeof info.name === 'string' ? info.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100) : '';
    if (!serverName) throw fail('MCP_PROTOCOL_ERROR', 'PROVIDER', 'The MCP server did not identify itself.', this.options.requestId);
    const protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion.slice(0, 20) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(protocolVersion)) throw fail('MCP_PROTOCOL_ERROR', 'PROVIDER', 'The MCP server did not report a protocol version.', this.options.requestId);
    this.negotiatedVersion = protocolVersion;
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
    return { serverName, serverVersion: typeof info.version === 'string' ? info.version.replace(/[\u0000-\u001f]/g, '').slice(0, 40) : '', protocolVersion };
  }

  // Ends the server-side session (Streamable HTTP: DELETE with the session id). Best effort: a server may answer 405 or be gone, and a failure
  // here never changes the outcome of the operation that already finished.
  public async close(): Promise<void> {
    if (!this.sessionId) return;
    const headers: Record<string, string> = { 'Mcp-Session-Id': this.sessionId };
    if (this.options.bearerToken) headers.Authorization = `Bearer ${this.options.bearerToken}`;
    if (this.negotiatedVersion) headers['MCP-Protocol-Version'] = this.negotiatedVersion;
    this.sessionId = null;
    try {
      await this.options.transport({ url: this.options.url, headers, body: '', method: 'DELETE', timeoutMs: 5_000, maxBytes: 4_096 });
    } catch { /* ignored on purpose */ }
  }

  public async listTools(): Promise<unknown[]> {
    const tools: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : undefined);
      if (!Array.isArray(result.tools)) throw fail('MCP_PROTOCOL_ERROR', 'PROVIDER', 'The MCP server returned an invalid tool list.', this.options.requestId);
      tools.push(...result.tools);
      if (tools.length >= MCP_MAX_TOOLS) return tools.slice(0, MCP_MAX_TOOLS);
      if (typeof result.nextCursor !== 'string' || !result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  public async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const texts: string[] = [];
    const other: string[] = [];
    for (const part of content) {
      if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') texts.push((part as { text: string }).text);
      else if (part && typeof part === 'object' && typeof (part as { type?: unknown }).type === 'string') other.push(String((part as { type: string }).type).slice(0, 30));
    }
    const joined = texts.join('\n');
    // eslint-disable-next-line no-control-regex
    const clean = joined.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    return { isError: result.isError === true, text: clean.slice(0, MCP_MAX_RESULT_TEXT), truncated: clean.length > MCP_MAX_RESULT_TEXT, otherContent: other.slice(0, 10), untrusted: true };
  }
}
