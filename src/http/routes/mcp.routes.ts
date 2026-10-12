// User-owned MCP servers. Identity comes ONLY from the server-side session (resolveAuthenticatedIdentity): the body, query and
// X-Principal-Id / X-NAgex-Tenant headers never decide whose server is read or changed, and a server owned by someone else is
// reported as not found. Tools are never called from here directly: an invoke goes through CapabilityBroker.execute, so the
// Permission Authority, the hash-bound one-time ActionApproval and the audit/execution records apply unchanged.
import crypto from 'node:crypto';
import { NagexError } from '../../common/errors.js';
import type { CapabilityBroker } from '../../capabilities/capability-broker.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import type { McpService } from '../../mcp/mcp.service.js';
import { resolveAuthenticatedIdentity } from '../request-identity.js';
import type { ApiResult, AsyncRouteRegistrar } from '../http-types.js';

export interface McpRouteDeps {
  sessionStore: SessionStore;
  identityStore: IdentityStore;
  mcpService?: McpService;
  capabilityBroker?: CapabilityBroker;
}

const STATUS_BY_CATEGORY: Record<string, number> = {
  VALIDATION: 400, AUTHENTICATION: 401, AUTHORIZATION: 403, POLICY: 409, NOT_FOUND: 404, CONFLICT: 409, QUOTA: 429, RATE_LIMIT: 429, TIMEOUT: 504, PROVIDER: 502,
};

function errorResult(error: unknown): ApiResult {
  if (error instanceof NagexError) {
    // An MCP server rejecting OUR credential is an upstream failure (502), never a statement about the user's NAgex session (401).
    const status = error.code === 'MCP_SERVER_AUTH_FAILED' ? 502 : STATUS_BY_CATEGORY[error.category] ?? 500;
    return { status, data: { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } } };
  }
  throw error;
}

export const handleMcpRoutes: AsyncRouteRegistrar<McpRouteDeps> = async (method, pathname, body, headers, _query, deps): Promise<ApiResult | undefined> => {
  if (!pathname.startsWith('/api/v1/mcp/')) return undefined;
  const owner = resolveAuthenticatedIdentity(headers, deps);
  if (!owner) return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to manage MCP servers.' } } };
  const { mcpService, capabilityBroker } = deps;
  if (!mcpService) return { status: 503, data: { error: { code: 'MCP_NOT_AVAILABLE', message: 'MCP servers are not available.' } } };
  const rawRequestId = headers['x-request-id'];
  const requestId = (Array.isArray(rawRequestId) ? rawRequestId[0] : rawRequestId) || `req_mcp_${crypto.randomUUID()}`;
  const identity = { tenantId: owner.tenantId, principalId: owner.principalId, requestId };

  try {
    if (pathname === '/api/v1/mcp/servers' && method === 'GET') {
      const servers = mcpService.list(identity);
      return { status: 200, data: { servers, total: servers.length } };
    }
    if (pathname === '/api/v1/mcp/servers' && method === 'POST') {
      const server = await mcpService.addServer(identity, { name: body?.name, url: body?.url, bearerToken: body?.bearerToken });
      return { status: 201, data: { server } };
    }

    const match = /^\/api\/v1\/mcp\/servers\/(mcp_[a-f0-9]{16})(?:\/(refresh|tools\/([A-Za-z][A-Za-z0-9_.-]{0,63})(?:\/(invoke))?))?$/.exec(pathname);
    if (!match) return { status: 404, data: { error: { code: 'MCP_NOT_FOUND', message: 'That MCP server or tool was not found.' } } };
    const [, connectionId, , toolName, invoke] = match;

    if (!match[2] && method === 'GET') return { status: 200, data: { server: mcpService.get(identity, connectionId) } };
    if (!match[2] && (method === 'DELETE' || method === 'POST')) {
      if (method === 'POST' && body?.action !== 'remove') return undefined;
      mcpService.remove(identity, connectionId);
      return { status: 200, data: { removed: true } };
    }
    if (match[2] === 'refresh' && method === 'POST') return { status: 200, data: { server: await mcpService.refresh(identity, connectionId) } };

    if (toolName && !invoke && method === 'POST') {
      if (typeof body?.enabled !== 'boolean') return { status: 400, data: { error: { code: 'MCP_INVALID_REQUEST', message: '"enabled" must be true or false.' } } };
      return { status: 200, data: { server: mcpService.setToolEnabled(identity, connectionId, toolName, body.enabled) } };
    }

    if (toolName && invoke && method === 'POST') {
      if (!capabilityBroker) return { status: 503, data: { error: { code: 'MCP_NOT_AVAILABLE', message: 'MCP servers are not available.' } } };
      const server = mcpService.get(identity, connectionId);
      const tool = server.tools.find((entry) => entry.name === toolName);
      if (!tool) return { status: 404, data: { error: { code: 'MCP_NOT_FOUND', message: 'That MCP server or tool was not found.' } } };
      const approvalId = typeof body?.approvalId === 'string' && body.approvalId ? body.approvalId : undefined;
      const result = await capabilityBroker.execute({
        capabilityId: tool.capabilityId,
        tenantId: owner.tenantId,
        principalId: owner.principalId,
        requestId,
        payload: { arguments: body?.arguments ?? {} },
        source: 'WEB',
        approvalId,
      });
      if (result.status === 'EXECUTED') return { status: 200, data: result };
      if (result.status === 'APPROVAL_REQUIRED') return { status: 202, data: result };
      return { status: 403, data: result };
    }
    return undefined;
  } catch (error) {
    return errorResult(error);
  }
};
