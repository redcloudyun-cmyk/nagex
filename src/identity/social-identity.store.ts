import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

export type SocialProvider = 'google' | 'microsoft';
export interface SocialIdentityLink { id: string; provider: SocialProvider; subject: string; userId: string; createdAt: string }

function isLink(value: unknown): value is SocialIdentityLink {
  const item = value as Partial<SocialIdentityLink>;
  return Boolean(item && typeof item.id === 'string' && (item.provider === 'google' || item.provider === 'microsoft') && typeof item.subject === 'string' && typeof item.userId === 'string');
}

export class SocialIdentityStore {
  private readonly links = new Map<string, SocialIdentityLink>();
  private readonly files: FileRecordStore<SocialIdentityLink>;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.files = new FileRecordStore(resolveNagexDataDir('social-identities', 'NAGEX_SOCIAL_IDENTITY_DIR', env), isLink);
    for (const link of this.files.readAll()) this.links.set(link.id, link);
  }
  private key(provider: SocialProvider, subject: string): string { return `${provider}:${subject}`; }
  public get(provider: SocialProvider, subject: string): SocialIdentityLink | undefined { return this.links.get(this.key(provider, subject)); }
  public create(provider: SocialProvider, subject: string, userId: string): SocialIdentityLink {
    const id = this.key(provider, subject);
    const existing = this.links.get(id);
    if (existing) return existing;
    const link = { id, provider, subject, userId, createdAt: new Date().toISOString() };
    this.links.set(id, link); this.files.writeOrThrow(id, link); return link;
  }
}
