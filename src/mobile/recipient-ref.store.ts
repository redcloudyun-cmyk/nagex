// R23.6M Phase B3 — durable, tenant/owner/device-scoped recipientRef
// storage. Same FileRecordStore + getOwned() pattern as every other
// ownership-scoped store in this codebase (DeviceIdentityStore,
// CompetitorPricingBaselineStore, etc.) — never an in-memory-only map.
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { isMobileRecipientRefRecord, type MobileRecipientRefRecord } from './contact-resolution.types.js';

export interface RecipientRefStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class RecipientRefStore {
  private readonly records = new Map<string, MobileRecipientRefRecord>();
  private readonly fileStore: FileRecordStore<MobileRecipientRefRecord>;
  private readonly now: () => string;

  constructor(options: RecipientRefStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('mobile-recipient-refs', 'NAGEX_MOBILE_RECIPIENT_REFS_DIR', env);
    this.fileStore = new FileRecordStore<MobileRecipientRefRecord>(dir, isMobileRecipientRefRecord);
    this.now = options.now ?? getCurrentISOString;
    for (const record of this.fileStore.readAll()) {
      this.records.set(record.recipientRef, record);
    }
  }

  // The server always mints its own recipientRef — never accepts one from
  // a caller. This is the ONLY place a recipientRef is ever created; the
  // only caller is ContactResolver.resolve() after it has independently
  // verified a unique, matching candidate (contact-resolver.service.ts).
  // Every (tenantId, ownerId, deviceId, androidContactId) combination gets
  // its own stable ref — re-resolving the same contact reuses it rather
  // than minting duplicates.
  public mintOrReuse(input: { tenantId: string; ownerId: string; deviceId: string; androidContactId: string; displayName: string }): MobileRecipientRefRecord {
    for (const existing of this.records.values()) {
      if (
        existing.tenantId === input.tenantId &&
        existing.ownerId === input.ownerId &&
        existing.deviceId === input.deviceId &&
        existing.androidContactId === input.androidContactId
      ) {
        return existing;
      }
    }
    const record: MobileRecipientRefRecord = {
      recipientRef: generateResourceId('rcp'),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      deviceId: input.deviceId,
      androidContactId: input.androidContactId,
      displayName: input.displayName,
      createdAt: this.now(),
    };
    this.records.set(record.recipientRef, record);
    this.fileStore.writeOrThrow(record.recipientRef, record);
    return record;
  }

  // Tenant/owner/device-scoped lookup — a mismatch on any of the three is
  // indistinguishable from a nonexistent recipientRef, same fail-closed
  // pattern as every other getOwned() in this codebase.
  public getOwned(recipientRef: string, tenantId: string, ownerId: string, deviceId: string): MobileRecipientRefRecord | null {
    const record = this.records.get(recipientRef);
    if (!record) return null;
    if (record.tenantId !== tenantId || record.ownerId !== ownerId || record.deviceId !== deviceId) return null;
    return record;
  }
}
