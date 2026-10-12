// Design evidence tool (not part of the test gates): captures real-browser screenshots and measured typography/density metrics of Desktop
// Home (idle briefing + a conversation) and Apps & Connections, EN and KR, at 1440x900 / 1680x900 / 1920x1080.
//   DESIGN_LABEL=before|after DESIGN_OUT=<dir> node --require ./dist/tests/_setup.js --test dist/tests/design_capture_tool.js
// The metrics are measured from computed styles (never estimated): they back the before/after comparison in the design report.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import type { Page } from 'playwright';
import { startCanvasAskHarness } from './_canvas_ask_harness.js';
import { githubTokenStore } from '../src/integrations/github/token.store.js';
import { googleTokenStore } from '../src/integrations/google/token.store.js';
import { GOOGLE_OAUTH_SCOPES } from '../src/integrations/google/oauth.client.js';

declare const document: any;
declare const window: any;
declare const getComputedStyle: any;

const LABEL = process.env.DESIGN_LABEL || 'before';
const OUT = process.env.DESIGN_OUT || path.join(process.cwd(), 'artifacts', 'design-v2');
const SIZES: Array<[number, number]> = [[1440, 900], [1680, 900], [1920, 1080]];
const HOUR = 3600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

async function stubRichHome(page: Page): Promise<void> {
  await page.route('**/api/v1/personal/home', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const home = body.data || body;
    home.today = { ...(home.today || {}), meetings: [{ id: 'm1', title: 'Weekly sync with design', startsAt: iso(HOUR) }, { id: 'm2', title: 'Budget review', startsAt: iso(3 * HOUR) }] };
    home.needsAttention = [{ id: 'a1', type: 'APPROVAL', title: 'Approval Required: gmail.send_email', state: 'Needs approval', createdAt: iso(-HOUR) }];
    home.todo = { status: 'OK', items: [{ id: 't1', kind: 'REMINDER', title: 'Call the client back', dueAt: iso(2 * HOUR), state: 'Due today' }, { id: 't2', kind: 'REMINDER', title: 'Send the invoice', dueAt: iso(-HOUR), state: 'Overdue' }, { id: 't3', kind: 'TASK', title: 'Write the quarterly report', dueAt: null, state: 'Scheduled' }] };
    home.recentResults = [{ id: 'r1', type: 'DOCUMENT', title: 'Quarterly plan v2', state: 'Completed', createdAt: iso(-2 * HOUR), sourceId: 'a1' }, { id: 'r2', type: 'DAILY_BRIEF', title: 'Daily Brief generated', state: 'Completed', createdAt: iso(-3 * HOUR), sourceId: 'a2' }];
    home.suggestions = [{ id: 's1', kind: 'MEETING_PREP', title: 'Prepare for Budget review', reason: 'Your meeting starts in 15 minutes and I found 2 related items.', sourceRefs: [], action: { type: 'PREPARE', label: 'Prepare', requiresApproval: false }, generatedAt: new Date().toISOString() }];
    home.calendarConnection = { provider: 'google_calendar', state: 'CONNECTED', reason: null, retryable: false, scopes: [], missingScopes: [], connectPath: null, verifiedAt: new Date().toISOString(), message: '' };
    home.sourceStatus = { ...(home.sourceStatus || {}), calendar: 'CONNECTED', activity: 'OK' };
    await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body.data ? { ...body, data: home } : home) });
  });
}

// Measured from computed styles of the visible content (character-weighted).
async function metrics(page: Page, cardSelector: string): Promise<Record<string, unknown>> {
  return page.evaluate((sel: string) => {
    const vw = window.innerWidth; const vh = window.innerHeight;
    const sizes = new Map<number, number>(); const weights = new Map<number, number>();
    let chars = 0; let charsInViewport = 0; let heavy = 0; let shadows = 0; let gradients = 0; let elements = 0;
    const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */);
    const seen = new Set<any>();
    while (walker.nextNode()) {
      const node: any = walker.currentNode; const text = (node.textContent || '').trim();
      if (!text) continue;
      const el = node.parentElement; if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
      const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const size = Math.round(parseFloat(cs.fontSize)); const weight = parseInt(cs.fontWeight, 10) || 400;
      sizes.set(size, (sizes.get(size) || 0) + text.length); weights.set(weight, (weights.get(weight) || 0) + text.length);
      chars += text.length; if (weight >= 700) heavy += text.length;
      if (r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) charsInViewport += text.length;
      seen.add(el);
    }
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el); elements += 1;
      if (cs.boxShadow && cs.boxShadow !== 'none') shadows += 1;
      if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) gradients += 1;
    }
    const median = (map: Map<number, number>) => { const total = [...map.values()].reduce((a, b) => a + b, 0); let acc = 0; for (const [k, v] of [...map.entries()].sort((a, b) => a[0] - b[0])) { acc += v; if (acc >= total / 2) return k; } return 0; };
    const cards = [...document.querySelectorAll(sel)].map((el: any) => el.getBoundingClientRect()).filter((r: any) => r.width > 0);
    const body = getComputedStyle(document.body);
    return {
      viewport: [vw, vh], bodyFontSize: body.fontSize, bodyFontFamily: body.fontFamily.slice(0, 60),
      medianFontSizePx: median(sizes), medianFontWeight: median(weights), sizeHistogram: Object.fromEntries([...sizes.entries()].sort((a, b) => a[0] - b[0])),
      weightHistogram: Object.fromEntries([...weights.entries()].sort((a, b) => a[0] - b[0])),
      heavyTextPercent: chars ? Math.round((heavy / chars) * 1000) / 10 : 0, visibleChars: chars, charsInInitialViewport: charsInViewport,
      shadowedElements: shadows, gradientElements: gradients, visibleElements: elements,
      cardCount: cards.length, cardAvgHeight: cards.length ? Math.round(cards.reduce((a: number, r: any) => a + r.height, 0) / cards.length) : 0, cardMaxHeight: cards.length ? Math.round(Math.max(...cards.map((r: any) => r.height))) : 0,
      pageScrollOverflowY: Math.max(0, document.documentElement.scrollHeight - vh),
    };
  }, cardSelector);
}

it('design capture', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1';
  process.env.GITHUB_CLIENT_ID = 'cap'; process.env.GITHUB_CLIENT_SECRET = 'cap'; process.env.GITHUB_REDIRECT_URI = 'https://cap.invalid/cb';
  process.env.GOOGLE_CLIENT_ID = 'cap'; process.env.GOOGLE_CLIENT_SECRET = 'cap'; process.env.GOOGLE_REDIRECT_URI = 'https://cap.invalid/cb2';
  const mcp = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      const result = body.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'Docs MCP', version: '1.2' }, capabilities: {} }
        : { tools: [{ name: 'search_docs', description: 'Search the documentation.', inputSchema: { type: 'object', properties: {} } }, { name: 'create_ticket', description: 'Create a support ticket.', inputSchema: { type: 'object', properties: {} } }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => mcp.listen(0, '127.0.0.1', resolve));
  const mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => { const u = String(typeof input === 'string' || input instanceof URL ? input : input.url); if (/github\.com/.test(u)) return new Response(JSON.stringify({ login: 'octocat', id: 1 }), { status: 200 }); return orig(input, init); }) as typeof fetch;
  const h = await startCanvasAskHarness({ scrubProviders: true });
  const all: Record<string, unknown> = {};
  for (const locale of ['en', 'ko'] as const) {
    for (const [width, height] of SIZES) {
      const user = h.user(`cap_${locale}_${width}`);
      if (locale === 'ko') h.setLocale(user, 'ko');
      githubTokenStore.saveForPrincipal(user.tenantId, user.userId, { accessToken: 'gho_x', refreshToken: null, expiresAt: null, scope: 'read:user,repo', tokenType: 'bearer' }, { login: 'octocat', id: 1 });
      googleTokenStore.saveForPrincipal(user.tenantId, user.userId, { accessToken: 'ya', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: GOOGLE_OAUTH_SCOPES.join(' ') });
      const base = await h.newContext('desktop', user, locale);
      const ctx = await h.browser.newContext({ viewport: { width, height }, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
      await ctx.addCookies(await base.cookies());
      await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* ignore */ } }, locale);
      await base.close();
      const page = await ctx.newPage();
      await stubRichHome(page);
      await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#nagex-main-surface', { timeout: 20000 });
      await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready', undefined, { timeout: 20000 }).catch(() => undefined);
      await page.waitForTimeout(500);
      const key = `${locale}-${width}x${height}`;
      await page.screenshot({ path: path.join(OUT, `${LABEL}-home-${key}.png`) });
      console.log('CAP shot home', key);
      all[`home-${key}`] = await metrics(page, '.main-briefing-card');
      console.log('CAP metrics home', key);
      // Connections
      await page.route('**/api/v1/mcp/servers', (route) => { if (route.request().method() !== 'POST') return route.continue(); const b = JSON.parse(route.request().postData() || '{}'); b.url = mcpUrl; return route.continue({ postData: JSON.stringify(b) }); });
      console.log('CAP posting mcp');
      await page.request.post(`${h.origin}/api/v1/mcp/servers`, { data: { name: 'Docs MCP', url: mcpUrl } });
      await page.goto(`${h.origin}/#settings/connections`);
      await page.reload();
      await page.waitForSelector('#nagex-connections .nagex-conn-card, .settings-connection-card', { timeout: 20000 });
      await page.waitForTimeout(1200);
      console.log('CAP conn loaded');
      await page.screenshot({ path: path.join(OUT, `${LABEL}-connections-${key}.png`) });
      all[`connections-${key}`] = await metrics(page, '.nagex-conn-card, .settings-connection-card');
      await ctx.close();
    }
  }
  fs.writeFileSync(path.join(OUT, `${LABEL}-metrics.json`), JSON.stringify(all, null, 2));
  await h.close();
  mcp.close();
  globalThis.fetch = orig;
});
