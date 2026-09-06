import crypto from 'node:crypto';
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';

export type ActionApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED' | 'EXPIRED';

export interface ActionApprovalRecord {
  approvalId: string;
  toolId: string;
  tenantId: string;
  principalId: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: ActionApprovalStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  usedAt: string | null;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes to act on an approval

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

export class ActionApprovalStore {
  private readonly records = new Map<string, ActionApprovalRecord>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  public request(input: { toolId: string; tenantId: string; principalId: string; payload: Record<string, unknown> }): ActionApprovalRecord {
    const canonicalPayload = canonicalize(input.payload) as Record<string, unknown>;
    const record: ActionApprovalRecord = {
      approvalId: generateResourceId('apr'),
      toolId: input.toolId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      payload: canonicalPayload,
      payloadHash: hashCanonicalPayload(canonicalPayload),
      status: 'PENDING',
      createdAt: getCurrentISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      approvedAt: null,
      usedAt: null,
    };
    this.records.set(record.approvalId, record);
    return record;
  }

  private getLive(approvalId: string, requestId: string): ActionApprovalRecord {
    const record = this.records.get(approvalId);
    if (!record) {
      throw new NagexError({ code: 'APPROVAL_NOT_FOUND', category: 'NOT_FOUND', message: `Approval ${approvalId} was not found.`, request_id: requestId });
    }
    if (record.status === 'PENDING' && new Date(record.expiresAt).getTime() <= this.now()) {
      record.status = 'EXPIRED';
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
    return record;
  }

  public reject(approvalId: string, requestId = 'apr_reject'): ActionApprovalRecord {
    const record = this.getLive(approvalId, requestId);
    if (record.status !== 'PENDING') {
      throw new NagexError({ code: 'APPROVAL_NOT_PENDING', category: 'CONFLICT', message: `Approval ${approvalId} is ${record.status}, not pending.`, request_id: requestId });
    }
    record.status = 'REJECTED';
    return record;
  }

  public get(approvalId: string): ActionApprovalRecord | undefined {
    return this.records.get(approvalId);
  }

  // Verifies the approval is APPROVED, unexpired, unused, bound to the given
  // tool, and that the exact payload being executed hashes to the same value
  // as the payload that was approved. On success, marks it consumed (usedAt
  // set, status CONSUMED) atomically so it can never be replayed. Throws a
  // distinct NagexError code for every failure mode.
  public consume(approvalId: string, toolId: string, payload: Record<string, unknown>, requestId: string): ActionApprovalRecord {
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

    // Single synchronous statement pair, no intervening await — atomic with
    // respect to this single-threaded event loop, so two concurrent execute
    // calls can never both observe status !== 'CONSUMED' and both proceed.
    record.status = 'CONSUMED';
    record.usedAt = getCurrentISOString();
    return record;
  }
}
