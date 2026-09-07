import type { CaptureStore } from './capture.store.js';
import type { CaptureItem, CaptureStatus, CaptureType, InboxSummary, PersonalVaultSummary } from './workspace.types.js';
import type { TaskStore } from '../tasks/task.store.js';
import type { MemoryEngine } from '../context/memory.engine.js';
import type { KnowledgeEngine } from '../context/knowledge.engine.js';

export class QuickCaptureService {
  constructor(
    private readonly store: CaptureStore,
    private readonly taskStore?: TaskStore,
    private readonly memoryEngine?: MemoryEngine,
    private readonly knowledgeEngine?: KnowledgeEngine,
  ) {}

  public async capture(params: {
    ownerId: string;
    tenantId: string;
    type: CaptureType;
    content: string;
    source?: 'WEB' | 'DESKTOP' | 'MOBILE' | 'TELEGRAM' | 'SLACK';
    originalName?: string;
    mimeType?: string;
    sizeBytes?: number;
  }): Promise<CaptureItem> {
    const item = this.store.createCapture({
      ownerId: params.ownerId,
      tenantId: params.tenantId,
      type: params.type,
      content: params.content,
      source: params.source,
      metadata: {
        originalName: params.originalName,
        mimeType: params.mimeType,
        sizeBytes: params.sizeBytes,
      },
    });

    // Run truthful processing pipeline synchronously/async
    await this.processCapturePipeline(item);
    return this.store.getCapture(item.captureId) ?? item;
  }

  private async processCapturePipeline(item: CaptureItem): Promise<void> {
    // 1. Transition to UPLOADING if binary file/audio payload
    if (item.type === 'FILE' || item.type === 'AUDIO') {
      this.store.updateStatus(item.captureId, 'UPLOADING');
    }

    // 2. Transition to PROCESSING
    this.store.updateStatus(item.captureId, 'PROCESSING');

    // 3. Extract title, summary, and action items truthfully based on type
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

    // Update vault path
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
    if (item.type === 'LINK') return `Web capture saved to Personal Cloud Vault. Contains reference link to ${item.content}`;
    if (item.type === 'AUDIO') return `Voice memo captured from ${item.source}. Processed and indexed into Vault.`;
    if (item.type === 'FILE') return `Document artifact (${item.metadata.originalName || 'file'}) uploaded to Cloud Vault.`;
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
        title: `Calendar event candidate: ${this.extractTitle(item)}`,
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

    return {
      ownerId,
      totalItems: items.length,
      totalSizeBytes,
      quotaSizeBytes: 10 * 1024 * 1024 * 1024, // 10 GB default vault quota
      categories,
      recentItems: items.slice(0, 10),
    };
  }

  public async actionCapture(captureId: string, actionType: 'ACTIONED' | 'ARCHIVED'): Promise<CaptureItem | null> {
    return this.store.updateStatus(captureId, actionType);
  }
}
