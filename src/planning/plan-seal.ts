import crypto from 'node:crypto';

// A reviewed plan is only ever run as the plan the person REVIEWED, for the person who reviewed it, once.
//
// When the plan route returns a plan preview, it seals it: planHash = sha256 of the plan's canonical form, and a token = HMAC(process secret, tenant | principal | hash | expiry).
// When the person later asks to run it, the server recomputes the hash from the plan it receives and verifies the token. A different owner, a changed argument / target /
// tool / step, an expired preview, or a preview issued by an earlier process (the secret is random per process) all fail with their own reason - nothing is resolved, no task
// or approval is created. A sealed plan can be claimed ONCE: the second click returns the first run instead of starting another. The seal grants no permission: it only
// proves "this is the plan that was shown". Permission, approval and execution stay with the existing PermissionDecisionService / ActionApprovalStore / CapabilityBroker.
export interface PlanSealIdentity { tenantId: string; principalId: string }
export interface PlanSealIssue { planHash: string; token: string; expiresAt: string }
export type PlanSealFailure = 'PLAN_SEAL_MISSING' | 'PLAN_SEAL_INVALID' | 'PLAN_SEAL_EXPIRED';
export interface PlanSealClaim { taskId: string; runId: string | null }

const DEFAULT_TTL_MS = 30 * 60_000;
const MAX_CLAIMS = 5000;

// stable, key-sorted JSON: the same plan always hashes the same, whatever the key order the client sends back
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

// Only the fields that define WHAT would be done: any change to them is a different plan.
export function reviewedPlanForm(plan: unknown): unknown {
  const p = (plan && typeof plan === 'object' ? plan : {}) as Record<string, unknown>;
  const steps = Array.isArray(p.steps) ? p.steps : [];
  return {
    goal: p.goal ?? null,
    summary: p.summary ?? null,
    steps: steps.map((raw) => {
      const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return { step: s.step ?? null, title: s.title ?? null, skill: s.skill ?? null, tool: s.tool ?? null, requiresApproval: s.requiresApproval ?? null, necessity: s.necessity ?? null, dependsOn: s.dependsOn ?? null, parameters: s.parameters ?? null };
    }),
  };
}

export function reviewedPlanHash(plan: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(reviewedPlanForm(plan))).digest('hex');
}

export class PlanSeal {
  private readonly key: Buffer;
  private readonly claims = new Map<string, PlanSealClaim & { tenantId: string; principalId: string }>();

  constructor(private readonly now: () => number = () => Date.now(), private readonly ttlMs: number = DEFAULT_TTL_MS, key?: Buffer) {
    this.key = key ?? crypto.randomBytes(32);
  }

  private mac(identity: PlanSealIdentity, planHash: string, expiresAtMs: number): string {
    return crypto.createHmac('sha256', this.key).update(`${identity.tenantId}|${identity.principalId}|${planHash}|${expiresAtMs}`).digest('base64url');
  }

  public seal(identity: PlanSealIdentity, plan: unknown): PlanSealIssue {
    const planHash = reviewedPlanHash(plan);
    const expiresAtMs = this.now() + this.ttlMs;
    return { planHash, token: `${expiresAtMs}.${this.mac(identity, planHash, expiresAtMs)}`, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  // Verifies the plan the caller sends back against the token that was issued for THIS owner. Never says which part was wrong beyond the reason code.
  public verify(identity: PlanSealIdentity, plan: unknown, token: unknown): { ok: true; planHash: string } | { ok: false; reason: PlanSealFailure } {
    if (typeof token !== 'string' || token.length < 10 || token.length > 200) return { ok: false, reason: 'PLAN_SEAL_MISSING' };
    const dot = token.indexOf('.');
    const expiresAtMs = Number(token.slice(0, dot));
    const given = token.slice(dot + 1);
    if (dot < 1 || !Number.isFinite(expiresAtMs)) return { ok: false, reason: 'PLAN_SEAL_INVALID' };
    const planHash = reviewedPlanHash(plan);
    const expected = this.mac(identity, planHash, expiresAtMs);
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'PLAN_SEAL_INVALID' };
    if (this.now() > expiresAtMs) return { ok: false, reason: 'PLAN_SEAL_EXPIRED' };
    return { ok: true, planHash };
  }

  // One run per reviewed plan and owner. Synchronous (no await between the check and the claim), so two concurrent clicks cannot both start.
  public claim(identity: PlanSealIdentity, planHash: string, claim: PlanSealClaim): { claimed: true } | { claimed: false; existing: PlanSealClaim } {
    const key = `${identity.tenantId}|${identity.principalId}|${planHash}`;
    const existing = this.claims.get(key);
    if (existing) return { claimed: false, existing: { taskId: existing.taskId, runId: existing.runId } };
    if (this.claims.size >= MAX_CLAIMS) this.claims.delete(this.claims.keys().next().value as string);
    this.claims.set(key, { ...claim, ...identity });
    return { claimed: true };
  }

  public attachRun(identity: PlanSealIdentity, planHash: string, taskId: string, runId: string | null): void {
    const key = `${identity.tenantId}|${identity.principalId}|${planHash}`;
    if (this.claims.has(key)) this.claims.set(key, { taskId, runId, ...identity });
  }

  // A claim whose run could not even be created is released so the person is not locked out by a server-side failure.
  public release(identity: PlanSealIdentity, planHash: string): void {
    this.claims.delete(`${identity.tenantId}|${identity.principalId}|${planHash}`);
  }
}

export const defaultPlanSeal = new PlanSeal();
