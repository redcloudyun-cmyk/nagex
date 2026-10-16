// "Deployed" is only ever said after this: the address answers, it serves THIS build (the marker NAgex stamped into the page), and the product's own checks pass in an isolated browser at that address.
// A hosting provider that accepted the files is not proof of any of that (a parked domain, an old build, a login wall and a CDN that has not caught up all answer "200").
import net from 'node:net';
import type { DeployVerifierPort } from '../product-builder.ports.js';
import type { DeploymentRecord, SiteCheck } from '../product-builder.types.js';
import type { SiteTesterPort } from '../product-builder.ports.js';

export interface HttpDeployVerifierOptions {
  /** how often to look (a new deployment can take a short while to be served everywhere) */
  attempts?: number;
  delayMs?: number;
  requestTimeoutMs?: number;
  /** tests only: a loopback or private address is accepted. Real runs never set it. */
  allowLocal?: boolean;
}

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const kind = net.isIP(h);
  if (kind === 4) {
    const [a, b] = h.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h === '::';
  return false;
}

export class HttpDeployVerifier implements DeployVerifierPort {
  private readonly attempts: number;
  private readonly delayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly allowLocal: boolean;

  constructor(private readonly tester: SiteTesterPort | null, options: HttpDeployVerifierOptions = {}) {
    this.attempts = options.attempts ?? 10;
    this.delayMs = options.delayMs ?? 3000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.allowLocal = options.allowLocal === true;
  }

  public async verify(input: { url: string; marker: string; checks: SiteCheck[] }): Promise<NonNullable<DeploymentRecord['verification']>> {
    const unverified = (status: number | null, reachable = false, markerFound = false): NonNullable<DeploymentRecord['verification']> => ({ reachable, status, markerFound, smokePassed: false, checkedAt: new Date().toISOString() });
    let url: URL;
    try { url = new URL(input.url); } catch { return unverified(null); }
    if (url.protocol !== 'https:' && !(this.allowLocal && url.protocol === 'http:')) return unverified(null);
    if (!this.allowLocal && isPrivateHost(url.hostname)) return unverified(null);

    let status: number | null = null;
    let reachable = false;
    let markerFound = false;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      try {
        const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(this.requestTimeoutMs), headers: { 'user-agent': 'NAgex-deploy-verifier', accept: 'text/html' } });
        status = response.status;
        reachable = response.ok;
        const body = reachable ? (await response.text()).slice(0, 2_000_000) : '';
        markerFound = body.includes(input.marker);
        if (reachable && markerFound) break;
      } catch {
        status = null; reachable = false; markerFound = false;
      }
      if (attempt < this.attempts - 1) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (!reachable || !markerFound || !this.tester) return unverified(status, reachable, markerFound);

    // the product's own checks, in the isolated browser, at the deployed address
    let smokePassed = false;
    try {
      const report = await this.tester.run({ source: { url: url.toString() }, checks: input.checks, widths: [1280, 390], screenshotsDir: null });
      smokePassed = report.passed;
    } catch { smokePassed = false; }
    return { reachable, status, markerFound, smokePassed, checkedAt: new Date().toISOString() };
  }
}
