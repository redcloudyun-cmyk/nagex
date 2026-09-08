import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { CaptureStore } from './capture.store.js';
import type {
  CaptureItem,
  CaptureStatus,
  CaptureType,
  InboxSummary,
  PersonalVaultSummary,
} from './workspace.types.js';
import type { TaskStore } from '../tasks/task.store.js';
import type { MemoryEngine } from '../context/memory.engine.js';
import type { KnowledgeEngine } from '../context/knowledge.engine.js';
import type { AiService } from '../model-gateway/ai-service.js';
import type { BrowserToolService } from '../tools/browser.service.js';
import type { AuditLogger } from '../governance/audit.logger.js';
import type { ActionApprovalStore } from '../governance/action-approval.store.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { LocalStorageProvider } from '../storage/local-storage.provider.js';
import { WorkspaceQuotaEngine } from './quota-engine.js';
import { CaptureProcessor } from './capture-processor.js';
import type { CandidateStore } from './candidate.store.js';
import type { CandidateRecord, CandidateStatus, CandidateType } from './candidate.types.js';
import type { CandidateActionResolver } from './action-resolver.js';
import type { ActivityStore } from '../governance/activity.store.js';
import { classifyFailure } from '../common/failure-taxonomy.js';
import {
  generateCanonicalObjectKey,
  sanitizeFilename,
  scanObjectForMalware,
  validateFileSize,
  validateMimeAndExtension,
} from './vault-security.js';
import { generateResourceId } from '../common/utils.js';

// Matches getVaultSummary()'s category grouping (Files/Links/Audio/Notes) so
// a capture's vaultPath always points into the same category folder it is
// aggregated under in the Vault view.
function vaultFolderFor(type: CaptureType): string {
  if (type === 'FILE') return 'files';
  if (type === 'LINK') return 'links';
  if (type === 'AUDIO') return 'audio';
  return 'notes';
}

export interface PresignedUploadInitResult {
  uploadId: string;
  captureId: string;
  objectKey: string;
  uploadUrl: string;
  expiresAt: string;
  maxSizeBytes: number;
}

export class QuickCaptureService {
  private readonly quotaEngine: WorkspaceQuotaEngine;
  private readonly processor: CaptureProcessor;

  constructor(
    private readonly store: CaptureStore,
    private readonly storageProvider: StorageProvider = new LocalStorageProvider(),
    private readonly taskStore?: TaskStore,
    private readonly memoryEngine?: MemoryEngine,
    private readonly knowledgeEngine?: KnowledgeEngine,
    private readonly aiService?: AiService,
    private readonly browserService?: BrowserToolService,
    private readonly auditLogger?: AuditLogger,
    private readonly actionApprovals?: ActionApprovalStore,
    // Phase 1 STEP 5 — Canonical Candidate Model. Optional and appended last
    // so every existing positional call site (tests included) keeps working
    // unchanged.
    private readonly candidateStore?: CandidateStore,
    // Phase 1 STEP 7 — Real Actions. Pre-built by the caller (server_web.ts)
    // since it needs collaborators (GoogleCalendarService, ExecutionStore)
    // QuickCaptureService itself has no other reason to depend on.
    private readonly actionResolver?: CandidateActionResolver,
    // Phase 1 STEP 8 — durable, tenant-isolated consumer Activity projection.
    private readonly activityStore?: ActivityStore,
  ) {
    this.quotaEngine = new WorkspaceQuotaEngine();
    this.processor = new CaptureProcessor(
      this.store,
      this.aiService,
      this.browserService,
      this.auditLogger,
      this.storageProvider,
      this.knowledgeEngine,
      this.candidateStore,
      this.activityStore,
    );
  }

  public getStorageProvider(): StorageProvider {
    return this.storageProvider;
  }

  public getQuotaEngine(): WorkspaceQuotaEngine {
    return this.quotaEngine;
  }

  /**
   * Presigned Upload Init Flow (Phase 2 Upload Architecture)
   */
  public async initUpload(params: {
    ownerId: string;
    tenantId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    intent?: CaptureType;
  }): Promise<PresignedUploadInitResult> {
    const cleanFilename = sanitizeFilename(params.filename);
    const category = params.intent || (params.mimeType.startsWith('audio/') ? 'AUDIO' : params.mimeType.includes('pdf') ? 'PDF' : 'FILE');

    // 1. Security & Quota Validation
    validateFileSize(params.sizeBytes, category);
    this.quotaEngine.checkQuota(params.ownerId, params.sizeBytes);

    // 2. Generate isolated canonical object key
    const captureId = generateResourceId('cap');
    const objectId = `${Date.now()}_${cleanFilename}`;
    const objectKey = generateCanonicalObjectKey({
      tenantId: params.tenantId,
      principalId: params.ownerId,
      captureId,
      objectId,
    });

    // 3. Obtain signed upload URL
    const expiresInSeconds = 3600;
    const uploadUrl = this.storageProvider.getSignedUploadUrl
      ? await this.storageProvider.getSignedUploadUrl(objectKey, params.mimeType, expiresInSeconds)
      : await this.storageProvider.getSignedUrl(objectKey, expiresInSeconds);

    // 4. Create initial CaptureItem in UPLOADING state
    const initType = (params.mimeType.startsWith('audio/') ? 'AUDIO' : 'FILE') as CaptureType;
    this.store.createCapture({
      ownerId: params.ownerId,
      tenantId: params.tenantId,
      type: initType,
      content: objectKey,
      source: 'WEB',
      metadata: {
        originalName: cleanFilename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        objectKey,
        storageProvider: this.storageProvider.getProviderName(),
      },
      vaultPath: `${vaultFolderFor(initType)}/${objectKey}`,
    });
    this.store.updateStatus(captureId, 'UPLOADING');

    return {
      uploadId: captureId,
      captureId,
      objectKey,
      uploadUrl,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      maxSizeBytes: params.sizeBytes,
    };
  }

  /**
   * Presigned Upload Complete Flow
   */
  public async completeUpload(params: {
    captureId: string;
    ownerId: string;
    tenantId: string;
    objectKey: string;
    mimeType: string;
    checksum: string;
    sizeBytes: number;
    originalFilename: string;
    data?: Buffer | Uint8Array;
  }): Promise<CaptureItem> {
    let buf: Buffer | null = params.data ? Buffer.from(params.data) : null;

    if (!buf) {
      const stored = await this.storageProvider.getObject(params.objectKey);
      if (stored) {
        buf = stored.data;
      }
    }

    if (!buf || buf.length === 0) {
      throw new NagexError({
        code: 'STORAGE_OBJECT_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Object "${params.objectKey}" could not be retrieved from storage.`,
        request_id: `req_chk_${Date.now()}`,
      });
    }

    const actualChecksum = crypto.createHash('sha256').update(buf).digest('hex');
    if (params.checksum && params.checksum.trim() && params.checksum.toLowerCase() !== actualChecksum.toLowerCase()) {
      throw new NagexError({
        code: 'CHECKSUM_MISMATCH',
        category: 'VALIDATION',
        message: `SHA-256 checksum mismatch: declared ${params.checksum}, computed ${actualChecksum}.`,
        request_id: `req_chk_${Date.now()}`,
      });
    }
    validateMimeAndExtension(params.originalFilename, params.mimeType, buf);
    const scan = scanObjectForMalware(buf);
    if (!scan.passed) {
      throw new Error(`SECURITY_MALWARE_DETECTED: ${scan.threat || 'Threat found'}`);
    }
    // If data provided directly, put into storage
    if (params.data) {
      await this.storageProvider.putObject(params.objectKey, buf, params.mimeType);
    }


    let item = this.store.getCapture(params.captureId);
    if (!item) {
      const completeType = (params.mimeType.startsWith('audio/') ? 'AUDIO' : 'FILE') as CaptureType;
      item = this.store.createCapture({
        ownerId: params.ownerId,
        tenantId: params.tenantId,
        type: completeType,
        content: params.objectKey,
        source: 'WEB',
        metadata: {
          originalName: params.originalFilename,
          mimeType: params.mimeType,
          sizeBytes: params.sizeBytes,
          objectKey: params.objectKey,
          storageProvider: this.storageProvider.getProviderName(),
          checksum: actualChecksum,
        },
        vaultPath: `${vaultFolderFor(completeType)}/${params.objectKey}`,
      });
    } else {
      this.store.updateStatus(params.captureId, 'QUEUED', {
        checksum: actualChecksum,
        sizeBytes: params.sizeBytes,
      });
    }

    this.quotaEngine.recordUpload(params.ownerId, params.sizeBytes);

    // Trigger async processing pipeline
    return await this.processor.process(item, buf ?? undefined);
  }

  /**
   * Direct Binary Object Ingestion Fallback / Stream Endpoint
   */
  public async uploadBinaryObject(params: {
    ownerId: string;
    tenantId: string;
    type: CaptureType;
    filename: string;
    mimeType: string;
    data: Buffer | Uint8Array;
    source?: 'WEB' | 'DESKTOP' | 'MOBILE' | 'TELEGRAM' | 'SLACK';
  }): Promise<CaptureItem> {
    const buf = Buffer.from(params.data);
    if (!buf || buf.length === 0) {
      throw new Error('ZERO_BYTE_PAYLOAD: Cannot capture an object with 0 bytes.');
    }

    const cleanFilename = sanitizeFilename(params.filename);
    validateFileSize(buf.length, params.type);
    validateMimeAndExtension(cleanFilename, params.mimeType, buf);
    this.quotaEngine.checkQuota(params.ownerId, buf.length);

    const captureId = generateResourceId('cap');
    const objectId = `${Date.now()}_${cleanFilename}`;
    const objectKey = generateCanonicalObjectKey({
      tenantId: params.tenantId,
      principalId: params.ownerId,
      captureId,
      objectId,
    });

    const objectMeta = await this.storageProvider.putObject(objectKey, buf, params.mimeType);

    const item = this.store.createCapture({
      ownerId: params.ownerId,
      tenantId: params.tenantId,
      type: params.type,
      content: objectKey,
      source: params.source ?? 'WEB',
      metadata: {
        originalName: cleanFilename,
        mimeType: params.mimeType,
        sizeBytes: objectMeta.sizeBytes,
        objectKey: objectMeta.objectKey,
        storageProvider: this.storageProvider.getProviderName(),
        checksum: objectMeta.checksum,
      },
      vaultPath: `${vaultFolderFor(params.type)}/${objectKey}`,
    });

    this.quotaEngine.recordUpload(params.ownerId, objectMeta.sizeBytes);
    return await this.processor.process(item, buf);
  }

  public async captureTextOrLink(params: {
    ownerId: string;
    tenantId: string;
    type: 'TEXT' | 'LINK';
    content: string;
    source?: 'WEB' | 'DESKTOP' | 'MOBILE' | 'TELEGRAM' | 'SLACK';
  }): Promise<CaptureItem> {
    const item = this.store.createCapture({
      ownerId: params.ownerId,
      tenantId: params.tenantId,
      type: params.type,
      content: params.content,
      source: params.source ?? 'WEB',
      metadata: {
        storageProvider: this.storageProvider.getProviderName(),
      },
    });

    return await this.processor.process(item);
  }

  /**
   * Delete Propagation (Phase 7 Requirements)
   * Removes binary object, metadata, derived cache/transcripts, updates quota.
   * Preserves user-approved downstream Tasks/Calendar events.
   */
  public async deleteCaptureItem(captureId: string, ownerId: string): Promise<boolean> {
    const item = this.store.getCapture(captureId);
    if (!item || item.ownerId !== ownerId) return false;

    // 1. Remove binary object from storage provider if exists
    if (item.metadata.objectKey) {
      await this.storageProvider.deleteObject(item.metadata.objectKey);
    }

    // 2. Update Quota Engine
    if (item.metadata.sizeBytes) {
      this.quotaEngine.recordDeletion(ownerId, item.metadata.sizeBytes);
    }

    // 3. Delete Capture record & metadata sidecar
    const deleted = this.store.deleteCapture(captureId);

    // Note: User-approved Tasks, Calendar events, and Memory entries remain intact
    return deleted;
  }

  public async getDownloadUrl(captureId: string, ownerId: string): Promise<string | null> {
    const item = this.store.getCapture(captureId);
    if (!item || item.ownerId !== ownerId || !item.metadata.objectKey) return null;

    return await this.storageProvider.getSignedUrl(item.metadata.objectKey, 3600);
  }

  public async getPreviewUrl(captureId: string, ownerId: string): Promise<string | null> {
    return this.getDownloadUrl(captureId, ownerId);
  }

  public getInboxSummary(ownerId: string): InboxSummary {
    const items = this.store.listCaptures(ownerId);
    const unreadCount = items.filter((i) => i.status === 'CAPTURED' || i.status === 'READY').length;
    const needsReviewCount = items.filter((i) => i.status === 'NEEDS_REVIEW').length;
    return { ownerId, unreadCount, needsReviewCount, items };
  }

  public async getVaultSummary(ownerId: string): Promise<PersonalVaultSummary> {
    const items = this.store.listCaptures(ownerId);
    const quotaState = this.quotaEngine.getQuota(ownerId);

    const categoriesMap = new Map<string, { count: number; bytes: number; icon: string }>();
    categoriesMap.set('Files', { count: 0, bytes: 0, icon: 'file-text' });
    categoriesMap.set('Links', { count: 0, bytes: 0, icon: 'link' });
    categoriesMap.set('Audio', { count: 0, bytes: 0, icon: 'mic' });
    categoriesMap.set('Notes', { count: 0, bytes: 0, icon: 'edit-3' });

    for (const item of items) {
      const sz = item.metadata.sizeBytes || 1024;
      if (item.type === 'FILE') {
        const cat = categoriesMap.get('Files')!;
        cat.count++; cat.bytes += sz;
      } else if (item.type === 'LINK') {
        const cat = categoriesMap.get('Links')!;
        cat.count++; cat.bytes += sz;
      } else if (item.type === 'AUDIO') {
        const cat = categoriesMap.get('Audio')!;
        cat.count++; cat.bytes += sz;
      } else {
        const cat = categoriesMap.get('Notes')!;
        cat.count++; cat.bytes += sz;
      }
    }

    const categories = Array.from(categoriesMap.entries()).map(([name, val], idx) => ({
      categoryId: `cat_${idx + 1}`,
      name,
      icon: val.icon,
      itemCount: val.count,
      totalSizeBytes: val.bytes,
    }));

    const health = this.storageProvider.checkHealth
      ? await this.storageProvider.checkHealth()
      : { configured: true, reachable: true, mode: 'DEVELOPMENT' as const };

    const providerName = this.storageProvider.getProviderName();
    const isCloud = providerName === 's3';
    let label = 'Local Development Vault';

    if (isCloud) {
      if (health.configured && health.bucketAuthorized && health.readable && health.writable && health.mode === 'LIVE') {
        label = 'NAgex Cloud Vault (Nebius S3) - LIVE';
      } else {
        label = 'Cloud Vault - Configuration required';
      }
    }

    return {
      ownerId,
      totalItems: items.length,
      totalSizeBytes: quotaState.usedBytes,
      quotaSizeBytes: quotaState.quotaBytes,
      storageInfo: {
        provider: providerName,
        isCloud,
        label,
        mode: health.mode,
        reachable: health.reachable,
        endpointReachable: health.endpointReachable,
        bucketAuthorized: health.bucketAuthorized,
        readable: health.readable,
        writable: health.writable,
        bucket: health.bucket,
        region: health.region,
      },
      categories,
      recentItems: items.slice(0, 10),
    };
  }

  public async getStorageHealth(): Promise<{
    provider: 'local' | 's3';
    configured: boolean;
    reachable: boolean;
    endpointReachable?: boolean;
    bucketAuthorized?: boolean;
    readable?: boolean;
    writable?: boolean;
    bucket?: string;
    region?: string;
    mode: 'LIVE' | 'DEVELOPMENT' | 'OFFLINE';
    lastCheckedAt: string;
  }> {
    const health = this.storageProvider.checkHealth
      ? await this.storageProvider.checkHealth()
      : { configured: true, reachable: true, mode: 'DEVELOPMENT' as const };

    return {
      provider: this.storageProvider.getProviderName(),
      configured: health.configured,
      reachable: health.reachable,
      endpointReachable: health.endpointReachable,
      bucketAuthorized: health.bucketAuthorized,
      readable: health.readable,
      writable: health.writable,
      bucket: health.bucket,
      region: health.region,
      mode: health.mode,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  public async actionCapture(captureId: string, actionType: 'ACTIONED' | 'ARCHIVED'): Promise<CaptureItem | null> {
    return this.store.updateStatus(captureId, actionType);
  }

  public async getCaptureItem(captureId: string, ownerId: string): Promise<CaptureItem | null> {
    const item = this.store.getCapture(captureId);
    if (!item || item.ownerId !== ownerId) return null;
    return item;
  }

  // Legacy embedded-array candidate action (Phase 1 STEP 1-4). Phase 1
  // STEP 5, item J: accepting a candidate — through this endpoint or the new
  // canonical one below — NEVER creates a Task, requests a Calendar
  // approval, writes Memory, or indexes Knowledge. It only ever changes the
  // candidate's own status; real execution is a later, separate Action
  // phase (STEP 7). Kept only as a backward-compatible status flip over the
  // temporary embedded metadata.candidates array (item O) — new code should
  // use acceptCandidate/rejectCandidate against the canonical CandidateStore.
  public async actionCandidate(params: {
    captureId: string;
    candidateId: string;
    action: 'ACCEPT' | 'REJECT';
    ownerId: string;
    tenantId: string;
  }): Promise<CaptureItem | null> {
    const item = this.store.getCapture(params.captureId);
    if (!item || item.ownerId !== params.ownerId) return null;

    const candidates = item.metadata.candidates || [];
    const candidate = candidates.find((c) => c.candidateId === params.candidateId);
    if (!candidate) return null;

    if (candidate.status !== 'PROPOSED') {
      return item;
    }

    if (params.action === 'ACCEPT') {
      candidate.status = 'ACCEPTED';
      if (this.auditLogger) {
        this.auditLogger.logEvent({
          actor: { type: 'user', id: params.ownerId },
          tenant_id: params.tenantId,
          action: 'candidate.accepted',
          resource: { type: 'Candidate', id: params.candidateId },
          result: 'SUCCESS',
          request_id: `req_cand_acc_${Date.now()}`,
          details: { captureId: params.captureId, candidateType: candidate.type },
        });
      }
    } else if (params.action === 'REJECT') {
      candidate.status = 'REJECTED';

      if (this.auditLogger) {
        this.auditLogger.logEvent({
          actor: { type: 'user', id: params.ownerId },
          tenant_id: params.tenantId,
          action: 'candidate.rejected',
          resource: { type: 'Candidate', id: params.candidateId },
          result: 'SUCCESS',
          request_id: `req_cand_rej_${Date.now()}`,
          details: { captureId: params.captureId, candidateType: candidate.type },
        });
      }
    }

    const allResolved = candidates.every((c) => c.status !== 'PROPOSED');
    const newStatus: CaptureStatus = allResolved ? 'ACTIONED' : item.status;

    const updated = this.store.updateStatus(params.captureId, newStatus, {
      candidates,
    });

    return updated ?? item;
  }

  // ─── Phase 1 STEP 5 — Canonical Candidate Model ───
  // Thin pass-throughs onto CandidateStore. IMPORTANT (item J): accept
  // NEVER creates a Task/Calendar event/Memory record/Knowledge entry — it
  // only changes the candidate's own status. Real execution is STEP 7's
  // concern, not this one.

  private requireCandidateStore(): CandidateStore {
    if (!this.candidateStore) {
      throw new NagexError({
        code: 'CANDIDATE_STORE_NOT_CONFIGURED',
        category: 'CONFLICT',
        message: 'The canonical Candidate store is not configured.',
        request_id: `req_cand_${Date.now()}`,
      });
    }
    return this.candidateStore;
  }

  public getCandidate(candidateId: string, ownerId: string, tenantId: string): CandidateRecord | null {
    if (!this.candidateStore) return null;
    const record = this.candidateStore.get(candidateId);
    if (!record || record.principalId !== ownerId || record.tenantId !== tenantId) return null;
    return record;
  }

  public listCandidates(ownerId: string, tenantId: string, filter?: { status?: CandidateStatus; type?: CandidateType }): CandidateRecord[] {
    if (!this.candidateStore) return [];
    return this.candidateStore.list(ownerId, tenantId, filter);
  }

  // Phase 1 STEP 8 — the consumer-safe Activity projection (never raw
  // AuditLogger, never the legacy non-isolated executionHistory array).
  public listActivity(ownerId: string, tenantId: string, limit = 50): ReturnType<ActivityStore['list']> {
    if (!this.activityStore) return [];
    return this.activityStore.list(tenantId, ownerId, limit);
  }

  public acceptCandidate(candidateId: string, ownerId: string, tenantId: string): CandidateRecord {
    const store = this.requireCandidateStore();
    const record = store.accept(candidateId, tenantId, ownerId, `req_cand_acc_${Date.now()}`);
    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'user', id: ownerId },
        tenant_id: tenantId,
        action: 'candidate.accepted',
        resource: { type: 'Candidate', id: candidateId },
        result: 'SUCCESS',
        request_id: `req_cand_acc_${Date.now()}`,
        details: { captureId: record.captureId, candidateType: record.type },
      });
    }
    return record;
  }

  public rejectCandidate(candidateId: string, ownerId: string, tenantId: string): CandidateRecord {
    const store = this.requireCandidateStore();
    const record = store.reject(candidateId, tenantId, ownerId, `req_cand_rej_${Date.now()}`);
    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'user', id: ownerId },
        tenant_id: tenantId,
        action: 'candidate.rejected',
        resource: { type: 'Candidate', id: candidateId },
        result: 'SUCCESS',
        request_id: `req_cand_rej_${Date.now()}`,
        details: { captureId: record.captureId, candidateType: record.type },
      });
    }
    return record;
  }

  // Phase 1 STEP 6, item G: modify a still-PROPOSED candidate's title/payload
  // before deciding. Never touches type/tenantId/principalId/captureId/
  // contentHash/sourceRefs/status — CandidateStore.modify() enforces this
  // structurally and validates the type-specific payload, failing closed.
  public modifyCandidate(candidateId: string, ownerId: string, tenantId: string, patch: { title?: string; payload?: Record<string, unknown> }): CandidateRecord {
    const store = this.requireCandidateStore();
    const record = store.modify(candidateId, tenantId, ownerId, patch, `req_cand_mod_${Date.now()}`);
    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'user', id: ownerId },
        tenant_id: tenantId,
        action: 'candidate.modified',
        resource: { type: 'Candidate', id: candidateId },
        result: 'SUCCESS',
        request_id: `req_cand_mod_${Date.now()}`,
        details: { captureId: record.captureId, candidateType: record.type },
      });
    }
    return record;
  }

  // ─── Phase 1 STEP 7 — Real Actions ───
  // Thin pass-throughs onto CandidateActionResolver. See action-resolver.ts
  // for the actual execution logic, idempotency, approval-gating, and
  // stale-source protection — this class only forwards.

  private requireActionResolver(): CandidateActionResolver {
    if (!this.actionResolver) {
      throw new NagexError({
        code: 'CANDIDATE_ACTION_RESOLVER_NOT_CONFIGURED',
        category: 'CONFLICT',
        message: 'The Candidate Action Resolver is not configured.',
        request_id: `req_cand_act_${Date.now()}`,
      });
    }
    return this.actionResolver;
  }

  public async executeCandidateAction(candidateId: string, ownerId: string, tenantId: string): Promise<CandidateRecord> {
    return this.requireActionResolver().executeCandidate(candidateId, tenantId, ownerId);
  }

  public async retryCandidateAction(candidateId: string, ownerId: string, tenantId: string): Promise<CandidateRecord> {
    return this.requireActionResolver().retryCandidate(candidateId, tenantId, ownerId);
  }

  public getCandidateAction(candidateId: string, ownerId: string, tenantId: string): CandidateRecord['action'] {
    return this.requireActionResolver().getAction(candidateId, tenantId, ownerId);
  }

  public async retryCapture(captureId: string, ownerId: string): Promise<CaptureItem | null> {
    const item = this.store.getCapture(captureId);
    if (!item || item.ownerId !== ownerId) return null;

    // Phase 1 STEP 9, item R/S — only a capture whose recorded failure
    // classification says retryable=true (or has no classification yet,
    // e.g. pre-STEP-9 data) may be retried; a TERMINAL/NEEDS_HUMAN failure
    // is refused here, server-side, not merely hidden by the UI's button.
    if (item.metadata.retryable === false) {
      throw new NagexError({
        code: item.metadata.errorCode || 'CAPTURE_NOT_RETRYABLE',
        category: 'CONFLICT',
        message: classifyFailure(item.metadata.errorCode).userMessage,
        request_id: `req_cap_retry_blocked_${Date.now()}`,
      });
    }

    const requestId = `req_cap_retry_${Date.now()}`;
    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'user', id: ownerId },
        tenant_id: item.tenantId,
        action: 'capture.retry.requested',
        resource: { type: 'CaptureItem', id: captureId },
        result: 'SUCCESS',
        request_id: requestId,
        details: { previousErrorCode: item.metadata.errorCode, attemptCount: item.metadata.retryAttemptCount ?? 0 },
      });
    }

    const existingCandidates = (item.metadata.candidates || []).filter((c) => c.status !== 'PROPOSED');

    this.store.updateStatus(captureId, 'QUEUED', {
      processingStage: 'QUEUED',
      errorCode: undefined,
      errorMessage: undefined,
      candidates: existingCandidates,
    });

    let rawBuffer: Buffer | undefined;
    if (item.metadata.objectKey && this.storageProvider) {
      const obj = await this.storageProvider.getObject(item.metadata.objectKey);
      if (obj) {
        rawBuffer = obj.data;
      }
    }

    if (this.auditLogger) {
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: 'capture.retry.started',
        resource: { type: 'CaptureItem', id: captureId },
        result: 'SUCCESS',
        request_id: requestId,
        details: {},
      });
    }

    const retriedItem = this.store.getCapture(captureId) || item;
    const result = await this.processor.process(retriedItem, rawBuffer);

    if (this.auditLogger) {
      const succeeded = result.status !== 'FAILED';
      this.auditLogger.logEvent({
        actor: { type: 'system', id: 'capture-processor' },
        tenant_id: item.tenantId,
        action: succeeded ? 'capture.retry.succeeded' : 'capture.retry.failed',
        resource: { type: 'CaptureItem', id: captureId },
        result: succeeded ? 'SUCCESS' : 'DENIED',
        request_id: requestId,
        details: { status: result.status, errorCode: result.metadata.errorCode },
      });
    }

    return result;
  }
}
