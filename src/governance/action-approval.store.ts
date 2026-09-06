import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';

export type ActionApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED' | 'EXPIRED';

export interface ActionApprovalRecord {
  id: string;
  toolId: string;
  tenantId: string;
  principalId: string;
  payload: Record<string, unknown>;
  status: ActionApprovalStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  consumedAt: string | null;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes to act on an approval

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

function payloadsMatchExactly(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

export class ActionApprovalStore {
  private readonly records = new Map<string, ActionApprovalRecord>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  public request(input: { toolId: string; tenantId: string; principalId: string; payload: Record<string, unknown> }): ActionApprovalRecord {
    const record: ActionApprovalRecord = {
      id: generateResourceId('apr'),
      toolId: input.toolId,
      tenantId: input.tenantId,
      principalId: input.principalId,
      payload: canonicalize(input.payload) as Record<string, unknown>,
      status: 'PENDING',
      createdAt: getCurrentISOString(),
      expiresAt: new Date(this.now() + this.ttlMs).toISOString(),
      approvedAt: null,
      consumedAt: null,
    };
    this.records.set(record.id, record);
    return record;
  }

  private getLive(id: string, requestId: string): ActionApprovalRecord {
    const record = this.records.get(id);
    if (!record) {
      throw new NagexError({ code: 'APPROVAL_NOT_FOUND', category: 'NOT_FOUND', message: `Approval ${id} was not found.`, request_id: requestId });
    }
    if (record.status === 'PENDING' && new Date(record.expiresAt).getTime() <= this.now()) {
      record.status = 'EXPIRED';
    }
    return record;
  }

  public approve(id: string, requestId = 'apr_approve'): ActionApprovalRecord {
    const record = this.getLive(id, requestId);
    if (record.status === 'EXPIRED') {
      throw new NagexError({ code: 'APPROVAL_EXPIRED', category: 'POLICY', message: `Approval ${id} has expired.`, request_id: requestId });
    }
    if (record.status !== 'PENDING') {
      throw new NagexError({ code: 'APPROVAL_NOT_PENDING', category: 'CONFLICT', message: `Approval ${id} is ${record.status}, not pending.`, request_id: requestId });
    }
    record.status = 'APPROVED';
    record.approvedAt = getCurrentISOString();
    return record;
  }

  public reject(id: string, requestId = 'apr_reject'): ActionApprovalRecord {
    const record = this.getLive(id, requestId);
    if (record.status !== 'PENDING') {
      throw new NagexError({ code: 'APPROVAL_NOT_PENDING', category: 'CONFLICT', message: `Approval ${id} is ${record.status}, not pending.`, request_id: requestId });
    }
    record.status = 'REJECTED';
    return record;
  }

  public get(id: string): ActionApprovalRecord | undefined {
    return this.records.get(id);
  }

  // Verifies the approval is APPROVED, unexpired, unconsumed, bound to the
  // given tool, and that the exact payload being executed matches the exact
  // payload that was approved. On success, marks it CONSUMED so it can never
  // be replayed. Throws a distinct NagexError code for every failure mode.
  public consume(id: string, toolId: string, payload: Record<string, unknown>, requestId: string): ActionApprovalRecord {
    const record = this.getLive(id, requestId);

    if (record.toolId !== toolId) {
      throw new NagexError({ code: 'APPROVAL_TOOL_MISMATCH', category: 'VALIDATION', message: `Approval ${id} was not requested for tool ${toolId}.`, request_id: requestId });
    }
    if (record.status === 'EXPIRED') {
      throw new NagexError({ code: 'APPROVAL_EXPIRED', category: 'POLICY', message: `Approval ${id} has expired.`, request_id: requestId });
    }
    if (record.status === 'CONSUMED') {
      throw new NagexError({ code: 'APPROVAL_ALREADY_CONSUMED', category: 'CONFLICT', message: `Approval ${id} has already been executed and cannot be replayed.`, request_id: requestId });
    }
    if (record.status !== 'APPROVED') {
      throw new NagexError({ code: 'APPROVAL_NOT_GRANTED', category: 'POLICY', message: `Approval ${id} is ${record.status}, not approved.`, request_id: requestId });
    }
    if (!payloadsMatchExactly(record.payload, payload)) {
      throw new NagexError({ code: 'APPROVAL_PAYLOAD_MISMATCH', category: 'VALIDATION', message: `The requested action does not exactly match what was approved.`, request_id: requestId });
    }

    record.status = 'CONSUMED';
    record.consumedAt = getCurrentISOString();
    return record;
  }
}
