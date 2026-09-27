// R23.6E Decision 4 — durable baseline persistence. Uses the same
// FileRecordStore-backed, in-memory-cache-plus-disk pattern already proven
// by BrowserSessionStore/DailyBriefStore (one JSON file per record,
// survives process restart) — never an in-memory-only map, which would
// silently lose "what changed since last time" on every deploy/restart.
import { generateResourceId, getCurrentISOString } from '../common/utils.js';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import { computeDimensionKey } from './pricing-comparability.js';
import type { CompetitorPricingBaselineRecord } from './competitor-pricing-email.types.js';

export function isCompetitorPricingBaselineRecord(value: unknown): value is CompetitorPricingBaselineRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.baselineId === 'string'
    && typeof v.tenantId === 'string'
    && typeof v.ownerId === 'string'
    && typeof v.competitor === 'string'
    && typeof v.dimensionKey === 'string'
    && (v.planName === null || typeof v.planName === 'string')
    && (v.currency === null || typeof v.currency === 'string')
    && (v.billingPeriod === null || typeof v.billingPeriod === 'string')
    && (v.region === null || typeof v.region === 'string')
    && (v.taxIncluded === null || typeof v.taxIncluded === 'boolean')
    && typeof v.price === 'number'
    && typeof v.sourceUrl === 'string'
    && typeof v.retrievedAt === 'string'
    && typeof v.verifiedAt === 'string'
    && typeof v.createdAt === 'string';
}

export interface CompetitorPricingBaselineStoreOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
}

// One record per (tenantId, ownerId, competitor, dimensionKey) — the "most
// recent verified snapshot" for that exact comparable dimension
// combination. A different plan/currency/billing-period/region gets its
// own independent baseline, never overwritten by an incomparable one.
export class CompetitorPricingBaselineStore {
  private readonly records = new Map<string, CompetitorPricingBaselineRecord>();
  private readonly fileStore: FileRecordStore<CompetitorPricingBaselineRecord>;
  private readonly now: () => string;

  constructor(options: CompetitorPricingBaselineStoreOptions = {}) {
    const env = options.env ?? process.env;
    const dir = options.dir ?? resolveNagexDataDir('competitor-pricing-baselines', 'NAGEX_COMPETITOR_PRICING_BASELINES_DIR', env);
    this.fileStore = new FileRecordStore<CompetitorPricingBaselineRecord>(dir, isCompetitorPricingBaselineRecord);
    this.now = options.now ?? getCurrentISOString;
    for (const record of this.fileStore.readAll()) {
      this.records.set(this.key(record.tenantId, record.ownerId, record.competitor, record.dimensionKey), record);
    }
  }

  private key(tenantId: string, ownerId: string, competitor: string, dimensionKey: string): string {
    return `${tenantId}::${ownerId}::${competitor.trim().toLowerCase()}::${dimensionKey}`;
  }

  // Tenant/owner-scoped lookup — a cross-tenant or cross-owner id mismatch
  // returns undefined, identical to a genuinely nonexistent baseline, same
  // pattern as BrowserSessionStore.getOwned / every other isolation-checked
  // store in the codebase.
  public getOwned(tenantId: string, ownerId: string, competitor: string, dimensionKey: string): CompetitorPricingBaselineRecord | undefined {
    const record = this.records.get(this.key(tenantId, ownerId, competitor, dimensionKey));
    if (!record || record.tenantId !== tenantId || record.ownerId !== ownerId) return undefined;
    return record;
  }

  // Replaces (never appends to) the baseline for this exact dimension
  // combination — R23.6E only ever needs "the previous verified snapshot",
  // never a full history.
  public upsertVerified(input: {
    tenantId: string;
    ownerId: string;
    competitor: string;
    planName: string | null;
    currency: string | null;
    billingPeriod: string | null;
    region: string | null;
    taxIncluded: boolean | null;
    price: number;
    sourceUrl: string;
    retrievedAt: string;
  }): CompetitorPricingBaselineRecord {
    const dimensionKey = computeDimensionKey(input);
    const key = this.key(input.tenantId, input.ownerId, input.competitor, dimensionKey);
    const existing = this.records.get(key);
    const record: CompetitorPricingBaselineRecord = {
      baselineId: existing?.baselineId ?? generateResourceId('cpb'),
      tenantId: input.tenantId,
      ownerId: input.ownerId,
      competitor: input.competitor,
      dimensionKey,
      planName: input.planName,
      currency: input.currency,
      billingPeriod: input.billingPeriod,
      region: input.region,
      taxIncluded: input.taxIncluded,
      price: input.price,
      sourceUrl: input.sourceUrl,
      retrievedAt: input.retrievedAt,
      verifiedAt: this.now(),
      createdAt: existing?.createdAt ?? this.now(),
    };
    this.records.set(key, record);
    this.fileStore.write(record.baselineId, record);
    return record;
  }
}
