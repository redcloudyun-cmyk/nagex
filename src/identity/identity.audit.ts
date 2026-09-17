// R13 Identity & Account Lifecycle — Security Audit Event Store
import { generateResourceId } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { IdentityAuditEvent, IdentityAuditEventType } from './identity.types.js';

export function isIdentityAuditEvent(value: unknown): value is IdentityAuditEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.eventId === 'string' &&
    typeof v.timestamp === 'string' &&
    typeof v.userId === 'string' &&
    typeof v.eventType === 'string' &&
    typeof v.result === 'string'
  );
}

export interface IdentityAuditStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class IdentityAuditStore {
  private readonly events: IdentityAuditEvent[] = [];
  private readonly fileStore: FileRecordStore<IdentityAuditEvent>;
  private readonly now: () => string;

  constructor(options: IdentityAuditStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('identity-audit', 'NAGEX_IDENTITY_AUDIT_DIR', env);
    this.fileStore = new FileRecordStore<IdentityAuditEvent>(dir, isIdentityAuditEvent);
    this.now = options.now ?? (() => new Date().toISOString());
    this.events = this.fileStore.readAll().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  public recordEvent(
    userId: string,
    eventType: IdentityAuditEventType,
    result: 'SUCCESS' | 'FAILURE' = 'SUCCESS',
    meta: { sessionId?: string | null; ip?: string | null; userAgent?: string | null; details?: Record<string, unknown> } = {}
  ): IdentityAuditEvent {
    const event: IdentityAuditEvent = {
      eventId: generateResourceId('aud'),
      timestamp: this.now(),
      userId,
      sessionId: meta.sessionId || null,
      eventType,
      ip: meta.ip || null,
      userAgent: meta.userAgent || null,
      result,
      details: meta.details,
    };
    this.events.push(event);
    this.fileStore.write(event.eventId, event);
    return event;
  }

  public listForUser(userId: string): IdentityAuditEvent[] {
    return this.events.filter((e) => e.userId === userId);
  }
}
