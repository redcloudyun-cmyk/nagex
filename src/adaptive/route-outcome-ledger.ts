// What NAgex has actually SEEN a route do: recent successes and failures (by class), the median latency of recent successes, and the moment its quota was last seen exhausted.
//
// This is the "reliability evidence" of a route candidate. It is observation, not belief: with too few samples it says nothing (see MIN_RELIABILITY_SAMPLES), it never carries a quality judgement, and
// it holds no content - only route ids, counters, failure classes and timestamps, so it is safe to keep across restarts and to share between people (a provider's quota is the same for everyone using
// NAgex's credential). A route whose quota was seen exhausted is kept out for a cool-down, so the next goal does not start by calling the account that just said no.
import { createHash } from 'node:crypto';
import { FileRecordStore, resolveNagexDataDir } from '../governance/file-record.store.js';
import type { RouteReliability } from './route-candidate.js';

interface LedgerRecord {
  routeId: string;
  /** the most recent outcomes, oldest first, capped */
  recent: Array<{ ok: boolean; at: string; failureClass: string | null; latencyMs: number | null }>;
  quotaExhaustedAt: string | null;
  updatedAt: string;
}

const MAX_RECENT = 30;

function isLedgerRecord(value: unknown): value is LedgerRecord {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.routeId === 'string' && Array.isArray(v.recent) && typeof v.updatedAt === 'string';
}

const idFor = (routeId: string): string => `rl_${createHash('sha256').update(routeId).digest('hex').slice(0, 20)}`;

export class RouteOutcomeLedger {
  private readonly store: FileRecordStore<LedgerRecord>;
  private readonly cache = new Map<string, LedgerRecord>();
  private readonly now: () => number;

  constructor(options: { dir?: string; now?: () => number } = {}) {
    this.store = new FileRecordStore<LedgerRecord>(options.dir ?? resolveNagexDataDir('adaptive', 'NAGEX_ADAPTIVE_DIR') + '/ledger', isLedgerRecord);
    this.now = options.now ?? Date.now;
  }

  private load(routeId: string): LedgerRecord {
    const cached = this.cache.get(routeId);
    if (cached) return cached;
    const stored = this.store.read(idFor(routeId));
    const record: LedgerRecord = stored && stored.routeId === routeId ? stored : { routeId, recent: [], quotaExhaustedAt: null, updatedAt: new Date(this.now()).toISOString() };
    this.cache.set(routeId, record);
    return record;
  }

  private persist(record: LedgerRecord): void {
    record.updatedAt = new Date(this.now()).toISOString();
    this.store.write(idFor(record.routeId), record);
  }

  public recordSuccess(routeId: string, latencyMs?: number): void {
    const record = this.load(routeId);
    record.recent.push({ ok: true, at: new Date(this.now()).toISOString(), failureClass: null, latencyMs: typeof latencyMs === 'number' && Number.isFinite(latencyMs) ? Math.round(latencyMs) : null });
    if (record.recent.length > MAX_RECENT) record.recent.splice(0, record.recent.length - MAX_RECENT);
    // a success proves the quota is back
    record.quotaExhaustedAt = null;
    this.persist(record);
  }

  public recordFailure(routeId: string, failureClass: string): void {
    const record = this.load(routeId);
    const at = new Date(this.now()).toISOString();
    record.recent.push({ ok: false, at, failureClass, latencyMs: null });
    if (record.recent.length > MAX_RECENT) record.recent.splice(0, record.recent.length - MAX_RECENT);
    if (failureClass === 'QUOTA_EXHAUSTED' || failureClass === 'BILLING_REQUIRED') record.quotaExhaustedAt = at;
    this.persist(record);
  }

  /** the person (or an operator) says the quota is back: the route is no longer kept out */
  public clearQuota(routeId: string): void {
    const record = this.load(routeId);
    record.quotaExhaustedAt = null;
    this.persist(record);
  }

  public reliabilityOf(routeId: string): RouteReliability | null {
    const record = this.load(routeId);
    if (record.recent.length === 0) return null;
    const failures = record.recent.filter((r) => !r.ok);
    const latencies = record.recent.filter((r) => r.ok && r.latencyMs !== null).map((r) => r.latencyMs as number).sort((a, b) => a - b);
    const last = failures[failures.length - 1];
    return {
      successes: record.recent.length - failures.length,
      failures: failures.length,
      lastFailureClass: last?.failureClass ?? null,
      lastFailureAt: last?.at ?? null,
      medianLatencyMs: latencies.length > 0 ? latencies[Math.floor(latencies.length / 2)] : null,
    };
  }

  public quotaExhaustedAt(routeId: string): string | null {
    return this.load(routeId).quotaExhaustedAt;
  }
}
