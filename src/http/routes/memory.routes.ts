import type { MemoryEngine, MemoryRecord, MemoryScope, MemoryType } from '../../context/memory.engine.js';
import type { PrincipalReference } from '../../common/types.js';
import type { ApiResult, SyncRouteRegistrar } from '../http-types.js';
import { getCurrentISOString } from '../../common/utils.js';
import type { IdentityStore } from '../../identity/identity.store.js';
import type { SessionStore } from '../../sessions/session.store.js';
import { resolveAuthenticatedIdentity } from '../request-identity.js';
import type { AuditLogger } from '../../governance/audit.logger.js';
import { inferMemoryExpiry } from '../../context/memory-expiry.js';
import { isValidTimeZone, wallTimeToInstant, addDays } from '../../common/time-context.js';

export interface MemoryRouteDeps {
  memoryEngine: MemoryEngine;
  pinnedMemories: Set<string>;
  tenantId: string;
  principal: PrincipalReference;
  modelErrorResult: (error: unknown) => ApiResult;
  // R24.6C — memory SETTINGS are personal Settings owned by the authenticated
  // session. Absent stores fail closed (401).
  sessionStore?: SessionStore;
  identityStore?: IdentityStore;
  // R26-C: corrections and restorations are audited (ids only - never the text of a memory)
  auditLogger?: Pick<AuditLogger, 'logEvent'>;
}

const VALID_SCOPES = new Set(['PERSONAL', 'USER', 'ORGANIZATION', 'WORKSPACE', 'SESSION', 'AGENT', 'TENANT']);
const VALID_TYPES = new Set(['PREFERENCE', 'FACT', 'RELATIONSHIP', 'PROJECT_CONTEXT', 'DECISION', 'WORKING_CONTEXT']);
const VALID_SOURCE_TYPES = new Set(['CONVERSATION', 'MANUAL', 'SYSTEM', 'DOCUMENT', 'TOOL_RESULT', 'LINK', 'VAULT', 'INBOX', 'BROWSER']);
const VALID_SENSITIVITIES = new Set(['S0', 'S1', 'S2', 'S3']);

export const handleMemoryRoutes: SyncRouteRegistrar<MemoryRouteDeps> = (method, pathname, body, headers, _query, deps): ApiResult | undefined => {
  const { memoryEngine, pinnedMemories, tenantId, principal, modelErrorResult } = deps;

  // ---- R26-C: history, correction (never an overwrite), restoration, time-bound context. Owner and tenant come from the session; another person's memory is indistinguishable from none.
  const audit = (action: string, resourceId: string, details: Record<string, unknown>) => {
    deps.auditLogger?.logEvent({ actor: { type: 'user', id: principal.id }, tenant_id: tenantId, action, resource: { type: 'Memory', id: resourceId }, result: 'SUCCESS', request_id: `req_mem_${Date.now()}`, details });
  };
  const timezoneOf = (b: Record<string, unknown> | null | undefined): string => (typeof b?.timezone === 'string' && isValidTimeZone(b.timezone) ? b.timezone : 'UTC');
  // an explicit end: an ISO instant, or a day ("2026-10-23") that ends at the end of that day in the person's timezone
  const explicitExpiry = (b: Record<string, unknown> | null | undefined): { ok: true; expiresAt?: string } | { ok: false } => {
    if (typeof b?.expiresAt === 'string' && b.expiresAt) return Number.isFinite(Date.parse(b.expiresAt)) ? { ok: true, expiresAt: new Date(Date.parse(b.expiresAt)).toISOString() } : { ok: false };
    if (typeof b?.expiresOn === 'string' && b.expiresOn) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(b.expiresOn);
      if (!m) return { ok: false };
      const next = addDays({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, 1);
      return { ok: true, expiresAt: new Date(wallTimeToInstant({ year: next.year, month: next.month, day: next.day, hour: 0, minute: 0 }, timezoneOf(b)).ms - 1).toISOString() };
    }
    return { ok: true };
  };


  if (pathname === '/api/v1/memory/settings' && (method === 'GET' || method === 'POST' || method === 'PATCH')) {
    // Ownership from the session ONLY — the header-derived tenantId/principal
    // above are deliberately not used for this endpoint.
    const owner = deps.sessionStore && deps.identityStore ? resolveAuthenticatedIdentity(headers, { sessionStore: deps.sessionStore, identityStore: deps.identityStore }) : null;
    if (!owner) return { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'Sign in to view or change memory settings.' } } };
    if (method !== 'POST' && method !== 'PATCH') return { status: 200, data: memoryEngine.getSettings(owner.tenantId, owner.principalId) };
    const memoryCaptureEnabled = typeof body?.memoryCaptureEnabled === 'boolean' ? body.memoryCaptureEnabled : undefined;
    const memoryUseEnabled = typeof body?.memoryUseEnabled === 'boolean' ? body.memoryUseEnabled : undefined;
    const updated = memoryEngine.updateSettings(owner.tenantId, owner.principalId, { memoryCaptureEnabled, memoryUseEnabled });
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

      // an explicit end ("until 2026-10-30") or one the text states itself ("금요일까지"); the end must be a future instant within five years
      const explicit = explicitExpiry(body);
      if (!explicit.ok) return { status: 400, data: { error: 'MEMORY_EXPIRY_INVALID', message: 'The end date is not valid.' } };
      const expiresAt = explicit.expiresAt ?? (typeof value === 'string' ? inferMemoryExpiry(value, Date.now(), timezoneOf(body))?.expiresAt : undefined);
      if (expiresAt && (Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) > Date.now() + 5 * 365 * 24 * 3600_000)) {
        return { status: 400, data: { error: 'MEMORY_EXPIRY_INVALID', message: 'The end date must be in the future (within five years).' } };
      }

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
        ...(expiresAt ? { expiresAt } : {}),
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
    // hasHistory: this fact was corrected (or restored) before - its earlier versions are one click away
    const allMemories = Array.from(combinedMap.values()).map((m) => ({ ...m, pinned: pinnedMemories.has(m.id), hasHistory: memoryEngine.getSupersessionChain(m.id, tenantId, principal.id).length > 1 }));
    return { status: 200, data: { memories: allMemories, total: allMemories.length } };
  }

  if (pathname === '/api/v1/memory/history' && method === 'GET') {
    const { groups, expired } = memoryEngine.history(tenantId, principal.id);
    return { status: 200, data: { groups, expired } };
  }

  const correctMatch = /^\/api\/v1\/memory\/([A-Za-z0-9_-]{4,80})\/correct$/.exec(pathname);
  if (correctMatch && method === 'POST') {
    const memId = correctMatch[1];
    const value = typeof body?.value === 'string' ? body.value : '';
    if (!value.trim()) return { status: 400, data: { error: 'MEMORY_VALUE_INVALID', message: 'The corrected text is required.' } };
    const explicit = explicitExpiry(body);
    if (!explicit.ok) return { status: 400, data: { error: 'MEMORY_EXPIRY_INVALID', message: 'The end date is not valid.' } };
    try {
      if (!memoryEngine.get(memId, tenantId, principal.id)) return { status: 404, data: { error: 'MEMORY_NOT_FOUND', message: `Memory ${memId} was not found.` } };
      // no end typed: a correction that bounds itself in time ("금요일까지") is time-bound like any statement
      const inferred = explicit.expiresAt ? null : inferMemoryExpiry(value, Date.now(), timezoneOf(body));
      const expiresAt = explicit.expiresAt ?? inferred?.expiresAt;
      const { current, previous } = memoryEngine.correctMemory(memId, tenantId, principal.id, { value, expiresAt: expiresAt ?? null });
      if (pinnedMemories.has(previous.id)) { pinnedMemories.delete(previous.id); pinnedMemories.add(current.id); }
      audit('memory.corrected', current.id, { replaced: previous.id, sensitivity: current.sensitivity, timeBound: Boolean(current.expiresAt) });
      return { status: 200, data: { current: { ...current, pinned: pinnedMemories.has(current.id) }, previous: { ...previous, pinned: false }, ...(inferred ? { expiryInferredFrom: inferred.basis } : {}) } };
    } catch (error) {
      return modelErrorResult(error);
    }
  }

  const restoreMatch = /^\/api\/v1\/memory\/([A-Za-z0-9_-]{4,80})\/restore$/.exec(pathname);
  if (restoreMatch && method === 'POST') {
    const memId = restoreMatch[1];
    try {
      const existing = memoryEngine.get(memId, tenantId, principal.id);
      if (!existing) return { status: 404, data: { error: 'MEMORY_NOT_FOUND', message: `Memory ${memId} was not found.` } };
      if (existing.lifecycle === 'EXPIRED') {
        const explicit = explicitExpiry(body);
        if (!explicit.ok) return { status: 400, data: { error: 'MEMORY_EXPIRY_INVALID', message: 'The end date is not valid.' } };
        const renewed = memoryEngine.renewExpired(memId, tenantId, principal.id, explicit.expiresAt ?? null);
        audit('memory.renewed', renewed.id, { sensitivity: renewed.sensitivity, timeBound: Boolean(renewed.expiresAt) });
        return { status: 200, data: { restored: { ...renewed, pinned: pinnedMemories.has(renewed.id) } } };
      }
      const restored = memoryEngine.restoreSuperseded(memId, tenantId, principal.id);
      audit('memory.restored', restored.id, { sensitivity: restored.sensitivity });
      return { status: 200, data: { restored: { ...restored, pinned: pinnedMemories.has(restored.id) } } };
    } catch (error) {
      return modelErrorResult(error);
    }
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

