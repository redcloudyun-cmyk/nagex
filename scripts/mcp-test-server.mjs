#!/usr/bin/env node
// An isolated MCP server used ONLY to certify NAgex's end-to-end MCP protocol path (Streamable HTTP, JSON-RPC 2.0, bearer auth, sessions, tool
// discovery and calls). It is NOT a third-party MCP provider: certifying against it proves that NAgex's client and governance work against a
// protocol-conformant server that this repository controls, and nothing about any vendor's server.
//
// Every tool is non-destructive and in-memory (nothing touches the file system or the network). Run standalone for manual checks:
//   MCP_TEST_TOKEN=secret MCP_TEST_PORT=8931 node scripts/mcp-test-server.mjs        -> http://127.0.0.1:8931/mcp
//   add MCP_TEST_TLS_KEY / MCP_TEST_TLS_CERT (PEM paths) to serve HTTPS.
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';

const SUPPORTED = ['2025-06-18', '2025-03-26'];

export const DEFAULT_TOOLS = [
  { name: 'echo', description: 'Returns the message it was given.', inputSchema: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['message'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'add_numbers', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false } },
  { name: 'record_note', description: 'Appends a note to this test server\'s in-memory list.', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['text'], additionalProperties: false } },
  { name: 'list_notes', description: 'Lists the notes recorded on this test server.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'slow_echo', description: 'Echoes after a delay (used to exercise timeouts).', inputSchema: { type: 'object', properties: { delay_ms: { type: 'integer', minimum: 0, maximum: 60000 }, message: { type: 'string', maxLength: 200 } }, required: ['delay_ms'], additionalProperties: false } },
  { name: 'always_fails', description: 'Always reports a tool error.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

export async function startMcpTestServer(options = {}) {
  const state = {
    token: options.token ?? 'mcp-test-token',
    serverName: options.serverName ?? 'NAgex MCP Test Server',
    serverVersion: options.serverVersion ?? '1.0.0',
    tools: (options.tools ?? DEFAULT_TOOLS).map((tool) => JSON.parse(JSON.stringify(tool))),
    sse: options.sse === true,
    pageSize: options.pageSize ?? 0,
    notes: [],
    sessions: new Set(),
    closedSessions: new Set(),
    log: [], // { method, sessionId, authorized, tool }
    deletes: 0,
  };

  const send = (res, status, headers, body) => { res.writeHead(status, headers); res.end(body); };
  const rpc = (res, id, result, sessionId, asSse) => {
    const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
    const headers = { ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) };
    if (asSse) send(res, 200, { ...headers, 'Content-Type': 'text/event-stream' }, `event: message\ndata: ${payload}\n\n`);
    else send(res, 200, { ...headers, 'Content-Type': 'application/json' }, payload);
  };
  const rpcError = (res, id, code, message) => send(res, 200, { 'Content-Type': 'application/json' }, JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));

  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://local');
      if (url.pathname !== '/mcp') return send(res, 404, {}, '');
      const sessionId = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : null;
      const authorized = req.headers.authorization === `Bearer ${state.token}`;
      if (!authorized) { state.log.push({ method: req.method, sessionId, authorized: false }); return send(res, 401, { 'WWW-Authenticate': 'Bearer realm="mcp-test"' }, ''); }
      if (req.method === 'DELETE') {
        state.deletes += 1;
        state.log.push({ method: 'DELETE', sessionId, authorized: true });
        if (sessionId && state.sessions.delete(sessionId)) { state.closedSessions.add(sessionId); return send(res, 200, {}, ''); }
        return send(res, 404, {}, '');
      }
      if (req.method !== 'POST') return send(res, 405, { Allow: 'POST, DELETE' }, '');
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, {}, ''); }
      state.log.push({ method: message.method, sessionId, authorized: true, tool: message.params?.name });

      if (message.method === 'initialize') {
        const requested = String(message.params?.protocolVersion ?? '');
        const version = SUPPORTED.includes(requested) ? requested : SUPPORTED[0];
        const id = crypto.randomUUID();
        state.sessions.add(id);
        return rpc(res, message.id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: state.serverName, version: state.serverVersion } }, id, false);
      }
      // every other message must belong to a live session (a closed or unknown session is 404 per the Streamable HTTP spec)
      if (!sessionId || !state.sessions.has(sessionId)) return send(res, 404, {}, '');
      if (message.method === 'notifications/initialized') return send(res, 202, {}, '');
      if (message.method === 'tools/list') {
        const offset = message.params?.cursor ? Number(message.params.cursor) : 0;
        const slice = state.pageSize > 0 ? state.tools.slice(offset, offset + state.pageSize) : state.tools;
        const next = state.pageSize > 0 && offset + state.pageSize < state.tools.length ? String(offset + state.pageSize) : undefined;
        return rpc(res, message.id, { tools: slice, ...(next ? { nextCursor: next } : {}) }, sessionId, false);
      }
      if (message.method === 'tools/call') {
        const name = message.params?.name;
        const args = message.params?.arguments ?? {};
        const text = (value, isError = false) => rpc(res, message.id, { content: [{ type: 'text', text: value }], isError }, sessionId, state.sse);
        if (!state.tools.some((tool) => tool.name === name)) return rpcError(res, message.id, -32602, `Unknown tool: ${String(name).slice(0, 60)}`);
        if (name === 'echo') return text(`echo: ${String(args.message)}`);
        if (name === 'add_numbers') return text(String(Number(args.a) + Number(args.b)));
        if (name === 'record_note') { state.notes.push(String(args.text)); return text(`recorded note #${state.notes.length}`); }
        if (name === 'list_notes') return text(state.notes.length ? state.notes.map((note, index) => `${index + 1}. ${note}`).join('\n') : '(no notes)');
        if (name === 'slow_echo') { await new Promise((resolve) => setTimeout(resolve, Number(args.delay_ms) || 0)); return text(`slow echo: ${String(args.message ?? '')}`); }
        if (name === 'always_fails') return text('This tool always fails.', true);
        return text(`${name}: no handler`, true);
      }
      return rpc(res, message.id, {}, sessionId, false);
    });
  };

  const server = options.tls ? https.createServer({ key: fs.readFileSync(options.tls.key), cert: fs.readFileSync(options.tls.cert) }, handler) : http.createServer(handler);
  await new Promise((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `${options.tls ? 'https' : 'http'}://${options.host ?? '127.0.0.1'}:${port}`;
  return {
    url: `${origin}/mcp`,
    origin,
    port,
    state,
    // test hooks (in-process only; there is no HTTP surface for them)
    setToken: (token) => { state.token = token; },
    rename: (name) => { state.serverName = name; },
    setToolDescription: (toolName, description) => { const tool = state.tools.find((entry) => entry.name === toolName); if (tool) tool.description = description; },
    callsTo: (toolName) => state.log.filter((entry) => entry.method === 'tools/call' && entry.tool === toolName).length,
    liveSessions: () => state.sessions.size,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('mcp-test-server.mjs')) {
  const tls = process.env.MCP_TEST_TLS_KEY && process.env.MCP_TEST_TLS_CERT ? { key: process.env.MCP_TEST_TLS_KEY, cert: process.env.MCP_TEST_TLS_CERT } : undefined;
  const running = await startMcpTestServer({ port: Number(process.env.MCP_TEST_PORT || 8931), token: process.env.MCP_TEST_TOKEN || 'mcp-test-token', tls, sse: process.env.MCP_TEST_SSE === '1' });
  console.log(`NAgex MCP test server (isolated, not a third-party provider) listening at ${running.url}`);
}
