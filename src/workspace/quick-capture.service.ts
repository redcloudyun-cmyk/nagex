import crypto from 'node:crypto';
import { NagexError } from '../common/errors.js';
import type { CaptureStore } from './capture.store.js';
import type { CaptureItem, CaptureStatus, CaptureType, InboxSummary, PersonalVaultSummary } from './workspace.types.js';
import type { TaskStore } from '../tasks/task.store.js';
import type { MemoryEngine } from '../context/memory.engine.js';
import type { KnowledgeEngine } from '../context/knowledge.engine.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { LocalStorageProvider } from '../storage/local-storage.provider.js';
import { WorkspaceQuotaEngine } from './quota-engine.js';
import { CaptureProcessor } from './capture-processor.js';
import {
  generateCanonicalObjectKey,
  sanitizeFilename,
  scanObjectForMalware,
  validateFileSize,
  validateMimeAndExtension,
} from './vault-security.js';
import { generateResourceId } from '../common/utils.js';


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
  ) {
    this.quotaEngine = new WorkspaceQuotaEngine();
    this.processor = new CaptureProcessor(this.store);
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
    this.store.createCapture({
      ownerId: params.ownerId,
      tenantId: params.tenantId,
      type: (params.mimeType.startsWith('audio/') ? 'AUDIO' : 'FILE') as CaptureType,
      content: objectKey,
      source: 'WEB',
      metadata: {
        originalName: cleanFilename,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
        objectKey,
        storageProvider: this.storageProvider.getProviderName(),
      },
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
      item = this.store.createCapture({
        ownerId: params.ownerId,
        tenantId: params.tenantId,
        type: (params.mimeType.startsWith('audio/') ? 'AUDIO' : 'FILE') as CaptureType,
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
      if (health.configured && health.reachable) {
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
      bucket: health.bucket,
      region: health.region,
      mode: health.mode,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  public async actionCapture(captureId: string, actionType: 'ACTIONED' | 'ARCHIVED'): Promise<CaptureItem | null> {
    return this.store.updateStatus(captureId, actionType);
  }
}
