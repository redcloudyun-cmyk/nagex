// SCRIPTED STAND-INS for the Product Builder's ports, used to pin the workflow (gates, bindings, blocks, recovery). None of these is evidence of a real provider: the planning model, image
// provider, coding engine and hosting account are separate live checks, reported on their own. The deploy target here is a local HTTP server that serves the files it was given.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import type { CodingEnginePort, DeployOutcome, DeployPort, DeployTarget, DeployVerifierPort, ImplementOutcome, MockupOutcome, MockupPort, PlanningPort, SiteTesterPort } from '../src/product-builder/product-builder.ports.js';
import type { BuildPlan, DesignSpec, ProductPlan, SiteCheck, TestReport } from '../src/product-builder/product-builder.types.js';
import { routeIdOf, type RouteCandidate } from '../src/adaptive/route-candidate.js';

// A STAND-IN for a generated picture: a plain wireframe (header bar, three cards, a table) drawn by this file - NOT the output of any image model. It exists so tests have a real, valid PNG to show.
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) { c ^= buf[i]; for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return ~c >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
export function wireframePng(width = 480, height = 300): Buffer {
  const paint = (x: number, y: number): [number, number, number] => {
    if (y < 36) return [37, 99, 235];                                       // header bar
    const inCard = y >= 52 && y < 112 && ((x >= 16 && x < 150) || (x >= 173 && x < 307) || (x >= 330 && x < 464));
    if (inCard) return (y === 52 || y === 111 || (x % 157 === 16) || (x % 157 === 149)) ? [203, 213, 225] : [255, 255, 255];   // summary cards
    if (y >= 130 && x >= 16 && x < 464) return (y - 130) % 34 < 2 ? [203, 213, 225] : (y - 130) % 68 < 34 ? [255, 255, 255] : [248, 250, 252];   // table rows
    return [241, 245, 249];                                                  // page
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) { const [r, g, b] = paint(x, y); const o = y * (width * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}
export const STAND_IN_PNG = wireframePng();
/** kept for the tests that only need "some valid PNG" */
export const TINY_PNG = STAND_IN_PNG;

export const PLAN: ProductPlan = {
  summary: 'A customer management website', audience: 'a small business owner',
  pages: [{ id: 'customers', title: 'Customers', purpose: 'Browse and search customers' }, { id: 'dashboard', title: 'Dashboard', purpose: 'See totals' }],
  features: [{ id: 'search', title: 'Search', detail: 'Find a customer by name' }],
  dataModel: [{ entity: 'Customer', fields: ['name', 'email'] }], nonGoals: ['payments'], assumptions: ['sample data'], openQuestions: [],
};
export const DESIGN: DesignSpec = {
  layout: 'sidebar + content', typography: { heading: 'system-ui bold', body: 'system-ui', scale: '16/20/28' }, colors: { primary: '#2563eb', background: '#ffffff' },
  components: ['table', 'search box', 'stat cards'], navigation: 'left sidebar', responsive: { breakpoints: ['390', '768', '1280'], notes: 'sidebar collapses' }, states: ['empty', 'no results'],
};
export const CHECKS: SiteCheck[] = [
  { id: 'c1', description: 'The customers table is shown', kind: 'ELEMENT_PRESENT', selector: '#customers' },
  { id: 'c2', description: 'Searching narrows the list', kind: 'SEARCH_FILTERS', inputSelector: '#search', query: 'han', expectText: 'Hanbit', hideText: 'Daon' },
];

export class FakePlanning implements PlanningPort {
  public calls: string[] = [];
  public failWith: Error | null = null;
  async draftPlan(input: { feedback: string | null; previous: ProductPlan | null }): Promise<ProductPlan> {
    this.calls.push(`plan:${input.feedback ?? ''}`);
    if (this.failWith) throw this.failWith;
    return { ...PLAN, summary: input.feedback ? `${PLAN.summary} (changed: ${input.feedback})` : PLAN.summary };
  }
  public failDesign: Error | null = null;
  async draftDesign(input: { feedback: string | null }): Promise<DesignSpec> {
    this.calls.push(`design:${input.feedback ?? ''}`);
    if (this.failDesign) throw this.failDesign;
    return { ...DESIGN, layout: input.feedback ? `${DESIGN.layout} (changed: ${input.feedback})` : DESIGN.layout };
  }
  async draftBuildPlan(input: { feedback: string | null }): Promise<BuildPlan> {
    this.calls.push(`build:${input.feedback ?? ''}`);
    return {
      engine: { id: 'model-says-something-else', kind: 'made-up', note: 'the model describes an engine that does not exist' }, framework: 'Next.js with Postgres', database: 'Postgres',
      deployTarget: { provider: 'made-up-host', kind: 'serverless' }, costEstimate: { usd: 0, note: 'free' }, credentialsNeeded: [], steps: ['write files', 'test', 'deploy'], testChecks: CHECKS,
    };
  }
}

export class FakeMockups implements MockupPort {
  public calls = 0;
  /** OK, or the way this stand-in fails: QUOTA / AUTH / REFUSED / TRANSIENT (a short outage that passes after `transientFailures` calls) / EMPTY / BAD_IMAGE (a "200" that is not an image) */
  public outcome: 'OK' | 'QUOTA' | 'EMPTY' | 'AUTH' | 'REFUSED' | 'TRANSIENT' | 'UNCERTAIN' = 'OK';
  public transientFailures = 1;
  public isAvailable = true;
  /** the company behind this stand-in: two stand-ins with the same vendor share data-handling terms */
  constructor(public readonly providerId: string = 'mock-image-provider', public readonly vendorId: string = providerId, public maxSensitivity: 'S0' | 'S1' | 'S2' | 'S3' = 'S1') {}
  available(): boolean { return this.isAvailable; }
  readonly route = (): RouteCandidate => ({
    routeId: routeIdOf('IMAGE_GENERATION', this.providerId, null), capability: 'IMAGE_GENERATION', provider: this.providerId, model: null, label: this.providerId,
    inputs: ['TEXT'], outputs: ['IMAGE'], limits: { aspectRatios: ['16:9'], maxReferenceImages: 0 },
    auth: this.isAvailable ? 'CONFIGURED' : 'UNCONFIGURED', availability: this.isAvailable ? 'AVAILABLE' : 'UNAVAILABLE', quota: 'UNKNOWN', quotaExhaustedAt: null,
    cost: { usd: null, unknown: true, basis: 'UNKNOWN' },
    dataHandling: { processing: 'THIRD_PARTY_CLOUD', vendorId: this.vendorId, maxSensitivity: this.maxSensitivity, region: null },
    approval: { required: true, reason: 'test stand-in' }, executionRoute: 'API', reliability: null,
  });
  async generate(): Promise<MockupOutcome> {
    this.calls += 1;
    if (this.outcome === 'QUOTA') return { ok: false, code: 'IMAGE_QUOTA_EXCEEDED', need: 'QUOTA', providerCode: 'PROVIDER_QUOTA_EXCEEDED', httpStatus: 429, message: `The image provider (${this.providerId}) has no quota left for pictures.` };
    if (this.outcome === 'AUTH') return { ok: false, code: 'IMAGE_PROVIDER_AUTH_FAILED', need: 'CREDENTIAL', providerCode: 'PROVIDER_AUTH_FAILED', httpStatus: 401, message: `The image provider (${this.providerId}) rejected NAgex's credential.` };
    if (this.outcome === 'REFUSED') return { ok: false, code: 'IMAGE_CONTENT_REJECTED', need: 'PERSON', providerCode: 'CONTENT_REJECTED', message: `The image provider (${this.providerId}) declined to draw this.` };
    if (this.outcome === 'UNCERTAIN') return { ok: false, code: 'IMAGE_GENERATION_FAILED', need: 'PERSON', providerCode: 'TIMEOUT', message: `The image provider (${this.providerId}) did not answer.`, chargeable: true };
    if (this.outcome === 'TRANSIENT' && this.calls <= this.transientFailures) return { ok: false, code: 'IMAGE_GENERATION_FAILED', need: 'PERSON', providerCode: 'PROVIDER_UNAVAILABLE_ERROR', httpStatus: 503, message: `The image provider (${this.providerId}) is briefly unavailable.`, chargeable: false };
    if (this.outcome === 'EMPTY') return { ok: true, images: [] };
    return { ok: true, images: [1, 2, 3].map((n) => ({ caption: `Home screen, variant ${n}`, mimeType: 'image/png', data: TINY_PNG, width: 480, height: 300 })) };
  }
}

export function siteFiles(overrides: Record<string, string> = {}): Array<{ path: string; content: string }> {
  return [
    { path: 'index.html', content: overrides['index.html'] ?? '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Customers</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="styles.css"></head><body><input id="search"><ul id="customers"><li>Hanbit</li><li>Daon</li></ul><script src="app.js"></script></body></html>' },
    { path: 'styles.css', content: overrides['styles.css'] ?? 'body{font-family:system-ui}' },
    { path: 'app.js', content: overrides['app.js'] ?? 'document.getElementById("search").addEventListener("input",function(){var q=this.value.toLowerCase();document.querySelectorAll("#customers li").forEach(function(li){li.style.display=li.textContent.toLowerCase().indexOf(q)>=0?"":"none"})});' },
  ];
}

export class FakeEngine implements CodingEnginePort {
  public calls: Array<{ repairHints: string[]; hadPrevious: boolean }> = [];
  public isAvailable = true;
  public files: () => Array<{ path: string; content: string }> = () => siteFiles();
  constructor(public readonly engineId = 'mock-engine', public readonly kind = 'one-shot static generator (test double)') {}
  available(): boolean { return this.isAvailable; }
  async implement(input: { previousFiles: unknown[] | null; repairHints: string[] }): Promise<ImplementOutcome> {
    this.calls.push({ repairHints: input.repairHints, hadPrevious: Boolean(input.previousFiles) });
    return { ok: true, files: this.files() };
  }
}

export class FakeTester implements SiteTesterPort {
  public readonly isolation = 'scripted test double';
  public runs = 0;
  /** one entry per run; the last one repeats */
  public results: boolean[] = [true];
  async run(input: { checks: SiteCheck[] }): Promise<TestReport> {
    const passed = this.results[Math.min(this.runs, this.results.length - 1)];
    this.runs += 1;
    return { ranAt: new Date().toISOString(), passed, checks: input.checks.map((c) => ({ id: c.id, description: c.description, passed, detail: passed ? 'ok' : 'did not hold' })), screenshots: [], consoleErrors: [], blockedRequests: 0 };
  }
}

/** a "hosting account" that is a local HTTP server serving the files it was given */
export class FakeDeployer implements DeployPort {
  public calls = 0;
  public isConfigured = true;
  public mode: 'OK' | 'UNCERTAIN' | 'REFUSED' | 'WRONG_CONTENT' = 'OK';
  private servers: http.Server[] = [];
  constructor(public readonly adapterId = 'mock-hosting', public readonly provider = 'mock-host') {}
  configured(): boolean { return this.isConfigured; }
  describeTarget(appName: string): DeployTarget {
    return { provider: this.provider, adapterId: this.adapterId, appName, account: 'test-account', exposure: 'PUBLIC', costLimitUsd: 0, envSecretNames: [], database: 'none', rollback: 'delete the project at the host' };
  }
  async deploy(input: { workspaceDir: string }): Promise<DeployOutcome> {
    this.calls += 1;
    if (this.mode === 'UNCERTAIN') return { ok: false, code: 'DEPLOY_TIMEOUT', need: 'PERSON', message: 'The hosting provider did not answer; the site may or may not have been created.', uncertain: true };
    if (this.mode === 'REFUSED') return { ok: false, code: 'HOST_REFUSED', need: 'AUTHORIZATION', message: 'The hosting provider refused the credentials.' };
    const wrong = this.mode === 'WRONG_CONTENT';
    const server = http.createServer((req, res) => {
      const rel = (req.url ?? '/').split('?')[0].replace(/^\/+/, '') || 'index.html';
      const file = path.join(input.workspaceDir, ...rel.split('/'));
      if (wrong || !file.startsWith(input.workspaceDir) || !fs.existsSync(file)) { res.writeHead(wrong ? 200 : 404, { 'content-type': 'text/html' }); res.end(wrong ? '<html><body>Parked domain</body></html>' : 'not found'); return; }
      res.writeHead(200, { 'content-type': rel.endsWith('.html') ? 'text/html' : rel.endsWith('.js') ? 'text/javascript' : 'text/css' });
      res.end(fs.readFileSync(file));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    this.servers.push(server);
    return { ok: true, deployId: `dep_${this.calls}`, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
  }
  async close(): Promise<void> { for (const s of this.servers) await new Promise<void>((resolve) => s.close(() => resolve())); this.servers = []; }
}

/** fetches the address and looks for the marker; the smoke part is a flag (a real browser check is the real verifier's job) */
export class FetchVerifier implements DeployVerifierPort {
  public smoke = true;
  async verify(input: { url: string; marker: string }): Promise<{ reachable: boolean; status: number | null; markerFound: boolean; smokePassed: boolean; checkedAt: string }> {
    try {
      const response = await fetch(input.url);
      const body = await response.text();
      return { reachable: response.ok, status: response.status, markerFound: body.includes(input.marker), smokePassed: this.smoke, checkedAt: new Date().toISOString() };
    } catch {
      return { reachable: false, status: null, markerFound: false, smokePassed: false, checkedAt: new Date().toISOString() };
    }
  }
}
