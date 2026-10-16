// Deployment of a static site to Vercel through its official REST API (https://vercel.com/docs/rest-api), behind DeployPort.
//
// What is used, exactly as documented (fetched 2026-10-17):
//   POST /v13/deployments   body { name, files:[{file,data,encoding:"base64"}], target:"production", projectSettings:{framework:null,...} }   query: skipAutoDetectionConfirmation, teamId
//   GET  /v13/deployments/{idOrUrl}   response { id, url, alias[], readyState: BLOCKED|BUILDING|CANCELED|ERROR|INITIALIZING|QUEUED|READY, errorCode, errorMessage }
// Nothing else is assumed. Authentication is a bearer token the OPERATOR configures (NAGEX_VERCEL_TOKEN, optionally NAGEX_VERCEL_TEAM_ID); without it this adapter reports itself unconfigured and the
// project can still be built, tested and previewed - it just cannot be put online. The token is never logged, never placed in a result and never sent anywhere but the API base.
//
// Outcome honesty: a refusal is a typed block; a timeout or a server error AFTER the request was sent is `uncertain` (the deployment may exist) and is never repeated blindly. READY is the provider's
// word; whether the address really serves the product is decided by the verifier, not here.
import fs from 'node:fs';
import path from 'node:path';
import type { DeployOutcome, DeployPort } from '../product-builder.ports.js';
import type { DeployTarget } from '../product-builder.types.js';

export interface VercelDeployOptions {
  token?: string;
  teamId?: string;
  /** an operator setting (a regional endpoint, a local stand-in in tests); the token is sent there, so it is never taken from a request */
  apiBase?: string;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** tests only: a loopback address returned by a local stand-in is given as http://. Real runs never set it, and a real deployment address is always https. */
  allowLocalHttp?: boolean;
}

const TERMINAL_BAD = new Set(['ERROR', 'CANCELED']);

function sanitize(message: unknown): string {
  return String(message ?? '').replace(/\s+/g, ' ').replace(/[A-Za-z0-9_\-]{24,}/g, '[redacted]').slice(0, 240);
}

export class VercelDeployAdapter implements DeployPort {
  public readonly adapterId = 'vercel';
  public readonly provider = 'Vercel';
  private readonly token: string;
  private readonly teamId: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollMs: number;
  private readonly readyTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly allowLocalHttp: boolean;

  constructor(options: VercelDeployOptions = {}) {
    this.token = (options.token ?? process.env.NAGEX_VERCEL_TOKEN ?? '').trim();
    this.teamId = (options.teamId ?? process.env.NAGEX_VERCEL_TEAM_ID ?? '').trim();
    this.apiBase = (options.apiBase ?? process.env.NAGEX_VERCEL_API_BASE ?? 'https://api.vercel.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pollMs = options.pollMs ?? 3000;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 180_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.allowLocalHttp = options.allowLocalHttp === true;
  }

  public configured(): boolean {
    return this.token.length > 0;
  }

  public describeTarget(appName: string): DeployTarget {
    return {
      provider: this.provider,
      adapterId: this.adapterId,
      appName,
      account: this.teamId ? `Vercel team ${this.teamId}` : 'the Vercel account that owns the configured access token',
      exposure: 'PUBLIC',
      // NAgex does not control what the hosting plan costs and enforces no spending limit at the provider
      costLimitUsd: null,
      envSecretNames: [],
      database: 'none',
      rollback: 'Delete the project in your Vercel dashboard. NAgex does not delete anything at the provider for you.',
    };
  }

  private query(extra: Record<string, string> = {}): string {
    const params = new URLSearchParams(extra);
    if (this.teamId) params.set('teamId', this.teamId);
    const s = params.toString();
    return s ? `?${s}` : '';
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  public async deploy(input: { workspaceDir: string; files: Array<{ path: string; bytes: number }>; target: DeployTarget; requestId: string }): Promise<DeployOutcome> {
    if (!this.configured()) return { ok: false, code: 'DEPLOY_NOT_CONFIGURED', need: 'CREDENTIAL', message: 'No Vercel access token is configured for NAgex, so nothing was deployed.' };
    const root = path.resolve(input.workspaceDir);
    const files: Array<{ file: string; data: string; encoding: 'base64' }> = [];
    for (const f of input.files) {
      const full = path.resolve(path.join(root, ...f.path.split('/')));
      if (!full.startsWith(root + path.sep)) return { ok: false, code: 'DEPLOY_FILE_INVALID', need: 'PERSON', message: 'A file of the product is outside its workspace; nothing was deployed.' };
      files.push({ file: f.path, data: fs.readFileSync(full).toString('base64'), encoding: 'base64' });
    }
    const body = JSON.stringify({
      name: input.target.appName,
      files,
      target: 'production',
      // a plain static site: no framework, no build, files served from the root (null = detected automatically, per the documentation)
      projectSettings: { framework: null, buildCommand: null, devCommand: null, installCommand: null, outputDirectory: null },
    });

    let created: { id: string; url?: string; alias?: string[]; readyState?: string; errorCode?: string; errorMessage?: string | null };
    try {
      const response = await this.fetchImpl(`${this.apiBase}/v13/deployments${this.query({ skipAutoDetectionConfirmation: '1' })}`, { method: 'POST', headers: this.headers(), body, signal: AbortSignal.timeout(this.requestTimeoutMs) });
      const text = await response.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { json = null; }
      if (!response.ok) return this.refusal(response.status, json);
      if (!json || typeof json.id !== 'string') return { ok: false, code: 'HOST_RESPONSE_UNREADABLE', need: 'PERSON', message: 'Vercel answered, but not in the documented shape, so NAgex cannot tell whether the deployment exists. NAgex will not send it again; check your Vercel dashboard.', uncertain: true };
      created = json;
    } catch (error) {
      // the request left this computer: it may have been accepted
      const timedOut = error instanceof Error && /abort|timeout/i.test(error.name + error.message);
      return { ok: false, code: timedOut ? 'DEPLOY_TIMEOUT' : 'DEPLOY_NETWORK_ERROR', need: 'PERSON', message: 'Vercel did not answer; the deployment may or may not have been created. NAgex will not send it a second time: check your Vercel dashboard.', uncertain: true };
    }

    // wait for the provider to say it is ready (its word, not proof: the verifier checks the address)
    const deadline = Date.now() + this.readyTimeoutMs;
    let latest = created;
    while (latest.readyState !== 'READY') {
      if (latest.readyState && TERMINAL_BAD.has(latest.readyState)) {
        return { ok: false, code: latest.readyState === 'CANCELED' ? 'HOST_DEPLOY_CANCELED' : 'HOST_DEPLOY_FAILED', need: 'PERSON', message: `Vercel could not publish the site (${latest.readyState}${latest.errorCode ? `: ${sanitize(latest.errorCode)}` : ''}). ${sanitize(latest.errorMessage)}`.trim() };
      }
      if (Date.now() >= deadline) return { ok: false, code: 'DEPLOY_NOT_READY_IN_TIME', need: 'PERSON', message: 'Vercel accepted the deployment but it was not ready in time. NAgex will not send it again: check your Vercel dashboard.', uncertain: true };
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
      try {
        const response = await this.fetchImpl(`${this.apiBase}/v13/deployments/${encodeURIComponent(created.id)}${this.query()}`, { method: 'GET', headers: this.headers(), signal: AbortSignal.timeout(this.requestTimeoutMs) });
        if (response.ok) { const json: any = await response.json().catch(() => null); if (json && typeof json.id === 'string') latest = json; }
      } catch { /* a failed look is not a result: look again until the deadline */ }
    }
    return { ok: true, deployId: created.id, url: this.publicUrl(latest, created) };
  }

  /** the project's own address (an alias on *.vercel.app) when there is one, else the deployment's unique address */
  private publicUrl(latest: { url?: string; alias?: string[] }, created: { url?: string; alias?: string[] }): string {
    const hostPattern = this.allowLocalHttp ? /^[a-z0-9.-]+(:\d{2,5})?$/i : /^[a-z0-9.-]+$/i;
    const aliases = [...(latest.alias ?? []), ...(created.alias ?? [])].filter((a) => typeof a === 'string' && hostPattern.test(a));
    const vercelApp = aliases.filter((a) => a.endsWith('.vercel.app')).sort((a, b) => a.length - b.length)[0];
    const host = vercelApp ?? aliases[0] ?? latest.url ?? created.url ?? '';
    return this.allowLocalHttp && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) ? `http://${host}/` : `https://${host}/`;
  }

  private refusal(status: number, json: any): DeployOutcome {
    const reason = sanitize(json?.error?.message ?? json?.message);
    if (status === 401 || status === 403) return { ok: false, code: 'HOST_AUTH_FAILED', need: 'AUTHORIZATION', message: `Vercel did not accept NAgex's access token, or the token may not deploy to this account. ${reason}`.trim() };
    if (status === 402) return { ok: false, code: 'HOST_PAYMENT_REQUIRED', need: 'QUOTA', message: `The Vercel account needs a payment method or plan change before it can deploy. ${reason}`.trim() };
    if (status === 429) return { ok: false, code: 'HOST_RATE_LIMITED', need: 'QUOTA', message: 'Vercel is limiting requests right now. Nothing was deployed: try again later.' };
    if (status >= 500) return { ok: false, code: 'HOST_SERVER_ERROR', need: 'PERSON', message: `Vercel reported a server problem (${status}); the deployment may or may not have been created. NAgex will not send it a second time: check your Vercel dashboard.`, uncertain: true };
    return { ok: false, code: 'HOST_REQUEST_REJECTED', need: 'CONFIGURATION', message: `Vercel rejected the deployment request (${status}). ${reason}`.trim() };
  }
}
