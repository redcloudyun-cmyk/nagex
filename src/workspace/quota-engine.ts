import { NagexError } from '../common/errors.js';

export interface QuotaState {
  usedBytes: number;
  quotaBytes: number;
  itemCount: number;
}

export class WorkspaceQuotaEngine {
  private readonly userQuotas = new Map<string, QuotaState>();
  private readonly defaultQuotaBytes: number;

  constructor(defaultQuotaBytes?: number) {
    const envQuota = process.env.NAGEX_VAULT_QUOTA_BYTES ? Number(process.env.NAGEX_VAULT_QUOTA_BYTES) : NaN;
    this.defaultQuotaBytes = defaultQuotaBytes ?? (Number.isNaN(envQuota) ? 5 * 1024 * 1024 * 1024 : envQuota);
  }

  public getQuota(ownerId: string): QuotaState {
    let state = this.userQuotas.get(ownerId);
    if (!state) {
      state = { usedBytes: 0, quotaBytes: this.defaultQuotaBytes, itemCount: 0 };
      this.userQuotas.set(ownerId, state);
    }
    return { ...state };
  }

  public checkQuota(ownerId: string, additionalBytes: number): void {
    const quota = this.getQuota(ownerId);
    if (quota.usedBytes + additionalBytes > quota.quotaBytes) {
      throw new NagexError({
        code: 'QUOTA_EXCEEDED',
        category: 'QUOTA',
        message: `Vault storage quota exceeded. Used ${quota.usedBytes} / ${quota.quotaBytes} bytes, attempted +${additionalBytes} bytes.`,
        request_id: `req_quota_${Date.now()}`,
      });
    }
  }


  public recordUpload(ownerId: string, bytes: number): void {
    const quota = this.getQuota(ownerId);
    quota.usedBytes += bytes;
    quota.itemCount += 1;
    this.userQuotas.set(ownerId, quota);
  }

  public recordDeletion(ownerId: string, bytes: number): void {
    const quota = this.getQuota(ownerId);
    quota.usedBytes = Math.max(0, quota.usedBytes - bytes);
    quota.itemCount = Math.max(0, quota.itemCount - 1);
    this.userQuotas.set(ownerId, quota);
  }

  public recalculate(ownerId: string, items: Array<{ metadata: { sizeBytes?: number } }>): void {
    const usedBytes = items.reduce((acc, i) => acc + (i.metadata.sizeBytes || 0), 0);
    const itemCount = items.length;
    this.userQuotas.set(ownerId, {
      usedBytes,
      quotaBytes: this.defaultQuotaBytes,
      itemCount,
    });
  }
}
