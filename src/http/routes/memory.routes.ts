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
    const scopes: MemoryScope[] = ['PERSONAL', 'ORGANIZATION', 'WORKSPACE', 'USER', 'SESSION', 'AGENT', 'TENANT'];
    const allMemories = scopes
      .flatMap((s) => memoryEngine.getActiveMemories(s, tenantId, principal.id))
      .map((m) => ({ ...m, pinned: pinnedMemories.has(m.id) }));
    return { status: 200, data: { memories: allMemories, total: allMemories.length } };
  }

  if (pathname.startsWith('/api/v1/memory/') && !pathname.endsWith('/pin') && method === 'GET') {
    const memId = pathname.slice('/api/v1/memory/'.length);
    try {
      const rec = memoryEngine.get(memId, tenantId, principal.id);
      if (!rec) {
        return { status: 404, data: { error: 'MEMORY_NOT_FOUND', message: `Memory ${memId} not found.` } };
      }
      return { status: 200, data: { ...rec, pinned: pinnedMemories.has(rec.id) } };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname === '/api/v1/memory' && method === 'POST') {
    const scope = ((body?.scope as string) || 'USER') as MemoryScope;
    const type = body?.type as any;
    const sourceRef = (body?.sourceRef as string) || (body?.source_ref as string);
    const confidence = typeof body?.confidence === 'number' ? body.confidence : undefined;
    const subject = (body?.subject as string) || 'User Preference';
    const predicate = (body?.predicate as string) || 'preference';
    const value = body?.value || body?.content || '';
    const rec = memoryEngine.proposeMemory(
      scope,
      tenantId,
      principal.id,
      { subject, predicate, value },
      undefined,
      { type, sourceRef, confidence }
    );
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

  if (pathname.startsWith('/api/v1/memory/') && method === 'PATCH') {
    const memId = pathname.slice('/api/v1/memory/'.length);
    try {
      const subject = typeof body?.subject === 'string' ? body.subject : undefined;
      const predicate = typeof body?.predicate === 'string' ? body.predicate : undefined;
      const value = body?.value !== undefined ? body.value : body?.content !== undefined ? body.content : undefined;
      const scope = typeof body?.scope === 'string' ? (body.scope as MemoryScope) : undefined;
      const type = typeof body?.type === 'string' ? (body.type as any) : undefined;
      const sourceRef = typeof body?.sourceRef === 'string' ? body.sourceRef : undefined;

      const existing = memoryEngine.get(memId, tenantId, principal.id);
      if (!existing) {
        return { status: 404, data: { error: 'MEMORY_NOT_FOUND', message: `Memory ${memId} was not found.` } };
      }

      const content = {
        subject: subject || existing.content.subject,
        predicate: predicate || existing.content.predicate,
        value: value !== undefined ? value : existing.content.value,
      };

      const updated = memoryEngine.updateMemory(memId, tenantId, principal.id, {
        scope,
        type,
        content,
        sourceRef,
      });
      return { status: 200, data: { ...updated, pinned: pinnedMemories.has(updated.id) } };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  return undefined;
};
