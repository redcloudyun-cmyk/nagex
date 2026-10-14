// MCP runtime service: registers a user's MCP servers, discovers and validates their tools, pins the server identity and
// executes tool calls ONLY through the existing governance - it adds no authority of its own:
//   - every connection is owned by one tenant + user (owner-scoped store; foreign records look nonexistent);
//   - a discovered tool is disabled until the owner enables it; a changed definition or server identity disables it again;
//   - an enabled tool becomes a CapabilityRegistry entry (provider MCP, CONSEQUENTIAL, approval REQUIRED) so the Capability
//     Broker's permission decision, the ActionApprovalStore (hash-bound, one-time) and the ExecutionStore/audit apply as for
//     every other consequential capability. A server's readOnlyHint is displayed, never trusted;
//   - arguments are validated against the accepted schema before an approval is even requested;
//   - results are untrusted data (size-capped text; non-text content is reported by type only).
import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { ActionApprovalRecord, ActionApprovalStore } from '../governance/action-approval.store.js';
import type { ExecutionStore } from '../governance/execution.store.js';
import type { CapabilityRegistry } from '../capabilities/capability.registry.js';
import type { RegisteredTool } from '../tools/tool-registry.js';
import { McpClient, MCP_TIMEOUT_MS, createHttpMcpTransport, type McpCallResult, type McpTransport } from './mcp-client.js';
import { toView, type McpConnectionRecord, type McpConnectionStore, type McpConnectionView, type McpToolState } from './mcp-connection.store.js';
import { parseToolDescriptor, sanitizeText, validateArguments } from './mcp-schema.js';
import { assertSafeMcpUrl, readMcpUrlPolicyFromEnv, type McpUrlPolicyOptions } from './mcp-url-policy.js';

export const MCP_MAX_SERVERS_PER_USER = 10;

export type McpExecutionResult = McpCallResult & { server: string; tool: string; executionId: string; outcome: 'TOOL_RESPONDED' | 'TOOL_REPORTED_ERROR'; verification: { status: 'UNVERIFIED'; reason: 'MCP_PROVIDER_RESPONSE_ONLY' } };

export interface McpIdentity {
  tenantId: string;
  principalId: string;
  requestId: string;
}

export interface McpServiceDeps {
  store: McpConnectionStore;
  approvals: ActionApprovalStore;
  audit: AuditLogger;
  registry: CapabilityRegistry;
  executions: ExecutionStore;
  transport?: McpTransport;
  policy?: () => McpUrlPolicyOptions;
  // Per-request timeout; defaults to NAGEX_MCP_TIMEOUT_MS (bounded to 1 s - 60 s) or 15 s.
  timeoutMs?: number;
}

export function readMcpTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NAGEX_MCP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1_000 && raw <= 60_000 ? Math.floor(raw) : MCP_TIMEOUT_MS;
}

export interface McpToolForPlanning {
  capabilityId: string;
  connectionId: string;
  serverName: string;
  toolName: string;
  description: string;
  // the tool's own input schema (untrusted server data; only property names, types and required names ever reach a prompt)
  inputSchema?: unknown;
}

function err(code: string, category: ConstructorParameters<typeof NagexError>[0]['category'], message: string, requestId: string, details?: Record<string, unknown>): NagexError {
  return new NagexError({ code, category, message, request_id: requestId, details });
}
const notFound = (requestId: string): NagexError => err('MCP_NOT_FOUND', 'NOT_FOUND', 'That MCP server or tool was not found.', requestId);

export class McpService {
  private readonly transport: McpTransport;
  private readonly policy: () => McpUrlPolicyOptions;
  private readonly timeoutMs: number;

  constructor(private readonly deps: McpServiceDeps) {
    this.timeoutMs = deps.timeoutMs ?? readMcpTimeoutFromEnv();
    this.policy = deps.policy ?? (() => readMcpUrlPolicyFromEnv());
    this.transport = deps.transport ?? createHttpMcpTransport(this.policy());
  }

  // Re-registers the capability entries of previously enabled tools (after a restart).
  public hydrate(): void {
    for (const record of this.deps.store.all()) this.syncCapabilities(record);
  }

  public list(identity: McpIdentity): McpConnectionView[] {
    return this.deps.store.list(identity.tenantId, identity.principalId).map(toView);
  }

  public get(identity: McpIdentity, connectionId: string): McpConnectionView {
    return toView(this.requireOwned(identity, connectionId));
  }

  public async addServer(identity: McpIdentity, input: { name: unknown; url: unknown; bearerToken?: unknown }): Promise<McpConnectionView> {
    const { tenantId, principalId, requestId } = identity;
    if (!tenantId || !principalId) throw err('UNAUTHORIZED', 'AUTHENTICATION', 'Sign in to add an MCP server.', requestId);
    const name = sanitizeText(input.name, 60);
    if (!name) throw err('MCP_INVALID_REQUEST', 'VALIDATION', 'A server name is required.', requestId);
    if (this.deps.store.list(tenantId, principalId).length >= MCP_MAX_SERVERS_PER_USER) throw err('MCP_LIMIT_REACHED', 'QUOTA', `You can connect at most ${MCP_MAX_SERVERS_PER_USER} MCP servers.`, requestId);
    const bearerToken = this.normalizeBearer(input.bearerToken, requestId);
    const url = await assertSafeMcpUrl(input.url, requestId, this.policy());

    const discovered = await this.discover(url, bearerToken, requestId);
    const connectionId = `mcp_${crypto.randomBytes(8).toString('hex')}`;
    const now = getCurrentISOString();
    const record: McpConnectionRecord = {
      connectionId, tenantId, principalId, name, url: url.toString(), bearerToken,
      status: 'CONNECTED', reason: null,
      identity: { origin: url.origin, serverName: discovered.identity.serverName, serverVersion: discovered.identity.serverVersion, protocolVersion: discovered.identity.protocolVersion, pinnedAt: now },
      tools: discovered.tools.map((tool) => ({ ...tool, enabled: false, changedSinceEnabled: false, capabilityId: `mcp.${connectionId}.${tool.name}` })),
      rejectedTools: discovered.rejected,
      createdAt: now, discoveredAt: now,
    };
    this.deps.store.add(record);
    this.audit(identity, 'mcp.server_added', 'SUCCESS', connectionId, { origin: url.origin, serverName: record.identity.serverName, tools: record.tools.length, rejected: record.rejectedTools.length });
    return toView(record);
  }

  // Re-discovers the server. A different server identity disables everything; a changed tool definition disables that tool.
  public async refresh(identity: McpIdentity, connectionId: string): Promise<McpConnectionView> {
    return this.reverify(identity, connectionId, undefined);
  }

  // Reconnection after the server rejected the stored credential (expired / revoked / rotated): the owner supplies a new one. It replaces the stored
  // credential ONLY if the server then identifies as the pinned server; a changed tool definition still disables that tool until re-enabled.
  public async reconnect(identity: McpIdentity, connectionId: string, input: { bearerToken?: unknown }): Promise<McpConnectionView> {
    const token = this.normalizeBearer(input.bearerToken, identity.requestId);
    if (!token) throw err('MCP_INVALID_REQUEST', 'VALIDATION', 'A new credential is required to reconnect.', identity.requestId);
    return this.reverify(identity, connectionId, token);
  }

  private normalizeBearer(raw: unknown, requestId: string): string | null {
    const token = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 4096) : null;
    if (token && /[\r\n]/.test(token)) throw err('MCP_INVALID_REQUEST', 'VALIDATION', 'The credential is not valid.', requestId);
    return token;
  }

  private async reverify(identity: McpIdentity, connectionId: string, newToken: string | undefined): Promise<McpConnectionView> {
    const record = this.requireOwned(identity, connectionId);
    const url = await assertSafeMcpUrl(record.url, identity.requestId, this.policy());
    let discovered;
    try {
      discovered = await this.discover(url, newToken ?? record.bearerToken, identity.requestId);
    } catch (error) {
      this.markUnreachable(identity, record, error, 'mcp.server_refresh_failed');
      throw error;
    }
    if (!this.identityMatches(record, discovered.identity.serverName, url.origin)) {
      this.markMismatch(identity, record);
      return toView(record);
    }
    if (newToken !== undefined) record.bearerToken = newToken;
    record.status = 'CONNECTED';
    record.reason = null;
    record.identity.serverVersion = discovered.identity.serverVersion;
    record.identity.protocolVersion = discovered.identity.protocolVersion;
    const previous = new Map(record.tools.map((tool) => [tool.name, tool]));
    record.tools = discovered.tools.map((tool) => {
      const before = previous.get(tool.name);
      const capabilityId = `mcp.${connectionId}.${tool.name}`;
      if (!before) return { ...tool, enabled: false, changedSinceEnabled: false, capabilityId };
      const changed = before.schemaHash !== tool.schemaHash;
      // an enabled tool whose definition changed is disabled until the owner enables it again
      return { ...tool, capabilityId, enabled: changed ? false : before.enabled, changedSinceEnabled: changed ? before.enabled || before.changedSinceEnabled : before.changedSinceEnabled };
    });
    record.rejectedTools = discovered.rejected;
    record.discoveredAt = getCurrentISOString();
    this.deps.store.save(record);
    this.syncCapabilities(record);
    this.audit(identity, newToken !== undefined ? 'mcp.server_reconnected' : 'mcp.server_refreshed', 'SUCCESS', connectionId, { tools: record.tools.length, changed: record.tools.filter((t) => t.changedSinceEnabled).length });
    return toView(record);
  }

  public setToolEnabled(identity: McpIdentity, connectionId: string, toolName: string, enabled: boolean): McpConnectionView {
    const record = this.requireOwned(identity, connectionId);
    const tool = record.tools.find((t) => t.name === toolName);
    if (!tool) throw notFound(identity.requestId);
    if (enabled && record.status !== 'CONNECTED') throw err('MCP_SERVER_NOT_TRUSTED', 'POLICY', 'This server must be re-verified before its tools can be enabled.', identity.requestId, { status: record.status });
    tool.enabled = enabled;
    // Enabling is the owner's explicit acceptance of the CURRENT definition.
    if (enabled) tool.changedSinceEnabled = false;
    this.deps.store.save(record);
    this.syncCapabilities(record);
    this.audit(identity, enabled ? 'mcp.tool_enabled' : 'mcp.tool_disabled', 'SUCCESS', connectionId, { tool: toolName, capabilityId: tool.capabilityId });
    return toView(record);
  }

  public remove(identity: McpIdentity, connectionId: string): void {
    const record = this.requireOwned(identity, connectionId);
    for (const tool of record.tools) this.deps.registry.unregisterDynamic(tool.capabilityId);
    this.deps.store.remove(identity.tenantId, identity.principalId, connectionId);
    this.audit(identity, 'mcp.server_removed', 'SUCCESS', connectionId, {});
  }

  // What the planner / ToolRegistry may offer THIS user: enabled, unchanged tools of verified servers.
  public toolsFor(identity: { tenantId: string; principalId: string }): McpToolForPlanning[] {
    return this.deps.store.list(identity.tenantId, identity.principalId)
      .filter((record) => record.status === 'CONNECTED')
      .flatMap((record) => record.tools.filter((tool) => tool.enabled && !tool.changedSinceEnabled).map((tool) => ({ capabilityId: tool.capabilityId, connectionId: record.connectionId, serverName: record.name, toolName: tool.name, description: tool.description, inputSchema: tool.inputSchema })));
  }

  // The Tool Registry view of toolsFor(): an MCP tool's effect is unknown to NAgex, so it always resolves as approval-gated.
  public registeredToolsFor(identity: { tenantId: string; principalId: string }): RegisteredTool[] {
    return this.toolsFor(identity).map((tool) => ({
      id: tool.capabilityId,
      name: `${tool.serverName}: ${tool.toolName}`,
      capability: 'mcp.tool.call',
      connectionStatus: 'connected' as const,
      sideEffectLevel: 'IRREVERSIBLE_WRITE' as const,
      requiresApproval: true,
      executionMode: 'live' as const,
      aliases: [`${tool.serverName} ${tool.toolName}`],
    }));
  }

  // ── Capability Broker path (the only way a tool is called) ───────────────────────────────────────────────────────

  public requestToolApproval(request: McpIdentity & { capabilityId: string; payload: unknown }): ActionApprovalRecord {
    const { record, tool } = this.resolveCallable(request, request.capabilityId);
    const args = this.argumentsFrom(request.payload, request.requestId);
    const problems = validateArguments(tool.inputSchema, args);
    if (problems.length > 0) throw err('MCP_INVALID_ARGUMENTS', 'VALIDATION', `The arguments do not match the tool's schema: ${problems.slice(0, 3).join(' ')}`, request.requestId);
    const approval = this.deps.approvals.request({ toolId: tool.capabilityId, tenantId: request.tenantId, principalId: request.principalId, payload: { connectionId: record.connectionId, tool: tool.name, arguments: args } });
    this.deps.audit.logEvent({ actor: { type: 'user', id: request.principalId }, tenant_id: request.tenantId, action: 'approval.requested', resource: { type: 'ActionApproval', id: approval.approvalId }, result: 'PENDING_APPROVAL', request_id: request.requestId, details: { toolId: tool.capabilityId, provider: 'MCP', server: record.name, tool: tool.name } });
    return approval;
  }

  public async executeApprovedTool(request: McpIdentity & { capabilityId: string; payload: unknown; approvalId: string }): Promise<McpExecutionResult> {
    const { record, tool } = this.resolveCallable(request, request.capabilityId);
    const args = this.argumentsFrom(request.payload, request.requestId);
    const problems = validateArguments(tool.inputSchema, args);
    if (problems.length > 0) throw err('MCP_INVALID_ARGUMENTS', 'VALIDATION', `The arguments do not match the tool's schema: ${problems.slice(0, 3).join(' ')}`, request.requestId);

    // Verify the server is still the one the owner enabled BEFORE spending the approval.
    const url = await assertSafeMcpUrl(record.url, request.requestId, this.policy());
    const client = new McpClient({ url, bearerToken: record.bearerToken, transport: this.transport, requestId: request.requestId, timeoutMs: this.timeoutMs });
    try {
      return await this.runApproved(request, record, tool, args, url, client);
    } finally {
      await client.close();
    }
  }

  private async runApproved(request: McpIdentity & { capabilityId: string; payload: unknown; approvalId: string }, record: McpConnectionRecord, tool: McpToolState, args: Record<string, unknown>, url: URL, client: McpClient): Promise<McpExecutionResult> {
    let identity;
    try {
      identity = await client.initialize();
    } catch (error) {
      this.markAuthRequiredIfRejected(request, record, error);
      throw error;
    }
    if (!this.identityMatches(record, identity.serverName, url.origin)) {
      this.markMismatch(request, record);
      throw err('MCP_IDENTITY_MISMATCH', 'POLICY', 'This MCP server no longer identifies as the server you connected. Its tools are disabled.', request.requestId);
    }
    let listed: unknown[];
    try {
      listed = await client.listTools();
    } catch (error) {
      this.markAuthRequiredIfRejected(request, record, error);
      throw error;
    }
    const advertised = listed.map(parseToolDescriptor).find((parsed) => parsed.ok && parsed.tool.name === tool.name);
    if (!advertised || !advertised.ok || advertised.tool.schemaHash !== tool.schemaHash) {
      tool.enabled = false;
      tool.changedSinceEnabled = true;
      this.deps.store.save(record);
      this.syncCapabilities(record);
      this.audit(request, 'mcp.tool_changed', 'DENIED', record.connectionId, { tool: tool.name });
      throw err('MCP_TOOL_CHANGED', 'POLICY', 'This tool changed since you enabled it. Review and enable it again.', request.requestId);
    }

    const executionId = generateResourceId('exe');
    const startedAt = getCurrentISOString();
    const payload = { connectionId: record.connectionId, tool: tool.name, arguments: args };
    // Approval consumption stays immediately before the provider call (hash-bound payload, one-time use).
    this.deps.approvals.consume(request.approvalId, request.tenantId, request.principalId, tool.capabilityId, payload, request.requestId, executionId);
    this.deps.executions.start({ executionId, toolId: tool.capabilityId, approvalId: request.approvalId, tenantId: request.tenantId, principalId: request.principalId, startedAt });
    this.deps.audit.logEvent({ actor: { type: 'user', id: request.principalId }, tenant_id: request.tenantId, action: 'tool.execution.started', resource: { type: 'ToolExecution', id: executionId }, result: 'PENDING_APPROVAL', request_id: request.requestId, details: { toolId: tool.capabilityId, approvalId: request.approvalId, provider: 'MCP' } });
    try {
      const result = await client.callTool(tool.name, args);
      if (result.isError) {
        // The tool itself reported an error: the call reached the server but the action did not succeed, so it is recorded as FAILED, never as a success.
        this.deps.executions.fail(executionId, { errorCode: 'MCP_TOOL_REPORTED_ERROR', completedAt: getCurrentISOString() });
        this.deps.audit.logEvent({ actor: { type: 'user', id: request.principalId }, tenant_id: request.tenantId, action: 'tool.execution.failed', resource: { type: 'ToolExecution', id: executionId }, result: 'FAILED', reason_code: 'MCP_TOOL_REPORTED_ERROR', request_id: request.requestId, details: { toolId: tool.capabilityId, provider: 'MCP' } });
        return { ...result, server: record.name, tool: tool.name, executionId, outcome: 'TOOL_REPORTED_ERROR', verification: { status: 'UNVERIFIED', reason: 'MCP_PROVIDER_RESPONSE_ONLY' } };
      }
      this.deps.executions.succeed(executionId, { externalId: `${record.connectionId}:${tool.name}`, externalUrl: url.origin, completedAt: getCurrentISOString() });
      this.deps.audit.logEvent({ actor: { type: 'user', id: request.principalId }, tenant_id: request.tenantId, action: 'tool.execution.succeeded', resource: { type: 'ToolExecution', id: executionId }, result: 'SUCCESS', request_id: request.requestId, details: { toolId: tool.capabilityId, provider: 'MCP', toolReportedError: result.isError } });
      // MCP offers no way to verify the side effect: the server's answer is reported as exactly that (a response), never as verified completion.
      return { ...result, server: record.name, tool: tool.name, executionId, outcome: 'TOOL_RESPONDED', verification: { status: 'UNVERIFIED', reason: 'MCP_PROVIDER_RESPONSE_ONLY' } };
    } catch (error) {
      this.markAuthRequiredIfRejected(request, record, error);
      const code = error instanceof NagexError ? error.code : 'MCP_EXECUTION_FAILED';
      this.deps.executions.fail(executionId, { errorCode: code, completedAt: getCurrentISOString() });
      this.deps.audit.logEvent({ actor: { type: 'user', id: request.principalId }, tenant_id: request.tenantId, action: 'tool.execution.failed', resource: { type: 'ToolExecution', id: executionId }, result: 'FAILED', reason_code: code, request_id: request.requestId, details: { toolId: tool.capabilityId, provider: 'MCP' } });
      throw error;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────────────────────

  private requireOwned(identity: McpIdentity, connectionId: string): McpConnectionRecord {
    const record = identity.tenantId && identity.principalId ? this.deps.store.get(identity.tenantId, identity.principalId, connectionId) : undefined;
    if (!record) throw notFound(identity.requestId);
    return record;
  }

  // Resolves a capability id to an enabled tool owned by the request identity, otherwise "not found" (never disclosing others').
  private resolveCallable(request: McpIdentity, capabilityId: string): { record: McpConnectionRecord; tool: McpToolState } {
    const record = this.deps.store.findByCapabilityId(capabilityId);
    if (!record || record.tenantId !== request.tenantId || record.principalId !== request.principalId) throw notFound(request.requestId);
    const tool = record.tools.find((t) => t.capabilityId === capabilityId);
    if (!tool) throw notFound(request.requestId);
    if (record.status !== 'CONNECTED') throw err('MCP_SERVER_NOT_TRUSTED', 'POLICY', 'This MCP server must be re-verified before it can be used.', request.requestId, { status: record.status });
    if (!tool.enabled || tool.changedSinceEnabled) throw err('MCP_TOOL_DISABLED', 'POLICY', 'This MCP tool is not enabled.', request.requestId);
    return { record, tool };
  }

  private argumentsFrom(payload: unknown, requestId: string): Record<string, unknown> {
    const raw = payload && typeof payload === 'object' ? (payload as { arguments?: unknown }).arguments : undefined;
    if (raw === undefined) return {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw err('MCP_INVALID_ARGUMENTS', 'VALIDATION', 'Tool arguments must be an object.', requestId);
    return raw as Record<string, unknown>;
  }

  private identityMatches(record: McpConnectionRecord, serverName: string, origin: string): boolean {
    return record.identity.serverName === serverName && record.identity.origin === origin;
  }

  // A failed re-verification: a rejected credential means the owner must reconnect; any other failure is a (retryable) error. Nothing stays callable.
  private markUnreachable(identity: McpIdentity, record: McpConnectionRecord, error: unknown, auditAction: string): void {
    const code = error instanceof NagexError ? error.code : 'MCP_ERROR';
    record.status = code === 'MCP_SERVER_AUTH_FAILED' ? 'AUTH_REQUIRED' : 'ERROR';
    record.reason = code;
    this.deps.store.save(record);
    this.syncCapabilities(record);
    this.audit(identity, auditAction, 'FAILED', record.connectionId, { reason: code });
  }

  // During a call only a rejected credential changes the connection (a timeout or a 5xx is transient and must not disable the owner's tools).
  private markAuthRequiredIfRejected(identity: McpIdentity, record: McpConnectionRecord, error: unknown): void {
    if (error instanceof NagexError && error.code === 'MCP_SERVER_AUTH_FAILED' && record.status === 'CONNECTED') this.markUnreachable(identity, record, error, 'mcp.server_auth_failed');
  }

  // Whether connections survive a restart (disclosed to the owner: without NAGEX_TOKEN_ENCRYPTION_KEY they are kept in memory only).
  public get durable(): boolean { return this.deps.store.durable; }

  private markMismatch(identity: McpIdentity, record: McpConnectionRecord): void {
    record.status = 'IDENTITY_MISMATCH';
    record.reason = 'SERVER_IDENTITY_CHANGED';
    for (const tool of record.tools) { tool.changedSinceEnabled = tool.changedSinceEnabled || tool.enabled; tool.enabled = false; }
    this.deps.store.save(record);
    this.syncCapabilities(record);
    this.audit(identity, 'mcp.identity_mismatch', 'DENIED', record.connectionId, { pinned: record.identity.serverName });
  }

  private syncCapabilities(record: McpConnectionRecord): void {
    for (const tool of record.tools) {
      const live = record.status === 'CONNECTED' && tool.enabled && !tool.changedSinceEnabled;
      if (live) this.deps.registry.registerDynamic({ id: tool.capabilityId, provider: 'MCP', risk: 'CONSEQUENTIAL', approval: 'REQUIRED', enabled: true });
      else this.deps.registry.unregisterDynamic(tool.capabilityId);
    }
  }

  private async discover(url: URL, bearerToken: string | null, requestId: string) {
    const client = new McpClient({ url, bearerToken, transport: this.transport, requestId, timeoutMs: this.timeoutMs });
    try {
      return await this.discoverFrom(client);
    } finally {
      await client.close();
    }
  }

  private async discoverFrom(client: McpClient): Promise<{ identity: { serverName: string; serverVersion: string; protocolVersion: string }; tools: Array<Omit<McpToolState, 'enabled' | 'changedSinceEnabled' | 'capabilityId'>>; rejected: Array<{ name: string; reason: string }> }> {
    const identity = await client.initialize();
    const tools: Array<Omit<McpToolState, 'enabled' | 'changedSinceEnabled' | 'capabilityId'>> = [];
    const rejected: Array<{ name: string; reason: string }> = [];
    const seen = new Set<string>();
    for (const raw of await client.listTools()) {
      const parsed = parseToolDescriptor(raw);
      if (!parsed.ok) { rejected.push({ name: parsed.name, reason: parsed.reason }); continue; }
      if (seen.has(parsed.tool.name)) { rejected.push({ name: parsed.tool.name, reason: 'DUPLICATE_NAME' }); continue; }
      seen.add(parsed.tool.name);
      tools.push({ name: parsed.tool.name, description: parsed.tool.description, inputSchema: parsed.tool.inputSchema, schemaHash: parsed.tool.schemaHash, readOnlyHint: parsed.tool.readOnlyHint });
    }
    return { identity, tools, rejected };
  }

  private audit(identity: McpIdentity, action: string, result: 'SUCCESS' | 'DENIED' | 'FAILED', connectionId: string, details: Record<string, unknown>): void {
    this.deps.audit.logEvent({ actor: { type: 'user', id: identity.principalId }, tenant_id: identity.tenantId, action, resource: { type: 'McpConnection', id: connectionId }, result, request_id: identity.requestId, details });
  }
}
