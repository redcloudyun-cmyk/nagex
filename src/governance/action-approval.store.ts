import crypto from 'node:crypto';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from './file-record.store.js';

export type ActionApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED' | 'EXPIRED';

export interface ActionApprovalRecord {
  approvalId: string;
  toolId: string;
  tenantId: string;
  principalId: string;
  canonicalPayload: Record<string, unknown>;
  payloadHash: string;
  status: ActionApprovalStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  usedAt: string | null;
  executionId: string | null;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes to act on an approval

// NAGEX_APPROVAL_TTL_SECONDS overrides the default; invalid/absent values
// fall back to the 15-minute default rather than throwing.
export function resolveApprovalTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NAGEX_APPROVAL_TTL_SECONDS?.trim();
  if (!raw) return DEFAULT_TTL_MS;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_TTL_MS;
}

// Deterministic key ordering so two objects with the same content in a
// different key order canonicalize (and therefore hash) identically.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => [key, canonicalize(val)]),
    );
  }
  return value;
}

export function hashCanonicalPayload(payload: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

export function isActionApprovalRecord(value: unknown): value is ActionApprovalRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.approvalId === 'string' &&
    typeof v.toolId === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.principalId === 'string' &&
    !!v.canonicalPayload && typeof v.canonicalPayload === 'object' &&
    typeof v.payloadHash === 'string' &&
    typeof v.status === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.expiresAt === 'string'
  );
}

export class ActionApprovalStore {
  protected readonly records = new Map<string, ActionApprovalRecord>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = resolveApprovalTtlMs(),
    private readonly onExpired?: (record: ActionApprovalRecord) => void,
  ) {}

  public request(input: { toolId: string; tenantId: string; principalId: string; payload: Record<string, unknown> }): ActionApprovalRecord {
    const canonicalPayload = canonicalize(input.payload) as Record<string, unknown>;
    const record: ActionApprovalRecord = {
      approvalId: generateResourceId('apr'),
      toolId: input.toolId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      canonicalPayload,
      payloadHash: hashCanonicalPayload(canonicalPayload),
      status: 'PENDING',
      createdAt: getCurrentISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      approvedAt: null,
      rejectedAt: null,
      usedAt: null,
      executionId: null,
    };
    this.records.set(record.approvalId, record);
    this.onChange(record);
    return record;
  }

  private getLive(approvalId: string, requestId: string): ActionApprovalRecord {
    const record = this.records.get(approvalId);
    if (!record) {
      throw new NagexError({
        code: 'APPROVAL_NOT_FOUND',
        category: 'NOT_FOUND',
        message: `Approval ${approvalId} was not found.`,
        request_id: requestId,
      });
    }

    const isExpirableStatus =
      record.status === 'PENDING' ||
      record.status === 'APPROVED';

    const isExpired =
      new Date(record.expiresAt).getTime() <= this.now();

    if (isExpirableStatus && isExpired) {
      record.status = 'EXPIRED';
      this.onChange(record);
      this.onExpired?.(record);
    }

    return record;
  }

  public approve(approvalId: string, requestId = 'apr_approve'): ActionApprovalRecord {
    const record = this.getLive(approvalId, requestId);
    if (record.status === 'EXPIRED') {
      throw new NagexError({ code: 'APPROVAL_EXPIRED', category: 'POLICY', message: `Approval ${approvalId} has expired.`, request_id: requestId });
    }
    if (record.status !== 'PENDING') {
      throw new NagexError({ code: 'APPROVAL_NOT_PENDING', category: 'CONFLICT', message: `Approval ${approvalId} is ${record.status}, not pending.`, request_id: requestId });
    }
    record.status = 'APPROVED';
    record.approvedAt = getCurrentISOString();
    this.onChange(record);
    return record;
  }

  public reject(approvalId: string, requestId = 'apr_reject'): ActionApprovalRecord {
    const record = this.getLive(approvalId, requestId);
    if (record.status !== 'PENDING') {
      throw new NagexError({ code: 'APPROVAL_NOT_PENDING', category: 'CONFLICT', message: `Approval ${approvalId} is ${record.status}, not pending.`, request_id: requestId });
    }
    record.status = 'REJECTED';
    record.rejectedAt = getCurrentISOString();
    this.onChange(record);
    return record;
  }

  public get(approvalId: string, requestId = 'apr_get'): ActionApprovalRecord | undefined {
    if (!this.records.has(approvalId)) return undefined;
    return this.getLive(approvalId, requestId);
  }

  // Verifies the approval is APPROVED, unexpired, unused, bound to the given
  // tool, and that the exact payload being executed hashes to the same value
  // as the payload that was approved. On success, marks it consumed (usedAt
  // set, status CONSUMED, executionId linked) atomically so it can never be
  // replayed. Throws a distinct NagexError code for every failure mode.
  public consume(approvalId: string, toolId: string, payload: Record<string, unknown>, requestId: string, executionId: string): ActionApprovalRecord {
    const record = this.getLive(approvalId, requestId);

    if (record.toolId !== toolId) {
      throw new NagexError({ code: 'APPROVAL_TOOL_MISMATCH', category: 'VALIDATION', message: `Approval ${approvalId} was not requested for tool ${toolId}.`, request_id: requestId });
    }
    if (record.status === 'EXPIRED') {
      throw new NagexError({ code: 'APPROVAL_EXPIRED', category: 'POLICY', message: `Approval ${approvalId} has expired.`, request_id: requestId });
    }
    if (record.status === 'CONSUMED') {
      throw new NagexError({ code: 'APPROVAL_ALREADY_CONSUMED', category: 'CONFLICT', message: `Approval ${approvalId} has already been used and cannot be replayed.`, request_id: requestId });
    }
    if (record.status !== 'APPROVED') {
      throw new NagexError({ code: 'APPROVAL_NOT_GRANTED', category: 'POLICY', message: `Approval ${approvalId} is ${record.status}, not approved.`, request_id: requestId });
    }
    if (hashCanonicalPayload(payload) !== record.payloadHash) {
      throw new NagexError({ code: 'APPROVAL_PAYLOAD_MISMATCH', category: 'VALIDATION', message: `The requested action does not exactly match what was approved.`, request_id: requestId });
    }

    // Single synchronous statement block, no intervening await — atomic with
    // respect to this single-threaded event loop, so two concurrent execute
    // calls can never both observe status !== 'CONSUMED' and both proceed.
    record.status = 'CONSUMED';
    record.usedAt = getCurrentISOString();
    record.executionId = executionId;
    this.onChange(record);
    return record;
  }

  // Hook for subclasses (PersistentActionApprovalStore) to persist a single
  // changed record to disk. No-op here.
  protected onChange(_record: ActionApprovalRecord): void {}

  protected restore(records: Iterable<ActionApprovalRecord>): void {
    for (const record of records) this.records.set(record.approvalId, record);
  }
}

export interface PersistentActionApprovalStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  onExpired?: (record: ActionApprovalRecord) => void;
}

// One JSON file per approval under NAGEX_APPROVALS_DIR (default
// /var/lib/nagex/approvals, falling back to a per-user data dir — see
// resolveNagexDataDir). Approval records never contain OAuth tokens or the
// Google client secret, so unlike the OAuth token store these files are
// plain JSON, not encrypted — just atomic writes with 0600 permissions.
export class PersistentActionApprovalStore extends ActionApprovalStore {
  private readonly fileStore: FileRecordStore<ActionApprovalRecord>;

  constructor(options: PersistentActionApprovalStoreOptions = {}) {
    const env = options.env ?? process.env;
    super(options.now ?? Date.now, resolveApprovalTtlMs(env), options.onExpired);
    const dir = options.dir ?? resolveNagexDataDir('approvals', 'NAGEX_APPROVALS_DIR', env);
    this.fileStore = new FileRecordStore<ActionApprovalRecord>(dir, isActionApprovalRecord);
    this.restore(this.fileStore.readAll());
  }

  protected onChange(record: ActionApprovalRecord): void {
    this.fileStore.write(record.approvalId, record);
  }
}
