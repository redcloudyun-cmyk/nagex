// R23.6E — durable run-record persistence. A run spans multiple separate
// HTTP requests (start -> [later] approve/reject -> [later] send result),
// so its state must survive between requests the same way ActionApprovalStore
// records do — FileRecordStore-backed, same pattern as every other
// multi-step-lifecycle store in the codebase.
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { isE2EAgentRunStatus, type CompetitorPricingRunRecord } from './competitor-pricing-email.types.js';
import { isUntrustedPricingEvidence } from './untrusted-evidence.normalizer.js';

export function isCompetitorPricingRunRecord(value: unknown): value is CompetitorPricingRunRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.runId === 'string'
    && typeof v.tenantId === 'string'
    && typeof v.ownerId === 'string'
    && typeof v.requestId === 'string'
    && typeof v.competitor === 'string'
    && (v.targetUrl === null || typeof v.targetUrl === 'string')
    && (v.recipientEmail === null || typeof v.recipientEmail === 'string')
    && isE2EAgentRunStatus(v.status)
    && (v.failureReason === null || typeof v.failureReason === 'string')
    && Array.isArray(v.evidence) && v.evidence.every(isUntrustedPricingEvidence)
    && (v.change === null || typeof v.change === 'object')
    && (v.reportSubject === null || typeof v.reportSubject === 'string')
    && (v.reportBody === null || typeof v.reportBody === 'string')
    && (v.draftPayload === null || typeof v.draftPayload === 'object')
    && (v.draftId === null || typeof v.draftId === 'string')
    && (v.approvalId === null || typeof v.approvalId === 'string')
    && (v.executionId === null || typeof v.executionId === 'string')
    && typeof v.createdAt === 'string'
    && typeof v.updatedAt === 'string';
}

export interface CompetitorPricingRunStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

export class CompetitorPricingRunStore {
  private readonly fileStore: FileRecordStore<CompetitorPricingRunRecord>;
  private readonly now: () => string;

  constructor(options: CompetitorPricingRunStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('competitor-pricing-runs', 'NAGEX_COMPETITOR_PRICING_RUNS_DIR', env);
    this.fileStore = new FileRecordStore<CompetitorPricingRunRecord>(dir, isCompetitorPricingRunRecord);
    this.now = options.now ?? getCurrentISOString;
  }

  public create(input: { tenantId: string; ownerId: string; requestId: string; competitor: string; targetUrl: string | null; recipientEmail: string | null }): CompetitorPricingRunRecord {
    const timestamp = this.now();
    const record: CompetitorPricingRunRecord = {
      runId: generateResourceId('cpr'),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      requestId: input.requestId,
      competitor: input.competitor,
      targetUrl: input.targetUrl,
      recipientEmail: input.recipientEmail,
      status: 'RESEARCHING',
      failureReason: null,
      evidence: [],
      change: null,
      reportSubject: null,
      reportBody: null,
      draftPayload: null,
      draftId: null,
      approvalId: null,
      executionId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.fileStore.write(record.runId, record);
    return record;
  }

  public get(runId: string): CompetitorPricingRunRecord | undefined {
    return this.fileStore.read(runId) ?? undefined;
  }

  // Same tenant/owner ownership-isolation contract as every other
  // getOwned() in the codebase — cross-tenant/cross-owner access is
  // indistinguishable from a nonexistent run.
  public getOwned(runId: string, tenantId: string, ownerId: string): CompetitorPricingRunRecord | undefined {
    const record = this.get(runId);
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) return undefined;
    return record;
  }

  public save(record: CompetitorPricingRunRecord): CompetitorPricingRunRecord {
    const updated: CompetitorPricingRunRecord = { ...record, updatedAt: this.now() };
    this.fileStore.write(updated.runId, updated);
    return updated;
  }
}
