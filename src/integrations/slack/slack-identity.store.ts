import { FileRecordStore, resolveNagexDataDir } from '../../governance/file-record.store.js';

export interface SlackIdentityLinkRecord {
  slackUserId: string;
  slackTeamId?: string;
  principalId: string;
  tenantId: string;
  username?: string;
  linkedAt: string;
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
    tenantId = 'ten_production_01',
    slackTeamId?: string,
    username?: string,
  ): SlackIdentityLinkRecord {
    const record: SlackIdentityLinkRecord = {
      slackUserId,
      slackTeamId,
      principalId,
      tenantId,
      username,
      linkedAt: new Date().toISOString(),
    };
    this.records.set(slackUserId, record);
    this.fileStore.write(slackUserId, record);
    return record;
  }

  public resolve(slackUserId: string, defaultTenantId = 'ten_production_01'): { principalId: string; tenantId: string } {
    const existing = this.records.get(slackUserId);
    if (existing) {
      return { principalId: existing.principalId, tenantId: existing.tenantId };
    }
    // Fallback default resolution: bind to default principal for unlinked slack ID
    return { principalId: `usr_slack_${slackUserId}`, tenantId: defaultTenantId };
  }

  public get(slackUserId: string): SlackIdentityLinkRecord | undefined {
    return this.records.get(slackUserId);
  }

  public list(): SlackIdentityLinkRecord[] {
    return [...this.records.values()];
  }
}
