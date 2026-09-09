import { generateResourceId } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import {
  type ConversationMessageRecord,
  type ConversationRole,
  type ConversationSource,
  type ConversationMessageStatus,
  isConversationMessageRecord,
} from './conversation.types.js';

export interface AppendConversationMessageInput {
  tenantId: string;
  principalId: string;
  sessionId: string;
  role: ConversationRole;
  source: ConversationSource;
  content: string;
  status?: ConversationMessageStatus;
  requestId?: string;
  parentMessageId?: string;
}

export interface ConversationStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export function compareConversationMessages(
  a: ConversationMessageRecord,
  b: ConversationMessageRecord
): number {
  const timeComparison = a.createdAt.localeCompare(b.createdAt);
  if (timeComparison !== 0) return timeComparison;
  return a.messageId.localeCompare(b.messageId);
}

export class ConversationStore {
  private readonly records = new Map<string, ConversationMessageRecord>();
  private readonly fileStore: FileRecordStore<ConversationMessageRecord>;
  private readonly now: () => string;

  constructor(options: ConversationStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('conversations', 'NAGEX_CONVERSATIONS_DIR', env);
    this.fileStore = new FileRecordStore<ConversationMessageRecord>(dir, isConversationMessageRecord);
    this.now = options.now ?? (() => new Date().toISOString());

    for (const record of this.fileStore.readAll()) {
      this.records.set(record.messageId, record);
    }
  }

  public append(input: AppendConversationMessageInput): ConversationMessageRecord {
    if (!input.tenantId || !input.principalId || !input.sessionId) {
      throw new NagexError({
        code: 'INVALID_CONVERSATION_PAYLOAD',
        category: 'VALIDATION',
        message: 'tenantId, principalId, and sessionId are required.',
        request_id: input.requestId ?? `req_${Date.now()}`,
      });
    }

    const messageId = generateResourceId('msg');
    const timestamp = this.now();
    const record: ConversationMessageRecord = {
      messageId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      sessionId: input.sessionId,
      role: input.role,
      status: input.status ?? 'COMMITTED',
      content: input.content,
      source: input.source,
      requestId: input.requestId,
      parentMessageId: input.parentMessageId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      this.fileStore.writeOrThrow(messageId, record);
    } catch (error) {
      throw new NagexError({
        code: 'CONVERSATION_PERSIST_FAILED',
        category: 'RUNTIME',
        message: `Failed to persist conversation message: ${error instanceof Error ? error.message : String(error)}`,
        request_id: input.requestId ?? `req_${Date.now()}`,
      });
    }

    this.records.set(messageId, record);
    return record;
  }

  public get(messageId: string, tenantId: string, principalId: string): ConversationMessageRecord | null {
    const record = this.records.get(messageId);
    if (!record) return null;
    if (record.tenantId !== tenantId || record.principalId !== principalId) {
      return null;
    }
    return record;
  }

  public listSession(
    tenantId: string,
    principalId: string,
    sessionId: string,
    options?: { limit?: number; before?: string }
  ): ConversationMessageRecord[] {
    let matches: ConversationMessageRecord[] = [];
    for (const record of this.records.values()) {
      if (
        record.tenantId === tenantId &&
        record.principalId === principalId &&
        record.sessionId === sessionId
      ) {
        matches.push(record);
      }
    }

    matches.sort(compareConversationMessages);

    if (options?.before) {
      const beforeRef = options.before;
      const targetMsg = this.records.get(beforeRef);
      if (targetMsg) {
        matches = matches.filter((m) => compareConversationMessages(m, targetMsg) < 0);
      } else {
        matches = matches.filter((m) => m.createdAt.localeCompare(beforeRef) < 0);
      }
    }

    if (options?.limit !== undefined && options.limit > 0) {
      matches = matches.slice(-options.limit);
    }

    return matches;
  }

  public getRecentContext(
    tenantId: string,
    principalId: string,
    sessionId: string,
    maxMessages = 20
  ): ConversationMessageRecord[] {
    const committed: ConversationMessageRecord[] = [];
    for (const record of this.records.values()) {
      if (
        record.tenantId === tenantId &&
        record.principalId === principalId &&
        record.sessionId === sessionId &&
        record.status === 'COMMITTED'
      ) {
        committed.push(record);
      }
    }

    committed.sort(compareConversationMessages);

    if (committed.length > maxMessages) {
      return committed.slice(committed.length - maxMessages);
    }

    return committed;
  }

  public redact(
    messageId: string,
    tenantId: string,
    principalId: string
  ): ConversationMessageRecord | null {
    const record = this.get(messageId, tenantId, principalId);
    if (!record) return null;

    record.status = 'REDACTED';
    record.updatedAt = this.now();

    try {
      this.fileStore.writeOrThrow(messageId, record);
    } catch (error) {
      throw new NagexError({
        code: 'CONVERSATION_PERSIST_FAILED',
        category: 'RUNTIME',
        message: `Failed to persist redacted message: ${error instanceof Error ? error.message : String(error)}`,
        request_id: record.requestId ?? `req_${Date.now()}`,
      });
    }

    return record;
  }

  public deleteSession(
    tenantId: string,
    principalId: string,
    sessionId: string
  ): number {
    const toDelete: string[] = [];
    for (const record of this.records.values()) {
      if (
        record.tenantId === tenantId &&
        record.principalId === principalId &&
        record.sessionId === sessionId
      ) {
        toDelete.push(record.messageId);
      }
    }

    for (const id of toDelete) {
      this.fileStore.remove(id);
      this.records.delete(id);
    }

    return toDelete.length;
  }
}
