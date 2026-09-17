// R13 Identity & Account Lifecycle — One-Time Security Tokens
import crypto from 'node:crypto';
import { generateResourceId } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

export type TokenType = 'EMAIL_VERIFY' | 'PASSWORD_RESET' | 'EMAIL_CHANGE';

export interface TokenRecord {
  tokenId: string;
  hashedToken: string;
  type: TokenType;
  userId: string;
  newEmail?: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
}

export function isTokenRecord(value: unknown): value is TokenRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.tokenId === 'string' &&
    typeof v.hashedToken === 'string' &&
    typeof v.type === 'string' &&
    typeof v.userId === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.expiresAt === 'string'
  );
}

export interface TokenStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class IdentityTokenStore {
  private readonly records = new Map<string, TokenRecord>();
  private readonly fileStore: FileRecordStore<TokenRecord>;
  private readonly now: () => string;

  constructor(options: TokenStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('identity-tokens', 'NAGEX_IDENTITY_TOKENS_DIR', env);
    this.fileStore = new FileRecordStore<TokenRecord>(dir, isTokenRecord);
    this.now = options.now ?? (() => new Date().toISOString());
    for (const record of this.fileStore.readAll()) {
      this.records.set(record.tokenId, record);
    }
  }

  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  public createToken(type: TokenType, userId: string, ttlMs: number, newEmail?: string): { rawToken: string; record: TokenRecord } {
    const rawToken = crypto.randomBytes(24).toString('hex');
    const hashedToken = this.hashToken(rawToken);
    const createdAt = this.now();
    const expiresAt = new Date(new Date(createdAt).getTime() + ttlMs).toISOString();

    const record: TokenRecord = {
      tokenId: `tok_${crypto.randomBytes(8).toString('hex')}`,
      hashedToken,
      type,
      userId,
      newEmail: newEmail || null,
      createdAt,
      expiresAt,
      usedAt: null,
    };

    this.records.set(record.tokenId, record);
    this.fileStore.write(record.tokenId, record);
    return { rawToken, record };
  }

  public consumeToken(type: TokenType, rawToken: string): TokenRecord | null {
    const hashedToken = this.hashToken(rawToken);
    const nowIso = this.now();

    for (const record of this.records.values()) {
      if (record.type === type && record.hashedToken === hashedToken) {
        if (record.usedAt != null) return null; // already consumed
        if (new Date(nowIso).getTime() > new Date(record.expiresAt).getTime()) return null; // expired

        record.usedAt = nowIso;
        this.fileStore.write(record.tokenId, record);
        return record;
      }
    }

    return null;
  }
}
