import { FileRecordStore, resolveNagexDataDir } from '../../governance/file-record.store.js';

export interface TelegramIdentityLinkRecord {
  telegramUserId: string;
  principalId: string;
  tenantId: string;
  username?: string;
  linkedAt: string;
}

export function isTelegramIdentityLinkRecord(value: unknown): value is TelegramIdentityLinkRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.telegramUserId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.linkedAt === 'string'
  );
}

export interface TelegramIdentityStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export class TelegramIdentityStore {
  private readonly records = new Map<string, TelegramIdentityLinkRecord>();
  private readonly fileStore: FileRecordStore<TelegramIdentityLinkRecord>;

  constructor(options: TelegramIdentityStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('telegram_identities', 'NAGEX_TELEGRAM_DIR', env);
    this.fileStore = new FileRecordStore<TelegramIdentityLinkRecord>(dir, isTelegramIdentityLinkRecord);
    for (const record of this.fileStore.readAll()) {
      this.records.set(record.telegramUserId, record);
    }
  }

  public link(telegramUserId: string, principalId: string, tenantId = 'ten_production_01', username?: string): TelegramIdentityLinkRecord {
    const record: TelegramIdentityLinkRecord = {
      telegramUserId,
      principalId,
      tenantId,
      username,
      linkedAt: new Date().toISOString(),
    };
    this.records.set(telegramUserId, record);
    this.fileStore.write(telegramUserId, record);
    return record;
  }

  public resolve(telegramUserId: string, defaultTenantId = 'ten_production_01'): { principalId: string; tenantId: string } {
    const existing = this.records.get(telegramUserId);
    if (existing) {
      return { principalId: existing.principalId, tenantId: existing.tenantId };
    }
    // Fallback default resolution: bind to default principal or telegram principal
    return { principalId: `usr_telegram_${telegramUserId}`, tenantId: defaultTenantId };
  }

  public get(telegramUserId: string): TelegramIdentityLinkRecord | undefined {
    return this.records.get(telegramUserId);
  }

  public list(): TelegramIdentityLinkRecord[] {
    return [...this.records.values()];
  }
}
