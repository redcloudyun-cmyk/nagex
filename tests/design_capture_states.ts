// Design evidence tool (not part of the gates): Home in conversation state (multi-turn, briefing collapsed, My Day), and the Connections modal /
// review step / drawer, EN and KR at 1440x900.   DESIGN_LABEL=before|after DESIGN_OUT=<dir> node ... design_capture_states.js
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { startCanvasAskHarness } from './_canvas_ask_harness.js';
import { githubTokenStore } from '../src/integrations/github/token.store.js';

declare const document: any;
const LABEL = process.env.DESIGN_LABEL || 'before';
const OUT = process.env.DESIGN_OUT || path.join(process.cwd(), 'artifacts', 'design-v2');
const ANSWER = ['## Weekend plan', '', 'Here is a relaxed plan for **Saturday**:', '', '- Morning: farmers market and coffee', '- Afternoon: the new exhibition at the art museum', '- Evening: dinner with friends', '', 'Want me to add any of these to your calendar?'].join('\n');

it('states capture', async () => {
  fs.mkdirSync(OUT, { recursive: true });
  process.env.NAGEX_MCP_ALLOW_PRIVATE_NETWORK = '1';
  process.env.GITHUB_CLIENT_ID = 'x'; process.env.GITHUB_CLIENT_SECRET = 'y'; process.env.GITHUB_REDIRECT_URI = 'https://x/cb';
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
  for (const locale of ['en', 'ko'] as const) {
    const user = h.user(`state_${locale}`);
    if (locale === 'ko') h.setLocale(user, 'ko');
    githubTokenStore.saveForPrincipal(user.tenantId, user.userId, { accessToken: 'gho_x', refreshToken: null, expiresAt: null, scope: 'read:user,repo', tokenType: 'bearer' }, { login: 'octocat', id: 1 });
    const base = await h.newContext('desktop', user, locale);
    const ctx = await h.browser.newContext({ viewport: { width: 1440, height: 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
    await ctx.addCookies(await base.cookies());
    await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* ignore */ } }, locale);
    await base.close();
    const page = await ctx.newPage();
    await page.route('**/api/v1/ai/chat', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { message: ANSWER, messageId: 'm1' }, requestId: 'r1' }) }));
    await page.goto(`${h.origin}/#home`);
    await page.waitForSelector('#nagex-main-surface');
    await page.waitForTimeout(800);
    await page.fill('#main-surface-input', locale === 'ko' ? '이번 주말에 뭐 하면 좋을까?' : 'What should I do this weekend?');
    await page.click('#main-send');
    await page.waitForSelector('.main-turn[data-kind="answer"]', { timeout: 15000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `${LABEL}-conversation-${locale}.png`) });
    // Connections (after only: the redesign did not exist in the oldest state, but exists in both worktrees used here)
    await page.route('**/api/v1/mcp/servers', (route) => { if (route.request().method() !== 'POST') return route.continue(); const b = JSON.parse(route.request().postData() || '{}'); b.url = mcpUrl; return route.continue({ postData: JSON.stringify(b) }); });
    await page.goto(`${h.origin}/#settings/connections`);
    await page.reload();
    await page.waitForSelector('#nagex-conn-add');
    await page.click('#nagex-conn-add');
    await page.fill('#nagex-conn-layer input[name="name"]', 'Docs MCP');
    await page.fill('#nagex-conn-layer input[name="url"]', 'https://docs.example.com/mcp');
    await page.screenshot({ path: path.join(OUT, `${LABEL}-mcp-modal-${locale}.png`) });
    await page.click('#nagex-conn-layer button[type="submit"]');
    await page.waitForSelector('#nagex-conn-layer [data-act="tool-toggle"]');
    await page.locator('#nagex-conn-layer [data-act="tool-toggle"]').first().click();
    await page.screenshot({ path: path.join(OUT, `${LABEL}-mcp-review-${locale}.png`) });
    await page.locator('#nagex-conn-layer [data-act="tool-confirm"]').click();
    await page.waitForFunction(() => document.querySelector('#nagex-conn-layer [role="switch"]')?.getAttribute('aria-checked') === 'true');
    await page.locator('#nagex-conn-layer [data-act="close-layer"]').last().click();
    await page.locator('.nagex-conn-card.mine').filter({ hasText: 'Docs MCP' }).locator('button').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${LABEL}-mcp-drawer-${locale}.png`) });
    await ctx.close();
  }
  await h.close();
  mcp.close();
  globalThis.fetch = orig;
});
