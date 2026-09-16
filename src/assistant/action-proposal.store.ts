// R11 — persistent, durable Action Proposals. A proposal is a grounded,
// reviewable suggestion generated from a real Daily Brief change (never
// speculative, never auto-executed) — DETECT -> PROPOSE -> HUMAN REVIEW ->
// APPROVE -> EXECUTE -> AUDIT. Built on FileRecordStore exactly like
// DailyBriefStore/ActivityStore/PersistentActionApprovalStore (no new
// persistence mechanism), one JSON file per proposal, tenant/principal
// ownership-gated on every mutating method (same pattern as CandidateStore/
// ActionApprovalStore's requireOwned()).
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { NagexError } from '../common/errors.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';

export type ActionProposalType =
  | 'CALENDAR_RESCHEDULE'
  | 'EMAIL_REPLY_DRAFT'
  | 'CREATE_TASK'
  | 'FOLLOW_UP'
  | 'REVIEW_APPROVAL'
  | 'CREATE_AUTOMATION';

export type ActionProposalStatus =
  | 'PROPOSED'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'EXPIRED';

export type ActionProposalRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type ActionProposalSourceType = 'CALENDAR' | 'GMAIL' | 'APPROVAL' | 'ACTION_ITEM';

export interface ActionProposalFailure {
  errorCode: string;
  message: string;
  failedAt: string;
  retryable: boolean;
}

export interface ActionProposalResult {
  targetId?: string;
  externalUrl?: string;
}

export interface ActionProposalRecord {
  id: string;
  tenantId: string;
  principalId: string;
  sourceType: ActionProposalSourceType;
  sourceId: string;
  proposalType: ActionProposalType;
  title: string;
  summary: string;
  rationale: string;
  // A structured, tool-agnostic description of what approving this would
  // do — built ONLY from already-grounded data (§3), never fabricated.
  proposedAction: Record<string, unknown>;
  riskLevel: ActionProposalRiskLevel;
  approvalRequired: boolean;
  // §6 — whether this proposal type has a real, wired execution path at
  // all. false means "review only" (e.g. REVIEW_APPROVAL just points at an
  // existing pending approval; EMAIL_REPLY_DRAFT lacks a real recipient/
  // subject to compose from without fabricating one) — the UI must never
  // offer an Execute affordance when this is false.
  executable: boolean;
  status: ActionProposalStatus;
  date: string; // YYYY-MM-DD — the Daily Brief date this was generated from
  dedupeKey: string; // proposal:{tenant}:{principal}:{date}:{sourceType}:{sourceId}:{proposalType}
  approvalId?: string | null; // ActionApprovalStore id, once a real external approval has been requested
  result?: ActionProposalResult | null;
  failure?: ActionProposalFailure | null;
  createdAt: string;
  updatedAt: string;
}

export function isActionProposalRecord(value: unknown): value is ActionProposalRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.tenantId === 'string' &&
    typeof v.principalId === 'string' &&
    typeof v.sourceType === 'string' &&
    typeof v.sourceId === 'string' &&
    typeof v.proposalType === 'string' &&
    typeof v.title === 'string' &&
    typeof v.status === 'string' &&
    typeof v.date === 'string' &&
    typeof v.dedupeKey === 'string' &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string'
  );
}

export interface CreateActionProposalInput {
  tenantId: string;
  principalId: string;
  sourceType: ActionProposalSourceType;
  sourceId: string;
  proposalType: ActionProposalType;
  title: string;
  summary: string;
  rationale: string;
  proposedAction: Record<string, unknown>;
  riskLevel: ActionProposalRiskLevel;
  approvalRequired: boolean;
  executable: boolean;
  date: string;
}

export interface ActionProposalStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

const OPEN_STATUSES = new Set<ActionProposalStatus>(['PROPOSED', 'APPROVED', 'EXECUTING']);

export class ActionProposalStore {
  private readonly records = new Map<string, ActionProposalRecord>();
  private readonly fileStore: FileRecordStore<ActionProposalRecord>;
  private readonly now: () => string;

  constructor(options: ActionProposalStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('action-proposals', 'NAGEX_ACTION_PROPOSALS_DIR', env);
    this.fileStore = new FileRecordStore<ActionProposalRecord>(dir, isActionProposalRecord);
    this.now = options.now ?? (() => getCurrentISOString());
    for (const record of this.fileStore.readAll()) this.records.set(record.id, record);
  }

  private persist(record: ActionProposalRecord): ActionProposalRecord {
    record.updatedAt = this.now();
    this.records.set(record.id, record);
    this.fileStore.write(record.id, record);
    return record;
  }

  public buildDedupeKey(tenantId: string, principalId: string, date: string, sourceType: ActionProposalSourceType, sourceId: string, proposalType: ActionProposalType): string {
    return `proposal:${tenantId}:${principalId}:${date}:${sourceType}:${sourceId}:${proposalType}`;
  }

  // §9 — idempotent creation: the caller (the generator, called on every
  // Daily Brief regeneration) always looks this up first via the same
  // dedupeKey; create() itself does not de-dupe so it stays a pure "insert
  // a new record" primitive the same way TaskStore.create()/CandidateStore
  // internals do, with the actual dedupe decision made once, explicitly, by
  // the caller (see action-proposal-generator.ts).
  public create(input: CreateActionProposalInput): ActionProposalRecord {
    const timestamp = this.now();
    const dedupeKey = this.buildDedupeKey(input.tenantId, input.principalId, input.date, input.sourceType, input.sourceId, input.proposalType);
    const record: ActionProposalRecord = {
      id: generateResourceId('prop'),
      tenantId: input.tenantId,
      principalId: input.principalId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      proposalType: input.proposalType,
      title: input.title,
      summary: input.summary,
      rationale: input.rationale,
      proposedAction: input.proposedAction,
      riskLevel: input.riskLevel,
      approvalRequired: input.approvalRequired,
      executable: input.executable,
      status: 'PROPOSED',
      date: input.date,
      dedupeKey,
      approvalId: null,
      result: null,
      failure: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.persist(record);
  }

  public findByDedupeKey(tenantId: string, principalId: string, dedupeKey: string): ActionProposalRecord | undefined {
    for (const record of this.records.values()) {
      if (record.tenantId === tenantId && record.principalId === principalId && record.dedupeKey === dedupeKey) return record;
    }
    return undefined;
  }

  public get(id: string, tenantId: string, principalId: string): ActionProposalRecord | undefined {
    const record = this.records.get(id);
    if (!record || record.tenantId !== tenantId || record.principalId !== principalId) return undefined;
    return record;
  }

  public listForDate(tenantId: string, principalId: string, date: string): ActionProposalRecord[] {
    return [...this.records.values()]
      .filter((r) => r.tenantId === tenantId && r.principalId === principalId && r.date === date)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  public listPending(tenantId: string, principalId: string): ActionProposalRecord[] {
    return [...this.records.values()]
      .filter((r) => r.tenantId === tenantId && r.principalId === principalId && OPEN_STATUSES.has(r.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private requireOwned(id: string, tenantId: string, principalId: string, requestId: string): ActionProposalRecord {
    const record = this.get(id, tenantId, principalId);
    if (!record) {
      throw new NagexError({ code: 'ACTION_PROPOSAL_NOT_FOUND', category: 'NOT_FOUND', message: `Action proposal ${id} was not found.`, request_id: requestId });
    }
    return record;
  }

  public updateStatus(
    id: string,
    tenantId: string,
    principalId: string,
    patch: { status: ActionProposalStatus; approvalId?: string | null; result?: ActionProposalResult | null; failure?: ActionProposalFailure | null },
    requestId = 'action_proposal_update',
  ): ActionProposalRecord {
    const record = this.requireOwned(id, tenantId, principalId, requestId);
    record.status = patch.status;
    if (patch.approvalId !== undefined) record.approvalId = patch.approvalId;
    if (patch.result !== undefined) record.result = patch.result;
    if (patch.failure !== undefined) record.failure = patch.failure;
    return this.persist(record);
  }
}
