#!/usr/bin/env node
// Real remote MCP server integration check using the production MCP client and policy. It performs the same steps as adding a server in
// Settings (URL policy -> initialize -> tools/list -> schema validation) but only READS: it never calls a tool, and it never prints
// the bearer token. Run from the repository root after `npm run build`.
//
//   MCP_CHECK_URL=https://your-mcp-server.example/mcp [MCP_CHECK_TOKEN=<bearer>] node scripts/mcp-remote-check.mjs
//
// MCP_CHECK_TOKEN is sent only to MCP_CHECK_URL as an Authorization header. Set NAGEX_MCP_ALLOW_PRIVATE_NETWORK=1 only to test a server
// on a private network on purpose (the same escape hatch the server honours; never set in production).
import { McpClient, createHttpMcpTransport } from '../dist/src/mcp/mcp-client.js';
import { parseToolDescriptor } from '../dist/src/mcp/mcp-schema.js';
import { assertSafeMcpUrl, readMcpUrlPolicyFromEnv } from '../dist/src/mcp/mcp-url-policy.js';

const rawUrl = process.env.MCP_CHECK_URL;
const results = [];
const record = (status, name, detail = '') => { results.push(status); console.log(`${status.padEnd(4)} ${name}${detail ? ' - ' + detail : ''}`); };
if (!rawUrl) { console.log('SKIP set MCP_CHECK_URL to the remote MCP server URL'); process.exit(0); }

const policy = readMcpUrlPolicyFromEnv();
let url;
try { url = await assertSafeMcpUrl(rawUrl, 'mcp_check', policy); record('PASS', 'URL policy (https, public address, no embedded credentials)', url.origin); }
catch (error) { record('FAIL', 'URL policy', `${error.code}${error.details?.reason ? ' / ' + error.details.reason : ''}`); process.exit(1); }

const client = new McpClient({ url, bearerToken: process.env.MCP_CHECK_TOKEN || null, transport: createHttpMcpTransport(policy), requestId: 'mcp_check' });
try {
  const identity = await client.initialize();
  record('PASS', 'initialize handshake', `server="${identity.serverName}" version="${identity.serverVersion}" protocol=${identity.protocolVersion}`);
  const raw = await client.listTools();
  const parsed = raw.map(parseToolDescriptor);
  const accepted = parsed.filter((p) => p.ok);
  record(raw.length > 0 ? 'PASS' : 'FAIL', 'tools/list', `${raw.length} advertised, ${accepted.length} accepted by NAgex schema validation`);
  for (const p of parsed.filter((x) => !x.ok)) record('SKIP', `tool rejected: ${p.name || '?'}`, p.reason);
  for (const p of accepted) console.log(`     tool ${p.tool.name}${p.tool.readOnlyHint === true ? ' (server hints read-only; NAgex does not trust the hint)' : ''} hash=${p.tool.schemaHash.slice(0, 12)}`);
  record('SKIP', 'tools/call', 'never performed by this check; real calls only run in NAgex after an explicit enable + approval');
} catch (error) {
  record('FAIL', 'MCP protocol check', `${error.code ?? 'ERROR'}: ${String(error.message).slice(0, 160)}`);
}
const failed = results.filter((s) => s === 'FAIL').length;
console.log(`\n${results.filter((s) => s === 'PASS').length} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
