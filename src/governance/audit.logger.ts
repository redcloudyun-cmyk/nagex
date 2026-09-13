import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';

export interface AuditEventRecord {
  audit_id: string;
  timestamp: string;
  actor: { type: string; id: string };
  tenant_id: string;
  action: string;
  resource: { type: string; id: string };
  result: 'SUCCESS' | 'DENIED' | 'PENDING_APPROVAL' | 'FAILED';
  reason_code?: string;
  request_id: string;
  correlation_id?: string;
  details?: Record<string, unknown>;
}

const SENSITIVE_DETAIL_KEYS = new Set(['secret', 'password', 'token', 'raw_cot']);

// Recursively strips sensitive keys at any depth without mutating the input
// (Rule 12/18: Secret/Token/Raw CoT must never reach the audit store).
function sanitizeDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeDetails);
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_DETAIL_KEYS.has(key)) continue;
      result[key] = sanitizeDetails(val);
    }
    return result;
  }
  return value;
}

export class AuditLogger {
  private auditStore: AuditEventRecord[] = [];

  public logEvent(event: Omit<AuditEventRecord, 'audit_id' | 'timestamp'>): AuditEventRecord {
    const auditRecord: AuditEventRecord = {
      ...event,
      details: event.details ? (sanitizeDetails(event.details) as Record<string, unknown>) : undefined,
      audit_id: generateResourceId('aud'),
      timestamp: getCurrentISOString(),
    };

    this.auditStore.push(auditRecord);
    return auditRecord;
  }

  // Audit Route Tenant Scoping Correction — `limit` is optional and
  // backward-compatible: existing single-argument callers keep getting the
  // tenant's entire history in original insertion order, unchanged. Only
  // when a limit is supplied does this apply the same slice(-limit)
  // .reverse() newest-first semantic getRecentLogs() uses — but AFTER
  // filtering by tenant, never before, so another tenant's volume can
  // never reduce or reorder this tenant's own latest-N result.
  public getAuditLogs(tenantId: string, limit?: number): AuditEventRecord[] {
    const filtered = this.auditStore.filter(log => log.tenant_id === tenantId);
    if (limit === undefined) return filtered;
    if (limit <= 0) return [];
    return filtered.slice(-limit).reverse();
  }

  public getRecentLogs(limit: number): AuditEventRecord[] {
    if (limit <= 0) return [];
    return this.auditStore.slice(-limit).reverse();
  }
}
