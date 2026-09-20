import type { MemoryEngine, MemoryRecord, MemoryScope, MemoryType } from '../../context/memory.engine.js';
import type { PrincipalReference } from '../../common/types.js';
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';
import { getCurrentISOString } from '../../common/utils.js';

export interface MemoryRouteDeps {
  memoryEngine: MemoryEngine;
  pinnedMemories: Set<string>;
  tenantId: string;
  principal: PrincipalReference;
  modelErrorResult: (error: unknown) => ApiResult;
}

const VALID_SCOPES = new Set(['PERSONAL', 'USER', 'ORGANIZATION', 'WORKSPACE', 'SESSION', 'AGENT', 'TENANT']);
const VALID_TYPES = new Set(['PREFERENCE', 'FACT', 'RELATIONSHIP', 'PROJECT_CONTEXT', 'DECISION', 'WORKING_CONTEXT']);
const VALID_SOURCE_TYPES = new Set(['CONVERSATION', 'MANUAL', 'SYSTEM', 'DOCUMENT', 'TOOL_RESULT', 'LINK', 'VAULT', 'INBOX', 'BROWSER']);
const VALID_SENSITIVITIES = new Set(['S0', 'S1', 'S2', 'S3']);

export const handleMemoryRoutes: SyncRouteRegistrar<MemoryRouteDeps> = (method, pathname, body, _headers, _query, deps): ApiResult | undefined => {
  const { memoryEngine, pinnedMemories, tenantId, principal, modelErrorResult } = deps;

  if (pathname === '/api/v1/memory/settings' && method === 'GET') {
    const settings = memoryEngine.getSettings(tenantId, principal.id);
    return { status: 200, data: settings };
  }

  if (pathname === '/api/v1/memory/settings' && (method === 'POST' || method === 'PATCH')) {
    const memoryCaptureEnabled = typeof body?.memoryCaptureEnabled === 'boolean' ? body.memoryCaptureEnabled : undefined;
    const memoryUseEnabled = typeof body?.memoryUseEnabled === 'boolean' ? body.memoryUseEnabled : undefined;
    const updated = memoryEngine.updateSettings(tenantId, principal.id, {
      memoryCaptureEnabled,
      memoryUseEnabled,
    });
    return { status: 200, data: updated };
  }

  if (pathname === '/api/v1/memory/candidates' && method === 'GET') {
    const candidates = memoryEngine.getProposedCandidates(tenantId, principal.id)
      .map((m) => ({ ...m, pinned: pinnedMemories.has(m.id) }));
    return { status: 200, data: { candidates, total: candidates.length } };
  }

  if (pathname === '/api/v1/memory/remember' && method === 'POST') {
    try {
      if (body?.scope !== undefined && (typeof body.scope !== 'string' || !VALID_SCOPES.has(body.scope))) {
        return { status: 400, data: { error: 'INVALID_ENUM', message: `Invalid scope: ${body.scope}` } };
      }
      if (body?.type !== undefined && (typeof body.type !== 'string' || !VALID_TYPES.has(body.type))) {
        return { status: 400, data: { error: 'INVALID_ENUM', message: `Invalid type: ${body.type}` } };
      }
      if (body?.sourceType !== undefined && (typeof body.sourceType !== 'string' || !VALID_SOURCE_TYPES.has(body.sourceType))) {
        return { status: 400, data: { error: 'INVALID_ENUM', message: `Invalid sourceType: ${body.sourceType}` } };
      }
      if (body?.sensitivity !== undefined && (typeof body.sensitivity !== 'string' || !VALID_SENSITIVITIES.has(body.sensitivity))) {
        return { status: 400, data: { error: 'INVALID_ENUM', message: `Invalid sensitivity: ${body.sensitivity}` } };
      }

      const scope = ((body?.scope as string) || 'USER') as MemoryScope;
      const type = typeof body?.type === 'string' ? (body.type as MemoryType) : 'FACT';
      const subject = (body?.subject as string) || 'User Preference';
      const predicate = (body?.predicate as string) || 'preference';
      const value = body?.value || body?.content || '';
      const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;
      const sourceType = typeof body?.sourceType === 'string' ? (body.sourceType as any) : 'MANUAL';
      const sourceId = typeof body?.sourceId === 'string' ? body.sourceId : undefined;
      const sensitivity = typeof body?.sensitivity === 'string' ? (body.sensitivity as any) : 'S1';

      const record = memoryEngine.createMemory({
        scope,
        type,
        tenantId,
        ownerId: principal.id,
        workspaceId,
        content: { subject, predicate, value },
        userConfirmed: typeof body?.userConfirmed === 'boolean' ? body.userConfirmed : true,
        memoryOrigin: 'EXPLICIT_USER',
        sensitivity,
        provenance: {
          sourceType,
          sourceId,
          extractedAt: getCurrentISOString(),
          extractor: 'USER_EXPLICIT',
        },
      });

      if (body?.pinned) pinnedMemories.add(record.id);
      return { status: 201, data: { ...record, pinned: pinnedMemories.has(record.id) } };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname === '/api/v1/memory' && method === 'GET') {
    const scopes: MemoryScope[] = ['PERSONAL', 'ORGANIZATION', 'WORKSPACE', 'USER', 'SESSION', 'AGENT', 'TENANT'];
    const activeMemories = scopes.flatMap((s) => memoryEngine.getActiveMemories(s, tenantId, principal.id));
    const proposedMemories = memoryEngine.getProposedCandidates(tenantId, principal.id);
    const combinedMap = new Map<string, MemoryRecord>();
    for (const m of [...activeMemories, ...proposedMemories]) {
      combinedMap.set(m.id, m);
    }
    const allMemories = Array.from(combinedMap.values()).map((m) => ({ ...m, pinned: pinnedMemories.has(m.id) }));
    return { status: 200, data: { memories: allMemories, total: allMemories.length } };
  }

  if (pathname.startsWith('/api/v1/memory/') && pathname.endsWith('/confirm') && method === 'POST') {
    const memId = pathname.slice('/api/v1/memory/'.length, -'/confirm'.length);
    try {
      const confirmed = memoryEngine.confirmMemory(memId, tenantId, principal.id);
      return { status: 200, data: { ...confirmed, pinned: pinnedMemories.has(confirmed.id) } };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  if (pathname.startsWith('/api/v1/memory/') && pathname.endsWith('/reject') && method === 'POST') {
    const memId = pathname.slice('/api/v1/memory/'.length, -'/reject'.length);
    try {
      const rejected = memoryEngine.rejectMemory(memId, tenantId, principal.id);
      pinnedMemories.delete(memId);
      return { status: 200, data: { ...rejected, pinned: false } };
    } catch (error) {
      return modelErrorResult(error);
    }
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
    try {
      if (body?.scope !== undefined && (typeof body.scope !== 'string' || !VALID_SCOPES.has(body.scope))) {
        return { status: 400, data: { error: 'INVALID_ENUM', message: `Invalid scope: ${body.scope}` } };
      }
      if (body?.type !== undefined && (typeof body.type !== 'string' || !VALID_TYPES.has(body.type))) {
        return { status: 400, data: { error: 'INVALID_ENUM', message: `Invalid type: ${body.type}` } };
      }

      const scope = ((body?.scope as string) || 'USER') as MemoryScope;
      const type = body?.type as any;
      const sourceRef = (body?.sourceRef as string) || (body?.source_ref as string);
      const confidence = typeof body?.confidence === 'number' ? body.confidence : undefined;
      const subject = (body?.subject as string) || 'User Preference';
      const predicate = (body?.predicate as string) || 'preference';
      const value = body?.value || body?.content || '';
      const sensitivity = typeof body?.sensitivity === 'string' ? (body.sensitivity as any) : undefined;

      if (body?.sensitivity !== undefined && (typeof body.sensitivity !== 'string' || !VALID_SENSITIVITIES.has(body.sensitivity))) {
        return { status: 400, data: { error: 'INVALID_ENUM', message: `Invalid sensitivity: ${body.sensitivity}` } };
      }

      const rec = memoryEngine.proposeMemory(
        scope,
        tenantId,
        principal.id,
        { subject, predicate, value },
        undefined,
        { type, sourceRef, confidence, sensitivity }
      );

      // P0 Closure: If effective sensitivity === S2, keep PROPOSED, userConfirmed = false, DO NOT call activateMemory
      if (rec.sensitivity === 'S2') {
        if (body?.pinned) pinnedMemories.add(rec.id);
        return { status: 201, data: { ...rec, pinned: pinnedMemories.has(rec.id) } };
      }

      const activated = memoryEngine.activateMemory(rec.id, tenantId, principal.id);
      if (body?.pinned) pinnedMemories.add(activated.id);
      return { status: 201, data: { ...activated, pinned: pinnedMemories.has(activated.id) } };
    } catch (error) {
      return modelErrorResult(error);
    }
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
      if (body?.scope !== undefined && (typeof body.scope !== 'string' || !VALID_SCOPES.has(body.scope))) {
        return { status: 400, data: { error: 'INVALID_ENUM', message: `Invalid scope: ${body.scope}` } };
      }
      if (body?.type !== undefined && (typeof body.type !== 'string' || !VALID_TYPES.has(body.type))) {
        return { status: 400, data: { error: 'INVALID_ENUM', message: `Invalid type: ${body.type}` } };
      }

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

