// Design evidence tool for the V2 visual acceptance gate (not part of the test gates).
//   DESIGN_LABEL=before|after DESIGN_OUT=<dir> [DESIGN_BLOCK_FONTS=1] [NAGEX_TEST_BROWSER_CHANNEL=chrome] \
//     node --require ./dist/tests/_setup.js --test dist/tests/design_gate_tool.js
// Captures (1) Home idle and Apps & Connections, EN and KR, at 1440x900 and 1680x900, with a font-rendering report from the browser's own font
// matcher (CDP CSS.getPlatformFontsForNode) and the font network requests; (2) a sweep of the Settings sub-panels and legacy Desktop routes
// that V2 did NOT convert but whose shared classes (.btn-primary, .badge-status, .filter-pill, ...) it changed; (3) Mobile shell routes.
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
declare const localStorage: any;
declare const getComputedStyle: any;
declare const window: any;

const LABEL = process.env.DESIGN_LABEL || 'before';
const OUT = process.env.DESIGN_OUT || path.join(process.cwd(), 'artifacts', 'design-gate');
const ONLY_MAIN = process.env.DESIGN_ONLY_MAIN === '1';
const BLOCK_FONTS = process.env.DESIGN_BLOCK_FONTS === '1';
const SUFFIX = BLOCK_FONTS ? '-nofonts' : '';
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

// What the browser actually rendered: platform font names per element, via the DevTools font matcher.
async function platformFonts(page: Page, selector: string): Promise<Array<{ family: string; glyphs: number; custom: boolean }>> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const doc: any = await cdp.send('DOM.getDocument', { depth: 0 });
    const found: any = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
    if (!found.nodeId) return [];
    const res: any = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: found.nodeId });
    return (res.fonts || []).map((f: any) => ({ family: f.familyName, glyphs: f.glyphCount, custom: Boolean(f.isCustomFont) }));
  } catch { return []; } finally { await cdp.detach().catch(() => undefined); }
}

// Geometry the eye reads: card boxes, content column, whitespace, heading vs body type.
async function geometry(page: Page, cardSel: string, headingSel: string): Promise<Record<string, unknown>> {
  return page.evaluate(({ cardSel, headingSel }: { cardSel: string; headingSel: string }) => {
    const vis = (e: any) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const cards = [...document.querySelectorAll(cardSel)].filter(vis).map((e: any) => e.getBoundingClientRect());
    const main = document.querySelector('.tab-view.active-view, #nagex-main-surface') as any;
    const mr = main ? main.getBoundingClientRect() : null;
    const heads = [...document.querySelectorAll(headingSel)].filter(vis).slice(0, 1).map((e: any) => { const s = getComputedStyle(e); return { size: s.fontSize, weight: s.fontWeight }; });
    const body: Record<string, number> = {};
    const w = document.createTreeWalker(document.body, 4); let n: any;
    while ((n = w.nextNode())) { const el = n.parentElement; if (!el || !n.textContent.trim() || !vis(el)) continue; const s = getComputedStyle(el); const k = s.fontSize; body[k] = (body[k] || 0) + n.textContent.trim().length; }
    const sizes = Object.entries(body).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => k + ':' + v);
    const sb = document.querySelector('.sidebar') as any; const sr = sb ? sb.getBoundingClientRect() : null;
    return { cardCount: cards.length, cardWidthMedian: cards.length ? Math.round(cards.map((c: any) => c.width).sort((a: number, b: number) => a - b)[Math.floor(cards.length / 2)]) : 0, cardHeightAvg: cards.length ? Math.round(cards.reduce((a: number, c: any) => a + c.height, 0) / cards.length) : 0, cardHeightMin: cards.length ? Math.round(Math.min(...cards.map((c: any) => c.height))) : 0, cardHeightMax: cards.length ? Math.round(Math.max(...cards.map((c: any) => c.height))) : 0, contentColumn: mr ? { left: Math.round(mr.left), width: Math.round(mr.width) } : null, viewportWidth: window.innerWidth, emptyRightOfContentPx: mr ? Math.round(window.innerWidth - mr.right) : null, sidebar: sr ? { width: Math.round(sr.width), height: Math.round(sr.height) } : null, pageHeading: heads[0] || null, topFontSizesByChars: sizes };
  }, { cardSel, headingSel });
}

it('visual gate capture', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1';
  process.env.GITHUB_CLIENT_ID = 'gate'; process.env.GITHUB_CLIENT_SECRET = 'gate'; process.env.GITHUB_REDIRECT_URI = 'https://gate.invalid/cb';
  process.env.GOOGLE_CLIENT_ID = 'gate'; process.env.GOOGLE_CLIENT_SECRET = 'gate'; process.env.GOOGLE_REDIRECT_URI = 'https://gate.invalid/cb2';
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
  const report: Record<string, unknown> = { label: LABEL, blockFonts: BLOCK_FONTS, browser: process.env.NAGEX_TEST_BROWSER_CHANNEL || 'bundled-chromium' };

  async function openAs(label: string, locale: 'en' | 'ko', size: { width: number; height: number }) {
    const user = h.user(label);
    if (locale === 'ko') h.setLocale(user, 'ko');
    githubTokenStore.saveForPrincipal(user.tenantId, user.userId, { accessToken: 'gho_x', refreshToken: null, expiresAt: null, scope: 'read:user,repo', tokenType: 'bearer' }, { login: 'octocat', id: 1 });
    googleTokenStore.saveForPrincipal(user.tenantId, user.userId, { accessToken: 'ya', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, scope: GOOGLE_OAUTH_SCOPES.join(' ') });
    for (const [title, minutes] of [['Quarterly plan v2', 180], ['Launch checklist', 60], ['Trip itinerary', 1500]] as const) h.seedDocument(user, { title, content: `${title} body`, at: new Date(Date.now() - minutes * 60_000).toISOString() });
    const base = await h.newContext('desktop', user, locale);
    const ctx = await h.browser.newContext({ viewport: size, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
    await ctx.addCookies(await base.cookies());
    await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* ignore */ } }, locale);
    await base.close();
    const page = await ctx.newPage();
    const fontRequests: Array<{ url: string; status: number; bytes?: number }> = [];
    const fontBodies: Array<Promise<void>> = [];
    if (BLOCK_FONTS) await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
    page.on('response', (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) fontRequests.push({ url: r.url().replace(/\?.*$/, '').slice(0, 90), status: r.status() }); });
    page.on('requestfailed', (r) => { if (/fonts\.(googleapis|gstatic)\.com/.test(r.url())) fontRequests.push({ url: r.url().replace(/\?.*$/, '').slice(0, 90), status: 0 }); });
    await stubRichHome(page);
    return { ctx, page, user, fontRequests, fontBodies };
  }

  // (1) Home and Connections: EN and KR at 1440x900 and 1680x900
  for (const locale of ['en', 'ko'] as const) {
    for (const [width, height] of [[1440, 900], [1680, 900]] as const) {
      const { ctx, page, fontRequests, fontBodies } = await openAs(`gate_${locale}_${width}`, locale, { width, height });
      await page.route('**/api/v1/mcp/servers', (route) => { if (route.request().method() !== 'POST') return route.continue(); const b = JSON.parse(route.request().postData() || '{}'); b.url = mcpUrl; return route.continue({ postData: JSON.stringify(b) }); });
      await page.request.post(`${h.origin}/api/v1/mcp/servers`, { data: { name: 'Docs MCP', url: mcpUrl } });
      await page.goto(`${h.origin}/#home`);
      await page.reload();
      await page.waitForSelector('#nagex-main-surface');
      await page.waitForFunction(() => document.querySelector('#main-home-briefing')?.dataset.state === 'ready', undefined, { timeout: 20000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
      const key = `${locale}-${width}x${height}`;
      await page.screenshot({ path: path.join(OUT, `${LABEL}-gate-home-${key}${SUFFIX}.png`) });
      await Promise.all(fontBodies);
      const fontsStatus = await page.evaluate(() => [...document.fonts].filter((f: any) => f.status === 'loaded').map((f: any) => `${String(f.family).replace(/"/g, '')} ${f.weight}`));
      const fontsTotal = await page.evaluate(() => [...document.fonts].length);
      report[`home-${key}`] = {
        platformFontsGreeting: await platformFonts(page, '#main-greeting'),
        platformFontsSubtitle: await platformFonts(page, '#main-greeting-sub'),
        platformFontsBriefingCard: await platformFonts(page, '.main-briefing-card'),
        geometry: await geometry(page, '.main-briefing-card', '#main-greeting'),
        documentFontFacesDeclared: fontsTotal,
        documentFontFacesLoaded: fontsStatus.length,
        loadedFamiliesAndWeights: [...new Set(fontsStatus)].sort(),
        fontBytesTotal: fontRequests.reduce((a, r) => a + (r.bytes || 0), 0),
        fontNetwork: { requests: fontRequests.length, ok: fontRequests.filter((r) => r.status >= 200 && r.status < 300).length, failed: fontRequests.filter((r) => r.status === 0 || r.status >= 400).length, sample: fontRequests.slice(0, 4) },
      };
      if (BLOCK_FONTS && width === 1440) {
        const stack = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--nagex-font-ui'));
        await page.evaluate((s: string) => { document.documentElement.style.setProperty('--nagex-font-ui', s.replace(/Inter/g, 'NoSuchInter').replace(/Noto Sans KR/g, 'NoSuchNotoKR')); }, stack);
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, `${LABEL}-gate-home-${key}-simfallback.png`) });
        (report[`home-${key}`] as Record<string, unknown>).simulatedNoLocalFonts = { stack, greeting: await platformFonts(page, '#main-greeting'), subtitle: await platformFonts(page, '#main-greeting-sub'), body: await platformFonts(page, '.main-briefing-card') };
      }
      await page.goto(`${h.origin}/#settings/connections`);
      await page.reload();
      await page.waitForSelector('.nagex-conn-card', { timeout: 20000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT, `${LABEL}-gate-connections-${key}${SUFFIX}.png`) });
      report[`connections-${key}`] = {
        geometry: await geometry(page, '.nagex-conn-card', '.settings-page-heading h2, .view-header h2, h1'),
        platformFontsTitle: await platformFonts(page, '.settings-page-heading h2'),
        platformFontsCardTitle: await platformFonts(page, '.nagex-conn-card-title'),
      };
      await ctx.close();
    }
  }

  // (2) unconverted Settings sub-panels and legacy routes (EN, KR for the panels) at 1440x900, only when not blocking fonts
  if (!BLOCK_FONTS && !ONLY_MAIN) {
    const routes: Array<[string, string]> = [['settings-devices', '#settings/devices'], ['settings-permissions', '#settings/permissions'], ['settings-notifications', '#settings/notifications'], ['settings-personalization', '#settings/personalization'], ['settings-privacy', '#settings/privacy'], ['settings-appearance', '#settings/appearance'], ['settings-advanced', '#settings/advanced'], ['route-tasks', '#tasks'], ['route-vault', '#vault'], ['route-create', '#create'], ['route-canvas', '#canvas'], ['route-analyze', '#analyze'], ['route-my-space', '#my-space']];
    const active: Record<string, string> = {};
    for (const locale of ['en', 'ko'] as const) {
      const { ctx, page } = await openAs(`gate_routes_${locale}`, locale, { width: 1440, height: 900 });
      for (const [name, hash] of routes) {
        if (locale === 'ko' && !name.startsWith('settings-')) continue;
        await page.goto(`${h.origin}/${hash}`);
        await page.reload();
        await page.waitForTimeout(1500);
        active[`${name}-${locale}`] = await page.evaluate(() => [...document.querySelectorAll('.tab-view.active-view')].map((v: any) => v.id).join(','));
        await page.screenshot({ path: path.join(OUT, `${LABEL}-gate-${name}-${locale}.png`) });
      }
      await ctx.close();
    }
    report.activeViews = active;
    // (3) Mobile shell (390x844): the shared classes also exist there
    const mobileUser = h.user('gate_mobile');
    for (const locale of ['en', 'ko'] as const) {
      const user = h.user(`gate_mobile_${locale}`);
      if (locale === 'ko') h.setLocale(user, 'ko');
      h.seedDocument(user, { title: 'Quarterly plan v2', content: 'x', at: new Date().toISOString() });
      const ctx = await h.newContext('mobile', user, locale);
      const page = await ctx.newPage();
      await stubRichHome(page);
      for (const [name, hash] of [['mobile-home', '#home'], ['mobile-activity', '#activity'], ['mobile-inbox', '#inbox'], ['mobile-settings', '#settings']] as const) {
        if (locale === 'ko' && name !== 'mobile-home' && name !== 'mobile-settings') continue;
        await page.goto(`${h.origin}/${hash}`);
        await page.reload();
        await page.waitForTimeout(1500);
        await page.screenshot({ path: path.join(OUT, `${LABEL}-gate-${name}-${locale}.png`) });
      }
      await ctx.close();
    }
    void mobileUser;
  }
  fs.writeFileSync(path.join(OUT, `${LABEL}-gate-report${SUFFIX}.json`), JSON.stringify(report, null, 2));
  await h.close();
  mcp.close();
  globalThis.fetch = orig;
});
