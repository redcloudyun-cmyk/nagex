// R10.2-D Increment 2 — Memory routes, extracted verbatim from
// server_web.ts's handleApiRequest. Read/propose/activate/delete/pin —
// no approval gate (Memory has never required one; this file changes
// nothing about that), tenant/principal-scoped throughout via the
// tenantId/principal already resolved by the caller (identity extraction
// itself is NOT duplicated here — this module trusts the caller's already-
// computed identity, exactly like the pre-refactor inline code did).
import type { MemoryEngine, MemoryScope } from '../../context/memory.engine.js';
import type { PrincipalReference } from '../../common/types.js';
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';

export interface MemoryRouteDeps {
  memoryEngine: MemoryEngine;
  pinnedMemories: Set<string>;
  tenantId: string;
  principal: PrincipalReference;
  modelErrorResult: (error: unknown) => ApiResult;
}

export const handleMemoryRoutes: SyncRouteRegistrar<MemoryRouteDeps> = (method, pathname, body, _headers, _query, deps): ApiResult | undefined => {
  const { memoryEngine, pinnedMemories, tenantId, principal, modelErrorResult } = deps;

  if (pathname === '/api/v1/memory' && method === 'GET') {
    const activeUserMems = memoryEngine.getActiveMemories('USER', tenantId, principal.id);
    const activeSessionMems = memoryEngine.getActiveMemories('SESSION', tenantId, principal.id);
    const activeAgentMems = memoryEngine.getActiveMemories('AGENT', tenantId, principal.id);
    const activeTenantMems = memoryEngine.getActiveMemories('TENANT', tenantId, principal.id);
    const allMemories = [...activeUserMems, ...activeSessionMems, ...activeAgentMems, ...activeTenantMems].map((m) => ({ ...m, pinned: pinnedMemories.has(m.id) }));
    return { status: 200, data: { memories: allMemories, total: allMemories.length } };
  }

  if (pathname === '/api/v1/memory' && method === 'POST') {
    const scope = ((body?.scope as string) || 'USER') as MemoryScope;
    const subject = (body?.subject as string) || 'General';
    const predicate = (body?.predicate as string) || 'note';
    const value = body?.value || '';
    const rec = memoryEngine.proposeMemory(scope, tenantId, principal.id, { subject, predicate, value });
    const activated = memoryEngine.activateMemory(rec.id, tenantId, principal.id);
    if (body?.pinned) pinnedMemories.add(activated.id);
    return { status: 201, data: { ...activated, pinned: pinnedMemories.has(activated.id) } };
  }

  if (pathname.startsWith('/api/v1/memory/') && method === 'DELETE') {
    const memId = pathname.replace('/api/v1/memory/', '');
    try {
      memoryEngine.deleteMemory(memId, tenantId, principal.id);
    } catch (error) {
      return modelErrorResult(error);
    }
    pinnedMemories.delete(memId);
    return { status: 200, data: { success: true, deleted_id: memId } };
  }

  if (pathname.startsWith('/api/v1/memory/') && pathname.endsWith('/pin') && method === 'PUT') {
    const memId = pathname.replace('/api/v1/memory/', '').replace('/pin', '');
    if (!memoryEngine.get(memId, tenantId, principal.id)) {
      return { status: 404, data: { error: 'MEMORY_NOT_FOUND', message: `Memory ${memId} was not found.` } };
    }
    if (pinnedMemories.has(memId)) pinnedMemories.delete(memId);
    else pinnedMemories.add(memId);
    return { status: 200, data: { success: true, pinned: pinnedMemories.has(memId) } };
  }

  return undefined;
};
