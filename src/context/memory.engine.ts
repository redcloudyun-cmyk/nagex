import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { resolveEffectiveSensitivity } from './sensitivity.detector.js';

export type MemoryScope = 'EXECUTION' | 'SESSION' | 'AGENT' | 'USER' | 'TENANT' | 'PERSONAL' | 'ORGANIZATION' | 'WORKSPACE';
export type MemoryType = 'PREFERENCE' | 'FACT' | 'RELATIONSHIP' | 'PROJECT_CONTEXT' | 'DECISION' | 'WORKING_CONTEXT';
export type MemoryLifecycle = 'PROPOSED' | 'VALIDATING' | 'ACTIVE' | 'CONFLICTED' | 'SUPERSEDED' | 'EXPIRED' | 'DELETED';

export type MemorySourceType =
  | 'CONVERSATION'
  | 'CALL'
  | 'EMAIL'
  | 'CALENDAR'
  | 'MESSAGE'
  | 'FILE'
  | 'BROWSER'
  | 'MANUAL'
  | 'ACTION_OUTCOME'
  | 'SYSTEM'
  | 'LINK'
  | 'VAULT'
  | 'INBOX';

export type SensitivityLevel = 'S0' | 'S1' | 'S2' | 'S3';

export type MemoryOrigin =
  | 'EXPLICIT_USER'
  | 'SUGGESTED'
  | 'SYSTEM_DERIVED'
  | 'ACTION_OUTCOME'
  | 'LEGACY';

export interface MemoryProvenance {
  sourceType: MemorySourceType;
  sourceId?: string;
  sourceRef?: string;
  sessionId?: string;
  messageId?: string;
  extractedAt: string;
  extractor:
    | 'USER_EXPLICIT'
    | 'RULE_BASED'
    | 'MODEL_ASSISTED'
    | 'ACTION_OUTCOME'
    | 'MANUAL';
  modelProvider?: string;
  modelName?: string;
  confidence?: number;
  originalAvailable?: boolean;
}

export interface MemoryContextRefs {
  workspaceId?: string;
  projectId?: string;
  personIds?: string[];
}

export interface MemoryUserSettings {
  memoryCaptureEnabled: boolean;
  memoryUseEnabled: boolean;
}

export interface MemoryUserSettingsRecord extends MemoryUserSettings {
  id: string; // `${tenantId}:${ownerId}`
  tenantId: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export function isMemoryUserSettingsRecord(value: unknown): value is MemoryUserSettingsRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.ownerId === 'string' &&
    typeof v.memoryCaptureEnabled === 'boolean' &&
    typeof v.memoryUseEnabled === 'boolean'
  );
}

const VALID_SCOPES: ReadonlySet<string> = new Set(['EXECUTION', 'SESSION', 'AGENT', 'USER', 'TENANT', 'PERSONAL', 'ORGANIZATION', 'WORKSPACE']);
const VALID_LIFECYCLES: ReadonlySet<string> = new Set([
  'PROPOSED',
  'VALIDATING',
  'ACTIVE',
  'CONFLICTED',
  'SUPERSEDED',
  'EXPIRED',
  'DELETED',
]);

const TERMINAL_MEMORY_STATES: ReadonlySet<MemoryLifecycle> = new Set([
  'CONFLICTED',
  'SUPERSEDED',
  'EXPIRED',
  'DELETED',
]);

const LEGACY_BACKFILL_TENANT_ID = 'ten_production_01';

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  type?: MemoryType;
  tenantId?: string;
  owner_id: string;
  workspaceId?: string;
  lifecycle: MemoryLifecycle;
  content: {
    subject: string;
    predicate: string;
    value: unknown;
  };
  sourceRef?: string;
  confidence?: number;
  candidateId?: string;
  sensitivity?: SensitivityLevel;
  provenance?: MemoryProvenance;
  memoryOrigin?: MemoryOrigin;
  userConfirmed?: boolean;
  contextRefs?: MemoryContextRefs;
  pinned?: boolean;
  created_at: string;
  updated_at: string;
  last_used_at?: string;
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !v.id.trim()) return false;
  if (typeof v.scope !== 'string' || !VALID_SCOPES.has(v.scope)) return false;
  if (v.tenantId !== undefined && (typeof v.tenantId !== 'string' || !v.tenantId.trim())) return false;
  if (typeof v.owner_id !== 'string' || !v.owner_id.trim()) return false;
  if (typeof v.lifecycle !== 'string' || !VALID_LIFECYCLES.has(v.lifecycle)) return false;
  if (!v.content || typeof v.content !== 'object') return false;
  const c = v.content as Record<string, unknown>;
  if (typeof c.subject !== 'string' || !c.subject.trim()) return false;
  if (typeof c.predicate !== 'string' || !c.predicate.trim()) return false;
  if (typeof v.created_at !== 'string' || !v.created_at.trim()) return false;
  if (typeof v.updated_at !== 'string' || !v.updated_at.trim()) return false;
  if (v.candidateId !== undefined && typeof v.candidateId !== 'string') return false;
  return true;
}

export interface MemoryEngineOptions {
  dir?: string;
  settingsDir?: string;
  env?: NodeJS.ProcessEnv;
}

export class MemoryEngine {
  private readonly fileStore: FileRecordStore<MemoryRecord>;
  private readonly memoryStore: Map<string, MemoryRecord> = new Map();
  private readonly settingsFileStore: FileRecordStore<MemoryUserSettingsRecord>;
  private readonly settingsMap: Map<string, MemoryUserSettingsRecord> = new Map();

  constructor(options?: MemoryEngineOptions) {
    const dir = options?.dir ?? resolveNagexDataDir('memories', 'NAGEX_MEMORIES_DIR', options?.env);
    this.fileStore = new FileRecordStore<MemoryRecord>(dir, isMemoryRecord);

    const settingsDir = options?.settingsDir ?? resolveNagexDataDir('memory-settings', 'NAGEX_MEMORY_SETTINGS_DIR', options?.env);
    this.settingsFileStore = new FileRecordStore<MemoryUserSettingsRecord>(settingsDir, isMemoryUserSettingsRecord);

    for (const record of this.fileStore.readAll()) {
      let updatedRecord = record;
      let needsWrite = false;

      if (updatedRecord.tenantId === undefined) {
        updatedRecord = { ...updatedRecord, tenantId: LEGACY_BACKFILL_TENANT_ID };
        needsWrite = true;
      }
      if (updatedRecord.sensitivity === undefined) {
        updatedRecord = { ...updatedRecord, sensitivity: 'S1' };
        needsWrite = true;
      }
      if (updatedRecord.userConfirmed === undefined) {
        updatedRecord = { ...updatedRecord, userConfirmed: true };
        needsWrite = true;
      }
      if (updatedRecord.memoryOrigin === undefined) {
        updatedRecord = { ...updatedRecord, memoryOrigin: 'LEGACY' };
        needsWrite = true;
      }

      if (needsWrite) {
        this.fileStore.writeOrThrow(updatedRecord.id, updatedRecord);
      }
      this.memoryStore.set(updatedRecord.id, updatedRecord);
    }

    for (const setting of this.settingsFileStore.readAll()) {
      this.settingsMap.set(setting.id, setting);
    }
  }

  private requireOwned(id: string, tenantId: string, ownerId: string): MemoryRecord {
    const record = this.memoryStore.get(id);
    if (!record || record.tenantId !== tenantId || record.owner_id !== ownerId) {
      throw new NagexError({
        code: 'MEMORY_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Memory ID ${id} not found.`,
        request_id: 'mem_req',
      });
    }
    return record;
  }

  public getSettings(tenantId: string, ownerId: string): MemoryUserSettingsRecord {
    const key = `${tenantId}:${ownerId}`;
    const existing = this.settingsMap.get(key);
    if (existing) return existing;

    const now = getCurrentISOString();
    return {
      id: key,
      tenantId,
      ownerId,
      memoryCaptureEnabled: true,
      memoryUseEnabled: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  public updateSettings(tenantId: string, ownerId: string, updates: Partial<MemoryUserSettings>): MemoryUserSettingsRecord {
    const current = this.getSettings(tenantId, ownerId);
    const now = getCurrentISOString();

    const updated: MemoryUserSettingsRecord = {
      id: current.id,
      tenantId,
      ownerId,
      memoryCaptureEnabled: updates.memoryCaptureEnabled !== undefined ? updates.memoryCaptureEnabled : current.memoryCaptureEnabled,
      memoryUseEnabled: updates.memoryUseEnabled !== undefined ? updates.memoryUseEnabled : current.memoryUseEnabled,
      createdAt: current.createdAt || now,
      updatedAt: now,
    };

    this.settingsFileStore.writeOrThrow(updated.id, updated);
    this.settingsMap.set(updated.id, updated);
    return updated;
  }

  public findMatchingMemory(
    tenantId: string,
    ownerId: string,
    type: MemoryType | undefined,
    subject: string,
    predicate: string
  ): MemoryRecord | undefined {
    const normSubj = subject.toLowerCase().trim();
    const normPred = predicate.toLowerCase().trim();

    for (const record of this.memoryStore.values()) {
      if (
        record.tenantId === tenantId &&
        record.owner_id === ownerId &&
        record.lifecycle === 'ACTIVE' &&
        (!type || record.type === type)
      ) {
        const rSubj = record.content.subject.toLowerCase().trim();
        const rPred = record.content.predicate.toLowerCase().trim();
        if (rSubj === normSubj && rPred === normPred) {
          return record;
        }
      }
    }
    return undefined;
  }

  public proposeMemory(
    scope: MemoryScope,
    tenantId: string,
    ownerId: string,
    content: { subject: string; predicate: string; value: unknown },
    candidateId?: string,
    options?: {
      type?: MemoryType;
      sourceRef?: string;
      confidence?: number;
      workspaceId?: string;
      sensitivity?: SensitivityLevel;
      provenance?: MemoryProvenance;
      memoryOrigin?: MemoryOrigin;
      userConfirmed?: boolean;
      contextRefs?: MemoryContextRefs;
    },
  ): MemoryRecord {
    const sensitivity = resolveEffectiveSensitivity(content, options?.sensitivity);
    if (sensitivity === 'S3') {
      throw new NagexError({
        code: 'SECRET_MEMORY_REJECTED',
        category: 'POLICY',
        message: 'Secret context (S3) must not be persisted as durable memory.',
        request_id: 'mem_req',
      });
    }

    const existingActive = this.findMatchingMemory(tenantId, ownerId, options?.type, content.subject, content.predicate);
    if (existingActive) {
      const existingValStr = JSON.stringify(existingActive.content.value);
      const newValStr = JSON.stringify(content.value);
      if (existingValStr === newValStr) {
        const now = getCurrentISOString();
        const refreshed: MemoryRecord = {
          ...existingActive,
          updated_at: now,
          last_used_at: now,
        };
        this.fileStore.writeOrThrow(existingActive.id, refreshed);
        this.memoryStore.set(existingActive.id, refreshed);
        return refreshed;
      }
    }

    const id = generateResourceId('mem');
    const now = getCurrentISOString();

    const isS2 = sensitivity === 'S2';
    const lifecycle: MemoryLifecycle = isS2 ? 'PROPOSED' : (existingActive ? 'CONFLICTED' : (options?.userConfirmed ? 'ACTIVE' : 'PROPOSED'));
    const userConfirmed = isS2 ? false : (options?.userConfirmed ?? (lifecycle === 'ACTIVE'));
    const memoryOrigin = options?.memoryOrigin || (options?.userConfirmed ? 'EXPLICIT_USER' : 'SUGGESTED');

    const provenance: MemoryProvenance = options?.provenance || {
      sourceType: options?.sourceRef ? 'SYSTEM' : 'MANUAL',
      extractedAt: now,
      extractor: 'MANUAL',
    };

    const record: MemoryRecord = {
      id,
      scope,
      type: options?.type,
      tenantId,
      owner_id: ownerId,
      workspaceId: options?.workspaceId,
      lifecycle,
      content,
      sourceRef: options?.sourceRef || provenance.sourceRef,
      confidence: options?.confidence ?? provenance.confidence,
      candidateId,
      sensitivity,
      provenance,
      memoryOrigin,
      userConfirmed,
      contextRefs: options?.contextRefs,
      created_at: now,
      updated_at: now,
    };

    this.fileStore.writeOrThrow(id, record);
    this.memoryStore.set(id, record);
    return record;
  }

  public findByCandidateId(candidateId: string): MemoryRecord | undefined {
    for (const record of this.memoryStore.values()) {
      if (record.candidateId === candidateId) return record;
    }
    return undefined;
  }

  public findSeedMemory(criteria: {
    scope: MemoryScope;
    tenantId: string;
    ownerId: string;
    subject: string;
    predicate: string;
  }): MemoryRecord | undefined {
    for (const record of this.memoryStore.values()) {
      if (
        record.scope === criteria.scope &&
        record.tenantId === criteria.tenantId &&
        record.owner_id === criteria.ownerId &&
        record.content.subject === criteria.subject &&
        record.content.predicate === criteria.predicate &&
        !TERMINAL_MEMORY_STATES.has(record.lifecycle)
      ) {
        return record;
      }
    }
    return undefined;
  }

  public activateMemory(id: string, tenantId: string, ownerId: string): MemoryRecord {
    const record = this.requireOwned(id, tenantId, ownerId);

    if (TERMINAL_MEMORY_STATES.has(record.lifecycle)) {
      throw new NagexError({
        code: 'MEMORY_ALREADY_TERMINAL',
        category: 'CONFLICT',
        message: `Memory ID ${id} is in terminal state ${record.lifecycle} and cannot be reactivated.`,
        request_id: 'mem_req',
      });
    }

    if (record.sensitivity === 'S2') {
      throw new NagexError({
        code: 'S2_CONFIRMATION_REQUIRED',
        category: 'POLICY',
        message: `Sensitive memory ID ${id} (S2) requires explicit user confirmation via confirm endpoint.`,
        request_id: 'mem_req',
      });
    }

    const now = getCurrentISOString();
    const updatedRecord: MemoryRecord = {
      ...record,
      lifecycle: 'ACTIVE',
      userConfirmed: true,
      updated_at: now,
    };

    this.fileStore.writeOrThrow(id, updatedRecord);
    this.memoryStore.set(id, updatedRecord);
    return updatedRecord;
  }

  /**
   * Patches seed-only metadata fields (type, memoryOrigin, provenance) on an
   * existing record. Scoped to the owning tenant/owner — does not touch
   * content, lifecycle, sensitivity, or userConfirmed. Intended exclusively
   * for ensureSeedMemory to migrate legacy seed records to the canonical
   * contract values on startup.
   */
  public patchSeedRecord(
    id: string,
    tenantId: string,
    ownerId: string,
    patch: {
      type?: MemoryType;
      memoryOrigin?: MemoryOrigin;
      provenance?: MemoryProvenance;
    },
  ): MemoryRecord {
    const record = this.requireOwned(id, tenantId, ownerId);
    const now = getCurrentISOString();
    const updated: MemoryRecord = {
      ...record,
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.memoryOrigin !== undefined ? { memoryOrigin: patch.memoryOrigin } : {}),
      ...(patch.provenance !== undefined ? { provenance: patch.provenance } : {}),
      updated_at: now,
    };
    this.fileStore.writeOrThrow(id, updated);
    this.memoryStore.set(id, updated);
    return updated;
  }

  public confirmMemory(id: string, tenantId: string, ownerId: string): MemoryRecord {
    const record = this.requireOwned(id, tenantId, ownerId);

    if (record.lifecycle === 'ACTIVE') {
      const now = getCurrentISOString();
      const updated: MemoryRecord = { ...record, userConfirmed: true, updated_at: now };
      this.fileStore.writeOrThrow(id, updated);
      this.memoryStore.set(id, updated);
      return updated;
    }

    if (record.lifecycle !== 'PROPOSED') {
      throw new NagexError({
        code: 'MEMORY_INVALID_REACTIVATION',
        category: 'CONFLICT',
        message: `Memory ID ${id} is in lifecycle state ${record.lifecycle} and cannot be reactivated or confirmed.`,
        request_id: 'mem_req',
      });
    }

    const now = getCurrentISOString();
    const confirmedRecord: MemoryRecord = {
      ...record,
      lifecycle: 'ACTIVE',
      userConfirmed: true,
      updated_at: now,
    };

    this.fileStore.writeOrThrow(id, confirmedRecord);
    this.memoryStore.set(id, confirmedRecord);
    return confirmedRecord;
  }

  public rejectMemory(id: string, tenantId: string, ownerId: string): MemoryRecord {
    const record = this.requireOwned(id, tenantId, ownerId);
    const now = getCurrentISOString();

    const rejectedRecord: MemoryRecord = {
      ...record,
      lifecycle: 'DELETED',
      updated_at: now,
    };

    this.fileStore.removeOrThrow(id);
    this.memoryStore.delete(id);
    return rejectedRecord;
  }

  public getActiveMemories(scope: MemoryScope, tenantId: string, ownerId: string): MemoryRecord[] {
    const active: MemoryRecord[] = [];
    for (const record of this.memoryStore.values()) {
      if (record.scope === scope && record.tenantId === tenantId && record.owner_id === ownerId && record.lifecycle === 'ACTIVE') {
        active.push(record);
      }
    }
    return active;
  }

  public getProposedCandidates(tenantId: string, ownerId: string): MemoryRecord[] {
    const proposed: MemoryRecord[] = [];
    for (const record of this.memoryStore.values()) {
      if (record.tenantId === tenantId && record.owner_id === ownerId && record.lifecycle === 'PROPOSED') {
        proposed.push(record);
      }
    }
    return proposed.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  public get(id: string, tenantId: string, ownerId: string): MemoryRecord | undefined {
    const record = this.memoryStore.get(id);
    if (!record || record.tenantId !== tenantId || record.owner_id !== ownerId) return undefined;
    return record;
  }

  public deleteMemory(id: string, tenantId: string, ownerId: string): MemoryRecord {
    const record = this.requireOwned(id, tenantId, ownerId);
    const deletedRecord: MemoryRecord = {
      ...record,
      lifecycle: 'DELETED',
      updated_at: getCurrentISOString(),
    };
    this.fileStore.removeOrThrow(id);
    this.memoryStore.delete(id);
    return deletedRecord;
  }

  public createMemory(params: {
    scope: MemoryScope;
    type?: MemoryType;
    tenantId: string;
    ownerId: string;
    workspaceId?: string;
    content: { subject: string; predicate: string; value: unknown };
    sourceRef?: string;
    confidence?: number;
    candidateId?: string;
    sensitivity?: SensitivityLevel;
    provenance?: MemoryProvenance;
    memoryOrigin?: MemoryOrigin;
    userConfirmed?: boolean;
    contextRefs?: MemoryContextRefs;
  }): MemoryRecord {
    const sensitivity = resolveEffectiveSensitivity(params.content, params.sensitivity);
    if (sensitivity === 'S3') {
      throw new NagexError({
        code: 'SECRET_MEMORY_REJECTED',
        category: 'POLICY',
        message: 'Secret context (S3) must not be persisted as durable memory.',
        request_id: 'mem_req',
      });
    }

    const existingActive = this.findMatchingMemory(params.tenantId, params.ownerId, params.type, params.content.subject, params.content.predicate);
    if (existingActive) {
      const existingValStr = JSON.stringify(existingActive.content.value);
      const newValStr = JSON.stringify(params.content.value);
      if (existingValStr === newValStr) {
        const now = getCurrentISOString();
        const refreshed: MemoryRecord = {
          ...existingActive,
          updated_at: now,
          last_used_at: now,
        };
        this.fileStore.writeOrThrow(existingActive.id, refreshed);
        this.memoryStore.set(existingActive.id, refreshed);
        return refreshed;
      }
    }

    const id = generateResourceId('mem');
    const now = getCurrentISOString();

    const isS2 = sensitivity === 'S2';
    const lifecycle: MemoryLifecycle = isS2 ? 'PROPOSED' : (existingActive ? 'CONFLICTED' : (params.userConfirmed !== false ? 'ACTIVE' : 'PROPOSED'));
    const userConfirmed = isS2 ? false : (params.userConfirmed ?? (lifecycle === 'ACTIVE'));
    const memoryOrigin = params.memoryOrigin || (userConfirmed ? 'EXPLICIT_USER' : 'SUGGESTED');

    const provenance: MemoryProvenance = params.provenance || {
      sourceType: params.sourceRef ? 'SYSTEM' : 'MANUAL',
      extractedAt: now,
      extractor: 'MANUAL',
    };

    const record: MemoryRecord = {
      id,
      scope: params.scope,
      type: params.type || 'FACT',
      tenantId: params.tenantId,
      owner_id: params.ownerId,
      workspaceId: params.workspaceId || 'ws_default_01',
      lifecycle,
      content: params.content,
      sourceRef: params.sourceRef || provenance.sourceRef,
      confidence: params.confidence ?? provenance.confidence ?? 1.0,
      candidateId: params.candidateId,
      sensitivity,
      provenance,
      memoryOrigin,
      userConfirmed,
      contextRefs: params.contextRefs,
      created_at: now,
      updated_at: now,
      last_used_at: now,
    };

    this.fileStore.writeOrThrow(id, record);
    this.memoryStore.set(id, record);
    return record;
  }

  public updateMemory(
    id: string,
    tenantId: string,
    ownerId: string,
    updates: Partial<{
      scope: MemoryScope;
      type: MemoryType;
      content: { subject: string; predicate: string; value: unknown };
      sourceRef: string;
      confidence: number;
      sensitivity: SensitivityLevel;
      userConfirmed: boolean;
    }>
  ): MemoryRecord {
    const record = this.requireOwned(id, tenantId, ownerId);
    const newContent = updates.content || record.content;
    const effectiveSensitivity = resolveEffectiveSensitivity(newContent, updates.sensitivity || record.sensitivity);

    if (effectiveSensitivity === 'S3') {
      throw new NagexError({
        code: 'SECRET_MEMORY_REJECTED',
        category: 'POLICY',
        message: 'Secret context (S3) must not be persisted as durable memory.',
        request_id: 'mem_req',
      });
    }

    const now = getCurrentISOString();
    let lifecycle = record.lifecycle;
    let userConfirmed = updates.userConfirmed !== undefined ? updates.userConfirmed : record.userConfirmed;

    // PATCH sensitivity reclassification rule: If content becomes S2 and was ACTIVE, demote to PROPOSED
    if (effectiveSensitivity === 'S2' && record.lifecycle === 'ACTIVE') {
      lifecycle = 'PROPOSED';
      userConfirmed = false;
    }

    // Only overlay fields the caller actually supplied — spreading `updates`
    // wholesale would overwrite record.scope/type/sourceRef with `undefined`
    // whenever a caller (e.g. the PATCH route) passes those keys unset, which
    // silently drops the record from GET /api/v1/memory (scope-filtered) and
    // from the UI's type label.
    const updated: MemoryRecord = {
      ...record,
      ...(updates.scope !== undefined ? { scope: updates.scope } : {}),
      ...(updates.type !== undefined ? { type: updates.type } : {}),
      ...(updates.content !== undefined ? { content: updates.content } : {}),
      ...(updates.sourceRef !== undefined ? { sourceRef: updates.sourceRef } : {}),
      ...(updates.confidence !== undefined ? { confidence: updates.confidence } : {}),
      sensitivity: effectiveSensitivity,
      lifecycle,
      userConfirmed,
      updated_at: now,
    };

    this.fileStore.writeOrThrow(id, updated);
    this.memoryStore.set(id, updated);
    return updated;
  }

  public listMemories(tenantId: string, ownerId: string, scope?: MemoryScope, workspaceId?: string): MemoryRecord[] {
    const results: MemoryRecord[] = [];
    for (const record of this.memoryStore.values()) {
      if (record.tenantId === tenantId && record.owner_id === ownerId && !TERMINAL_MEMORY_STATES.has(record.lifecycle)) {
        if (!scope || record.scope === scope) {
          if (!workspaceId || record.workspaceId === workspaceId || record.scope === 'PERSONAL' || record.scope === 'USER') {
            results.push(record);
          }
        }
      }
    }
    return results.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  public searchMemories(tenantId: string, ownerId: string, query: string, scope?: MemoryScope, workspaceId?: string): MemoryRecord[] {
    const q = query.toLowerCase().trim();
    const list = this.listMemories(tenantId, ownerId, scope, workspaceId);
    if (!q) return list;

    return list.filter((r) => {
      const subj = (r.content?.subject || '').toLowerCase();
      const pred = (r.content?.predicate || '').toLowerCase();
      const val = typeof r.content?.value === 'string' ? r.content.value.toLowerCase() : JSON.stringify(r.content?.value || '').toLowerCase();
      const src = (r.sourceRef || '').toLowerCase();
      const type = (r.type || '').toLowerCase();
      return subj.includes(q) || pred.includes(q) || val.includes(q) || src.includes(q) || type.includes(q);
    });
  }
}


