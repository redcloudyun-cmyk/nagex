// R23.6M Phase C — durable mobile-message run persistence. Same
// FileRecordStore + getOwned() pattern as every other multi-step-lifecycle
// store in this codebase (CompetitorPricingRunStore, ActionApprovalStore).
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { isMobileMessageRunRecord, type MobileMessageRunRecord } from './mobile-message.types.js';

export interface MobileMessageRunStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class MobileMessageRunStore {
  private readonly fileStore: FileRecordStore<MobileMessageRunRecord>;
  private readonly now: () => string;

  constructor(options: MobileMessageRunStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('mobile-message-runs', 'NAGEX_MOBILE_MESSAGE_RUNS_DIR', env);
    this.fileStore = new FileRecordStore<MobileMessageRunRecord>(dir, isMobileMessageRunRecord);
    this.now = options.now ?? getCurrentISOString;
  }

  public create(input: { tenantId: string; ownerId: string; deviceId: string; requestId: string; recipientRef: string; message: string }): MobileMessageRunRecord {
    const timestamp = this.now();
    const record: MobileMessageRunRecord = {
      runId: generateResourceId('mmr'),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      requestId: input.requestId,
      recipientRef: input.recipientRef,
      channel: 'SMS',
      message: input.message,
      executionRoute: 'ANDROID_SMS_MANAGER',
      status: 'DRAFT_CREATED',
      failureReason: null,
      approvalId: null,
      executionId: null,
      deliveryConfirmed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.fileStore.write(record.runId, record);
    return record;
  }

  public get(runId: string): MobileMessageRunRecord | undefined {
    return this.fileStore.read(runId) ?? undefined;
  }

  public getOwned(runId: string, tenantId: string, ownerId: string): MobileMessageRunRecord | undefined {
    const record = this.get(runId);
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) return undefined;
    return record;
  }

  public save(record: MobileMessageRunRecord): MobileMessageRunRecord {
    const updated: MobileMessageRunRecord = { ...record, updatedAt: this.now() };
    this.fileStore.write(updated.runId, updated);
    return updated;
  }
}
