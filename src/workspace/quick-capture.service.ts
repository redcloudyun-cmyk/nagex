import type { CaptureStore } from './capture.store.js';
import type { CaptureItem, CaptureStatus, CaptureType, InboxSummary, PersonalVaultSummary } from './workspace.types.js';
import type { TaskStore } from '../tasks/task.store.js';
import type { MemoryEngine } from '../context/memory.engine.js';
import type { KnowledgeEngine } from '../context/knowledge.engine.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { LocalStorageProvider } from '../storage/local-storage.provider.js';

export class QuickCaptureService {
  constructor(
    private readonly store: CaptureStore,
    private readonly storageProvider: StorageProvider = new LocalStorageProvider(),
    private readonly taskStore?: TaskStore,
    private readonly memoryEngine?: MemoryEngine,
    private readonly knowledgeEngine?: KnowledgeEngine,
  ) {}

  public getStorageProvider(): StorageProvider {
    return this.storageProvider;
  }

  public async uploadBinaryObject(params: {
    ownerId: string;
    tenantId: string;
    type: CaptureType;
    filename: string;
    mimeType: string;
    data: Buffer | Uint8Array;
    source?: 'WEB' | 'DESKTOP' | 'MOBILE' | 'TELEGRAM' | 'SLACK';
  }): Promise<CaptureItem> {
    if (!params.data || params.data.length === 0) {
      throw new Error('ZERO_BYTE_PAYLOAD: Cannot capture an object with 0 bytes.');
    }

    // 1. Ingest & Store binary object into StorageProvider
    const key = `vault/${params.ownerId}/${params.type.toLowerCase()}s/${Date.now()}_${params.filename}`;
    const objectMeta = await this.storageProvider.putObject(key, params.data, params.mimeType);

    // 2. Create CaptureItem metadata record
    const item = this.store.createCapture({
      ownerId: params.ownerId,
      tenantId: params.tenantId,
      type: params.type,
      content: key,
      source: params.source ?? 'WEB',
      metadata: {
        originalName: params.filename,
        mimeType: params.mimeType,
        sizeBytes: objectMeta.sizeBytes,
        objectKey: objectMeta.objectKey,
        storageProvider: this.storageProvider.getProviderName(),
        checksum: objectMeta.checksum,
      },
    });

    // 3. Process capture pipeline
    await this.processCapturePipeline(item);
    return this.store.getCapture(item.captureId) ?? item;
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

    await this.processCapturePipeline(item);
    return this.store.getCapture(item.captureId) ?? item;
  }

  private async processCapturePipeline(item: CaptureItem): Promise<void> {
    if (item.type === 'FILE' || item.type === 'AUDIO') {
      this.store.updateStatus(item.captureId, 'UPLOADING');
    }

    this.store.updateStatus(item.captureId, 'PROCESSING');

    const extractedTitle = this.extractTitle(item);
    const extractedSummary = this.extractSummary(item);
    const suggestedAction = this.extractSuggestedAction(item);

    const vaultPath = `vault/${item.ownerId}/${item.type.toLowerCase()}s/${item.captureId}`;
    const nextStatus: CaptureStatus = suggestedAction ? 'NEEDS_REVIEW' : 'READY';

    this.store.updateStatus(item.captureId, nextStatus, {
      extractedTitle,
      extractedSummary,
      suggestedAction,
      extractedTags: [item.type.toLowerCase(), item.source.toLowerCase()],
    });

    const updated = this.store.getCapture(item.captureId);
    if (updated) {
      updated.vaultPath = vaultPath;
    }
  }

  private extractTitle(item: CaptureItem): string {
    if (item.metadata.originalName) return item.metadata.originalName;
    if (item.type === 'LINK') {
      try {
        const u = new URL(item.content);
        return `Link: ${u.hostname}${u.pathname.slice(0, 20)}`;
      } catch {
        return `Captured Link: ${item.content.slice(0, 30)}`;
      }
    }
    if (item.type === 'AUDIO') return `Audio Note (${new Date(item.createdAt).toLocaleTimeString()})`;
    return item.content.slice(0, 40) || 'Quick Note';
  }

  private extractSummary(item: CaptureItem): string {
    if (item.type === 'LINK') return `Web reference saved to Vault (${item.content}).`;
    if (item.type === 'AUDIO') return `Voice audio recording uploaded (${(item.metadata.sizeBytes || 0) / 1024} KB).`;
    if (item.type === 'FILE') return `Document artifact uploaded (${item.metadata.originalName || 'file'}).`;
    return `Captured note: ${item.content}`;
  }

  private extractSuggestedAction(item: CaptureItem): CaptureItem['metadata']['suggestedAction'] | undefined {
    const text = (item.content + ' ' + (item.metadata.originalName || '')).toLowerCase();
    if (text.includes('todo') || text.includes('task') || text.includes('must') || text.includes('review') || text.includes('due')) {
      return {
        type: 'TASK',
        title: `Task candidate: ${this.extractTitle(item)}`,
        detail: item.content,
      };
    }
    if (text.includes('meeting') || text.includes('schedule') || text.includes('calendar') || text.includes('tomorrow')) {
      return {
        type: 'CALENDAR',
        title: `Calendar candidate: ${this.extractTitle(item)}`,
        detail: item.content,
      };
    }
    return undefined;
  }

  public getInboxSummary(ownerId: string): InboxSummary {
    const items = this.store.listCaptures(ownerId);
    const unreadCount = items.filter((i) => i.status === 'CAPTURED' || i.status === 'READY').length;
    const needsReviewCount = items.filter((i) => i.status === 'NEEDS_REVIEW').length;
    return { ownerId, unreadCount, needsReviewCount, items };
  }

  public getVaultSummary(ownerId: string): PersonalVaultSummary {
    const items = this.store.listCaptures(ownerId);
    const totalSizeBytes = items.reduce((acc, i) => acc + (i.metadata.sizeBytes || 1024), 0);

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

    const providerName = this.storageProvider.getProviderName();
    const isCloud = providerName === 's3';

    return {
      ownerId,
      totalItems: items.length,
      totalSizeBytes,
      quotaSizeBytes: 10 * 1024 * 1024 * 1024,
      storageInfo: {
        provider: providerName,
        isCloud,
        label: isCloud ? 'NAgex Cloud Vault (Nebius S3)' : 'Local Development Vault',
      },
      categories,
      recentItems: items.slice(0, 10),
    };
  }

  public async actionCapture(captureId: string, actionType: 'ACTIONED' | 'ARCHIVED'): Promise<CaptureItem | null> {
    return this.store.updateStatus(captureId, actionType);
  }
}
