import { NagexError } from '../../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from '../../governance/file-record.store.js';

// S2C — set only by the S2B ownership flow (a challenge redeemed from the Slack account itself, in the workspace it names).
// A link without it predates S2B and was never proven: it is never a trusted outbound destination for a signed-in caller.
export type ChannelOwnershipProof = 'CHANNEL_CHALLENGE';

export interface SlackIdentityLinkRecord {
  slackUserId: string;
  slackTeamId?: string;
  principalId: string;
  tenantId: string;
  username?: string;
  linkedAt: string;
  ownershipProof?: ChannelOwnershipProof;
}

export function isSlackIdentityLinkRecord(value: unknown): value is SlackIdentityLinkRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.slackUserId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.linkedAt === 'string'
  );
}

export interface SlackIdentityStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
}

export class SlackIdentityStore {
  private readonly records = new Map<string, SlackIdentityLinkRecord>();
  private readonly fileStore: FileRecordStore<SlackIdentityLinkRecord>;

  constructor(options: SlackIdentityStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('slack_identities', 'NAGEX_SLACK_DIR', env);
    this.fileStore = new FileRecordStore<SlackIdentityLinkRecord>(dir, isSlackIdentityLinkRecord);
    for (const record of this.fileStore.readAll()) {
      this.records.set(record.slackUserId, record);
    }
  }

  public link(
    slackUserId: string,
    principalId: string,
    tenantId: string,
    slackTeamId?: string,
    username?: string,
    ownershipProof?: ChannelOwnershipProof,
  ): SlackIdentityLinkRecord {
    // S2B — NO_SILENT_REBIND (see TelegramIdentityStore.link): a Slack identity linked to a different principal is
    // never overwritten; re-linking to the same principal refreshes the record.
    const existing = this.records.get(slackUserId);
    if (existing && (existing.principalId !== principalId || existing.tenantId !== tenantId)) {
      throw new NagexError({ code: 'CHANNEL_IDENTITY_ALREADY_LINKED', category: 'CONFLICT', message: 'This Slack account is already linked to a NAgex account. It must be unlinked there first.' });
    }
    const record: SlackIdentityLinkRecord = {
      slackUserId,
      slackTeamId,
      principalId,
      tenantId,
      username,
      linkedAt: new Date().toISOString(),
      ownershipProof: ownershipProof ?? existing?.ownershipProof,
    };
    this.records.set(slackUserId, record);
    this.fileStore.write(slackUserId, record);
    return record;
  }

  // `slackTeamId` is the workspace the (signed) event came from. A link made through the ownership flow records the
  // workspace it was proven in; an event from a DIFFERENT workspace with the same user id is not that person. (Links that
  // predate S2B carry no workspace and keep resolving by user id.)
  public resolve(slackUserId: string, slackTeamId?: string): { principalId: string; tenantId: string } {
    const existing = this.records.get(slackUserId);
    const workspaceMismatch = Boolean(existing?.slackTeamId && slackTeamId && existing.slackTeamId !== slackTeamId);
    if (existing && !workspaceMismatch) {
      return { principalId: existing.principalId, tenantId: existing.tenantId };
    }
    // S1: an unlinked Slack user is its OWN isolated principal AND tenant — never the default
    // tenant, never anyone's account. It can only ever see data it created itself.
    return { principalId: `usr_slack_${slackUserId}`, tenantId: `ten_slack_${slackUserId}` };
  }

  public get(slackUserId: string): SlackIdentityLinkRecord | undefined {
    return this.records.get(slackUserId);
  }

  // S2B — a principal sees and removes only ITS OWN links.
  public listForPrincipal(principalId: string, tenantId: string): SlackIdentityLinkRecord[] {
    return [...this.records.values()].filter((r) => r.principalId === principalId && r.tenantId === tenantId);
  }

  // Only links whose ownership was PROVEN from the channel (S2B), in a named workspace. These are the only trusted
  // outbound destinations.
  public listVerifiedForPrincipal(principalId: string, tenantId: string): SlackIdentityLinkRecord[] {
    return this.listForPrincipal(principalId, tenantId).filter((r) => r.ownershipProof === 'CHANNEL_CHALLENGE' && Boolean(r.slackTeamId));
  }

  public unlinkForPrincipal(principalId: string, tenantId: string): number {
    let removed = 0;
    for (const record of this.listForPrincipal(principalId, tenantId)) {
      this.records.delete(record.slackUserId);
      this.fileStore.remove(record.slackUserId);
      removed++;
    }
    return removed;
  }

  public list(): SlackIdentityLinkRecord[] {
    return [...this.records.values()];
  }
}
