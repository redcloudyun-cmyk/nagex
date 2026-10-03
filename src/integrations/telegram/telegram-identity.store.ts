import { NagexError } from '../../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from '../../governance/file-record.store.js';

// S2C — set only by the S2B ownership flow (a challenge redeemed from the Telegram account itself). A link without it
// predates S2B and was never proven: it is never a trusted outbound destination for a signed-in caller.
export type ChannelOwnershipProof = 'CHANNEL_CHALLENGE';

export interface TelegramIdentityLinkRecord {
  telegramUserId: string;
  principalId: string;
  tenantId: string;
  username?: string;
  linkedAt: string;
  ownershipProof?: ChannelOwnershipProof;
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

  // S2B — NO_SILENT_REBIND. An external identity that is already linked to a DIFFERENT principal is never overwritten:
  // the caller gets CHANNEL_IDENTITY_ALREADY_LINKED and the existing link stays exactly as it was. Re-linking to the
  // SAME principal just refreshes the record. The HTTP flow reaches this only after the channel proved ownership
  // (ChannelLinkChallengeStore); a client-supplied id never gets here.
  public link(telegramUserId: string, principalId: string, tenantId: string, username?: string, ownershipProof?: ChannelOwnershipProof): TelegramIdentityLinkRecord {
    const existing = this.records.get(telegramUserId);
    if (existing && (existing.principalId !== principalId || existing.tenantId !== tenantId)) {
      throw new NagexError({ code: 'CHANNEL_IDENTITY_ALREADY_LINKED', category: 'CONFLICT', message: 'This Telegram account is already linked to a NAgex account. It must be unlinked there first.' });
    }
    const record: TelegramIdentityLinkRecord = {
      telegramUserId,
      principalId,
      tenantId,
      username,
      linkedAt: new Date().toISOString(),
      ownershipProof: ownershipProof ?? existing?.ownershipProof,
    };
    this.records.set(telegramUserId, record);
    this.fileStore.write(telegramUserId, record);
    return record;
  }

  public resolve(telegramUserId: string): { principalId: string; tenantId: string } {
    const existing = this.records.get(telegramUserId);
    if (existing) {
      return { principalId: existing.principalId, tenantId: existing.tenantId };
    }
    // S1: an unlinked Telegram user is its OWN isolated principal AND tenant — never the default
    // tenant, never anyone's account. It can only ever see data it created itself.
    return { principalId: `usr_telegram_${telegramUserId}`, tenantId: `ten_telegram_${telegramUserId}` };
  }

  public get(telegramUserId: string): TelegramIdentityLinkRecord | undefined {
    return this.records.get(telegramUserId);
  }

  // S2B — a principal sees and removes only ITS OWN links.
  public listForPrincipal(principalId: string, tenantId: string): TelegramIdentityLinkRecord[] {
    return [...this.records.values()].filter((r) => r.principalId === principalId && r.tenantId === tenantId);
  }

  // Only links whose ownership was PROVEN from the channel (S2B). These are the only trusted outbound destinations.
  public listVerifiedForPrincipal(principalId: string, tenantId: string): TelegramIdentityLinkRecord[] {
    return this.listForPrincipal(principalId, tenantId).filter((r) => r.ownershipProof === 'CHANNEL_CHALLENGE');
  }

  public unlinkForPrincipal(principalId: string, tenantId: string): number {
    let removed = 0;
    for (const record of this.listForPrincipal(principalId, tenantId)) {
      this.records.delete(record.telegramUserId);
      this.fileStore.remove(record.telegramUserId);
      removed++;
    }
    return removed;
  }

  public list(): TelegramIdentityLinkRecord[] {
    return [...this.records.values()];
  }
}
