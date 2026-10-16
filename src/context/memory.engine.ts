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
  // Additive (history of a corrected fact). A person's explicit correction makes the new memory ACTIVE and the replaced one SUPERSEDED - kept, linked both ways, provenance intact, restorable.
  supersedes?: string;
  supersededBy?: string;
  supersededAt?: string;
  // Additive (explicitly time-bound context: "금요일까지 부산 출장 중"). After this instant the memory is EXPIRED: kept, visible in the person's history, never recalled as current.
  expiresAt?: string;
  expiredAt?: string;
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
  /** the clock expiry is judged by (tests) */
  now?: () => number;
}

/** One memory as the person's history view shows it. */
export interface MemoryHistoryVersion {
  id: string;
  value: string;
  lifecycle: MemoryLifecycle;
  /** the version that is current now */
  current: boolean;
  sensitivity: SensitivityLevel;
  origin: MemoryOrigin | undefined;
  sourceType: MemorySourceType | undefined;
  extractor: MemoryProvenance['extractor'] | undefined;
  createdAt: string;
  supersededAt?: string;
  expiresAt?: string;
  expiredAt?: string;
}

export interface MemoryHistoryGroup {
  subject: string;
  predicate: string;
  /** oldest first; the current version (if any) is flagged */
  versions: MemoryHistoryVersion[];
}

export class MemoryEngine {
  private readonly fileStore: FileRecordStore<MemoryRecord>;
  private readonly memoryStore: Map<string, MemoryRecord> = new Map();
  private readonly settingsFileStore: FileRecordStore<MemoryUserSettingsRecord>;
  private readonly settingsMap: Map<string, MemoryUserSettingsRecord> = new Map();
  private readonly now: () => number;

  constructor(options?: MemoryEngineOptions) {
    this.now = options?.now ?? Date.now;
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
    this.expireDue(tenantId, ownerId);
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
      // One statement among many under a shared label ("User Preference / preference"): only an IDENTICAL statement is "the same memory"; a different one is a different memory, never a conflict.
      distinctFact?: boolean;
      // The id of an ACTIVE memory of this person that this CONFIRMED statement replaces. Honoured only for a confirmed, non-sensitive (not S2) memory; the replaced one is kept as history.
      supersedes?: string;
      // When the statement is explicitly time-bound ("금요일까지"): the instant after which it is no longer current.
      expiresAt?: string;
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

    const existingActive = options?.distinctFact
      ? this.findExactDuplicate(tenantId, ownerId, content)
      : this.findMatchingMemory(tenantId, ownerId, options?.type, content.subject, content.predicate);
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
      ...(options?.expiresAt && Number.isFinite(Date.parse(options.expiresAt)) ? { expiresAt: new Date(Date.parse(options.expiresAt)).toISOString() } : {}),
      created_at: now,
      updated_at: now,
    };

    // A person's own, confirmed correction replaces the memory it names. The target must be this person's and ACTIVE; anything else is refused, never silently skipped.
    let replaced: MemoryRecord | undefined;
    if (options?.supersedes && lifecycle === 'ACTIVE' && userConfirmed) {
      replaced = this.requireOwned(options.supersedes, tenantId, ownerId);
      if (replaced.lifecycle !== 'ACTIVE') {
        throw new NagexError({ code: 'MEMORY_SUPERSEDE_TARGET_NOT_ACTIVE', category: 'CONFLICT', message: `Memory ID ${replaced.id} is ${replaced.lifecycle} and cannot be superseded.`, request_id: 'mem_req' });
      }
      record.supersedes = replaced.id;
    }

    // the successor first: if anything fails in between, both stay ACTIVE (a duplicate, never a loss)
    this.fileStore.writeOrThrow(id, record);
    this.memoryStore.set(id, record);
    if (replaced) {
      const retired: MemoryRecord = { ...replaced, lifecycle: 'SUPERSEDED', supersededBy: id, supersededAt: now, updated_at: now };
      this.fileStore.writeOrThrow(replaced.id, retired);
      this.memoryStore.set(replaced.id, retired);
    }
    return record;
  }

  private findExactDuplicate(tenantId: string, ownerId: string, content: { subject: string; predicate: string; value: unknown }): MemoryRecord | undefined {
    const value = JSON.stringify(content.value);
    for (const record of this.memoryStore.values()) {
      if (record.tenantId === tenantId && record.owner_id === ownerId && record.lifecycle === 'ACTIVE'
        && record.content.subject.toLowerCase().trim() === content.subject.toLowerCase().trim()
        && record.content.predicate.toLowerCase().trim() === content.predicate.toLowerCase().trim()
        && JSON.stringify(record.content.value) === value) return record;
    }
    return undefined;
  }

  /** The person changes their mind back: the replaced memory is ACTIVE again and its successor becomes the history. Only the owner, only a memory that was superseded. */
  public restoreSuperseded(id: string, tenantId: string, ownerId: string): MemoryRecord {
    const record = this.requireOwned(id, tenantId, ownerId);
    if (record.lifecycle !== 'SUPERSEDED') {
      throw new NagexError({ code: 'MEMORY_NOT_SUPERSEDED', category: 'CONFLICT', message: `Memory ID ${id} was not superseded.`, request_id: 'mem_req' });
    }
    const now = getCurrentISOString();
    const successor = record.supersededBy ? this.memoryStore.get(record.supersededBy) : undefined;
    if (successor && successor.tenantId === tenantId && successor.owner_id === ownerId && successor.lifecycle === 'ACTIVE') {
      const retired: MemoryRecord = { ...successor, lifecycle: 'SUPERSEDED', supersededBy: record.id, supersededAt: now, updated_at: now };
      this.fileStore.writeOrThrow(successor.id, retired);
      this.memoryStore.set(successor.id, retired);
    }
    const { supersededBy: _by, supersededAt: _at, ...rest } = record;
    const restored: MemoryRecord = { ...rest, lifecycle: 'ACTIVE', updated_at: now };
    this.fileStore.writeOrThrow(restored.id, restored);
    this.memoryStore.set(restored.id, restored);
    return restored;
  }

  // ---- time-bound context, correction and history (R26-C) ---------------------------------------------------------------------------------------------------

  /** Memories whose explicit end has passed become EXPIRED - kept, never deleted, never current. Only this person's records are touched. */
  public expireDue(tenantId: string, ownerId: string): number {
    const nowMs = this.now();
    let expired = 0;
    for (const record of this.memoryStore.values()) {
      if (record.tenantId !== tenantId || record.owner_id !== ownerId || !record.expiresAt) continue;
      if (record.lifecycle !== 'ACTIVE' && record.lifecycle !== 'PROPOSED') continue;
      if (Date.parse(record.expiresAt) > nowMs) continue;
      const at = new Date(nowMs).toISOString();
      const next: MemoryRecord = { ...record, lifecycle: 'EXPIRED', expiredAt: at, updated_at: at };
      this.fileStore.writeOrThrow(record.id, next);
      this.memoryStore.set(record.id, next);
      expired += 1;
    }
    return expired;
  }

  /**
   * The person corrects a memory of their own ("오래된 내용을 수정"): the new text becomes the current memory and the old one is kept, linked both ways, as history that can be restored. Never an overwrite.
   * The person's own typing is the confirmation; a secret (S3) is still refused; the sensitivity never drops; provenance records that this was a correction by the owner.
   */
  public correctMemory(id: string, tenantId: string, ownerId: string, input: { value: string; expiresAt?: string | null }): { current: MemoryRecord; previous: MemoryRecord } {
    const previous = this.requireOwned(id, tenantId, ownerId);
    if (previous.lifecycle !== 'ACTIVE') {
      throw new NagexError({ code: 'MEMORY_NOT_ACTIVE', category: 'CONFLICT', message: `Memory ID ${id} is ${previous.lifecycle} and cannot be corrected.`, request_id: 'mem_req' });
    }
    const value = typeof input.value === 'string' ? input.value.replace(/\s+/g, ' ').trim() : '';
    if (!value || value.length > 2000) {
      throw new NagexError({ code: 'MEMORY_VALUE_INVALID', category: 'VALIDATION', message: 'A memory needs 1 to 2000 characters.', request_id: 'mem_req' });
    }
    if (typeof previous.content.value === 'string' && previous.content.value.replace(/\s+/g, ' ').trim() === value) {
      throw new NagexError({ code: 'MEMORY_UNCHANGED', category: 'CONFLICT', message: 'The correction is the same as the memory.', request_id: 'mem_req' });
    }
    const content = { subject: previous.content.subject, predicate: previous.content.predicate, value };
    const sensitivity = resolveEffectiveSensitivity(content, previous.sensitivity);
    if (sensitivity === 'S3') {
      throw new NagexError({ code: 'SECRET_MEMORY_REJECTED', category: 'POLICY', message: 'Secret context (S3) must not be persisted as durable memory.', request_id: 'mem_req' });
    }
    let expiresAt: string | undefined;
    if (input.expiresAt) {
      const ms = Date.parse(input.expiresAt);
      const nowMs = this.now();
      if (!Number.isFinite(ms) || ms <= nowMs || ms > nowMs + 5 * 365 * 24 * 3600_000) {
        throw new NagexError({ code: 'MEMORY_EXPIRY_INVALID', category: 'VALIDATION', message: 'The end date must be in the future (within five years).', request_id: 'mem_req' });
      }
      expiresAt = new Date(ms).toISOString();
    }
    const nowIso = new Date(this.now()).toISOString();
    const current: MemoryRecord = {
      id: generateResourceId('mem'),
      scope: previous.scope,
      ...(previous.type ? { type: previous.type } : {}),
      tenantId,
      owner_id: ownerId,
      ...(previous.workspaceId ? { workspaceId: previous.workspaceId } : {}),
      lifecycle: 'ACTIVE',
      content,
      confidence: 1,
      sensitivity,
      provenance: { sourceType: 'MANUAL', sourceRef: `correction_of:${previous.id}`, extractedAt: nowIso, extractor: 'USER_EXPLICIT', originalAvailable: true },
      sourceRef: `correction_of:${previous.id}`,
      memoryOrigin: 'EXPLICIT_USER',
      userConfirmed: true,
      ...(previous.contextRefs ? { contextRefs: previous.contextRefs } : {}),
      ...(previous.pinned ? { pinned: previous.pinned } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      supersedes: previous.id,
      created_at: nowIso,
      updated_at: nowIso,
    };
    // the successor first: if anything fails in between, both stay ACTIVE (a duplicate, never a loss)
    this.fileStore.writeOrThrow(current.id, current);
    this.memoryStore.set(current.id, current);
    const retired: MemoryRecord = { ...previous, lifecycle: 'SUPERSEDED', supersededBy: current.id, supersededAt: nowIso, updated_at: nowIso };
    this.fileStore.writeOrThrow(previous.id, retired);
    this.memoryStore.set(previous.id, retired);
    return { current, previous: retired };
  }

  /** An expired memory the person still wants: it is current again, with a new end date or none. Only the owner, only an EXPIRED memory. */
  public renewExpired(id: string, tenantId: string, ownerId: string, expiresAt?: string | null): MemoryRecord {
    const record = this.requireOwned(id, tenantId, ownerId);
    if (record.lifecycle !== 'EXPIRED') {
      throw new NagexError({ code: 'MEMORY_NOT_EXPIRED', category: 'CONFLICT', message: `Memory ID ${id} is not expired.`, request_id: 'mem_req' });
    }
    let next: string | undefined;
    if (expiresAt) {
      const ms = Date.parse(expiresAt);
      const nowMs = this.now();
      if (!Number.isFinite(ms) || ms <= nowMs || ms > nowMs + 5 * 365 * 24 * 3600_000) {
        throw new NagexError({ code: 'MEMORY_EXPIRY_INVALID', category: 'VALIDATION', message: 'The end date must be in the future (within five years).', request_id: 'mem_req' });
      }
      next = new Date(ms).toISOString();
    }
    const { expiresAt: _e, expiredAt: _x, ...rest } = record;
    const renewed: MemoryRecord = { ...rest, lifecycle: 'ACTIVE', ...(next ? { expiresAt: next } : {}), updated_at: new Date(this.now()).toISOString() };
    this.fileStore.writeOrThrow(renewed.id, renewed);
    this.memoryStore.set(renewed.id, renewed);
    return renewed;
  }

  private toHistoryVersion(record: MemoryRecord): MemoryHistoryVersion {
    const value = typeof record.content.value === 'string' ? record.content.value : JSON.stringify(record.content.value ?? '');
    return {
      id: record.id,
      value,
      lifecycle: record.lifecycle,
      current: record.lifecycle === 'ACTIVE',
      sensitivity: record.sensitivity ?? 'S1',
      origin: record.memoryOrigin,
      sourceType: record.provenance?.sourceType,
      extractor: record.provenance?.extractor,
      createdAt: record.created_at,
      ...(record.supersededAt ? { supersededAt: record.supersededAt } : {}),
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      ...(record.expiredAt ? { expiredAt: record.expiredAt } : {}),
    };
  }

  /**
   * What the person sees under "history": every corrected fact with its versions (oldest first, the current one flagged) and every memory that expired. Only this person's own records; never another
   * person's, never a deleted one.
   */
  public history(tenantId: string, ownerId: string): { groups: MemoryHistoryGroup[]; expired: MemoryHistoryVersion[] } {
    this.expireDue(tenantId, ownerId);
    const mine = [...this.memoryStore.values()].filter((r) => r.tenantId === tenantId && r.owner_id === ownerId && r.lifecycle !== 'DELETED');
    const done = new Set<string>();
    const groups: MemoryHistoryGroup[] = [];
    for (const record of mine) {
      if (done.has(record.id) || (!record.supersedes && !record.supersededBy)) continue;
      const chain = this.getSupersessionChain(record.id, tenantId, ownerId).filter((r) => r.lifecycle !== 'DELETED');
      for (const member of chain) done.add(member.id);
      if (chain.length < 2) continue;
      const newest = chain[chain.length - 1];
      groups.push({ subject: newest.content.subject, predicate: newest.content.predicate, versions: chain.map((r) => this.toHistoryVersion(r)) });
    }
    groups.sort((a, b) => Date.parse(b.versions[b.versions.length - 1].createdAt) - Date.parse(a.versions[a.versions.length - 1].createdAt));
    const expired = mine.filter((r) => r.lifecycle === 'EXPIRED').sort((a, b) => Date.parse(b.expiredAt ?? b.updated_at) - Date.parse(a.expiredAt ?? a.updated_at)).map((r) => this.toHistoryVersion(r));
    return { groups, expired };
  }

  /** The history of a corrected fact, oldest first: every memory linked to this one by supersession (this person's own records only). */
  public getSupersessionChain(id: string, tenantId: string, ownerId: string): MemoryRecord[] {
    const start = this.requireOwned(id, tenantId, ownerId);
    const seen = new Set<string>([start.id]);
    const chain: MemoryRecord[] = [start];
    for (let cursor = start; cursor.supersedes;) {
      const previous = this.memoryStore.get(cursor.supersedes);
      if (!previous || previous.tenantId !== tenantId || previous.owner_id !== ownerId || seen.has(previous.id)) break;
      seen.add(previous.id);
      chain.unshift(previous);
      cursor = previous;
    }
    // forward: the forward link (supersededBy) is cleared when a memory is restored, so the successor is also found by its own backward link (supersedes) - the history of a restored memory stays reachable
    for (let cursor: MemoryRecord | undefined = start; cursor;) {
      const current: MemoryRecord = cursor;
      const next: MemoryRecord | undefined = (current.supersededBy ? this.memoryStore.get(current.supersededBy) : undefined)
        ?? [...this.memoryStore.values()].find((r) => r.supersedes === current.id && r.tenantId === tenantId && r.owner_id === ownerId);
      if (!next || next.tenantId !== tenantId || next.owner_id !== ownerId || seen.has(next.id)) break;
      seen.add(next.id);
      chain.push(next);
      cursor = next;
    }
    return chain;
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
    this.expireDue(tenantId, ownerId);
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
    // an explicit end ("until Friday"): after it the memory is EXPIRED, kept but never current
    expiresAt?: string;
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
      ...(params.expiresAt && Number.isFinite(Date.parse(params.expiresAt)) ? { expiresAt: new Date(Date.parse(params.expiresAt)).toISOString() } : {}),
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
    this.expireDue(tenantId, ownerId);
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


