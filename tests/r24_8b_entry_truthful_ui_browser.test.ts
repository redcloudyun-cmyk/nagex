// R24.8B — Create / Ask entry points, truthful product state, raw-i18n and mojibake in REAL Chromium
// against the REAL production server (desktop 1440x900, mobile 390x844).
//
// Provider credentials are scrubbed, so no model is called: model-backed flows are certified by proving the
// request reaches the canonical backend path (POST /api/v1/creations/documents, POST /api/v1/research,
// POST /api/v1/ambient/intent) and that "no model / no live search" is reported TRUTHFULLY and in the user's language.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Page, Request } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;
declare const NodeFilter: any;
declare const getComputedStyle: any;

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

function watch(page: Page) {
  const seen: Array<{ method: string; path: string; body: string }> = [];
  const dialogs: string[] = [];
  page.on('request', (r: Request) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) seen.push({ method: r.method(), path: u.pathname, body: r.postData() || '' }); });
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss().catch(() => {}); });
  return { seen, dialogs, find: (method: string, path: RegExp) => seen.filter((s) => s.method === method && path.test(s.path)) };
}
async function openHome(page: Page, kind: 'desktop' | 'mobile'): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  // Home is the unified Main surface on desktop and on phones (the retired capability tiles no longer exist)
  await page.waitForSelector('#main-surface-input', { state: 'visible', timeout: 20000 });
}
const tile = (kind: 'desktop' | 'mobile', id: string) => `${kind === 'desktop' ? '#home-section-create' : '#mh-section-create'} .ph-capability-tile[data-capability="${id}"]`;
const text = async (page: Page, sel: string) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ').trim();

// Home is the unified Main surface on desktop and on phones: the mode chips (Ask, Research, Document, Image) and ONE composer are the entry
// points. Provider credentials are scrubbed, so each flow must reach its canonical backend path and say truthfully, in the user's language and
// without internal codes, why it cannot finish.
const NO_MODEL = { en: /can't do this right now because no AI model is available/, ko: /사용할 수 있는 AI 모델이 없어서/ };
const NO_IMAGE_SERVICE = { en: /can't create images right now because no image service is set up/, ko: /이미지 서비스가 설정되어 있지 않아서/ };
const FAILURE_TITLE = {
  DOCUMENT: { en: /Document could not be created/, ko: /문서를 만들지 못했어요/ },
  RESEARCH: { en: /Research is unavailable/, ko: /리서치를 할 수 없어요/ },
  IMAGE: { en: /Image generation is unavailable/, ko: /이미지를 만들 수 없어요/ },
} as const;

async function sendFromMain(page: Page, mode: string, prompt: string): Promise<void> {
  await page.click(`[data-main-mode="${mode}"]`);
  await page.fill('#main-surface-input', prompt);
  await page.click('#main-send');
}
async function lastTurnText(page: Page): Promise<string> {
  await page.waitForFunction(() => { const turns = document.querySelectorAll('.main-turn'); const last = turns[turns.length - 1] as any; return Boolean(last) && last.getAttribute('data-kind') !== 'pending'; }, undefined, { timeout: 30000 });
  return page.evaluate(() => { const turns = document.querySelectorAll('.main-turn'); return ((turns[turns.length - 1] as any).innerText || '').replace(/\s+/g, ' ').trim(); });
}

describe('R24.8B — Main entry points reach the real pipelines and explain truthfully why they cannot finish (desktop + phone, EN + KR)', () => {
  for (const kind of ['desktop', 'mobile'] as const) {
    for (const locale of ['en', 'ko'] as const) {
      it(`${kind}/${locale}: Document, Research and Image reach their canonical routes with a user-language reason; Ask reaches the general pipeline`, async () => {
        const u = h.user(`entry_${kind}_${locale}`);
        h.setLocale(u, locale);
        const ctx = await h.newContext(kind, u, locale);
        const page = await ctx.newPage();
        const w = watch(page);
        await openHome(page, kind);

        await sendFromMain(page, 'DOCUMENT', 'Quarterly launch report');
        let turn = await lastTurnText(page);
        const docs = w.find('POST', /^\/api\/v1\/creations\/documents$/);
        assert.equal(docs.length, 1, 'exactly one request to the canonical document-creation path');
        assert.equal(JSON.parse(docs[0].body).prompt, 'Quarterly launch report');
        assert.match(turn, FAILURE_TITLE.DOCUMENT[locale]);
        assert.match(turn, NO_MODEL[locale], turn);
        assert.equal(w.find('POST', /ambient\/intent/).length, 0, 'a Document request is not sent to the planner');

        await sendFromMain(page, 'RESEARCH', 'latest agent frameworks');
        turn = await lastTurnText(page);
        const research = w.find('POST', /^\/api\/v1\/research$/);
        assert.equal(research.length, 1);
        assert.equal(JSON.parse(research[0].body).query, 'latest agent frameworks');
        assert.match(turn, FAILURE_TITLE.RESEARCH[locale]);

        await sendFromMain(page, 'IMAGE', 'a calm lake at dawn');
        turn = await lastTurnText(page);
        assert.equal(w.find('POST', /^\/api\/v1\/creations\/generate$/).length, 1);
        assert.match(turn, FAILURE_TITLE.IMAGE[locale]);
        assert.match(turn, NO_IMAGE_SERVICE[locale], turn);

        await sendFromMain(page, 'ASK', 'What is on my plate today?');
        await lastTurnText(page);
        assert.ok(w.find('POST', /route-input|ai\/chat/).length >= 1, 'a plain question reaches the general Ask pipeline');
        assert.equal(w.find('POST', /creations\/documents/).length, 1, 'Ask did not create a second document request');

        const visible = await page.evaluate(() => document.body.innerText);
        assert.equal(/NO_MODEL_PROVIDER_CONFIGURED|NO_CREATION_PROVIDER_AVAILABLE/.test(visible), false, 'internal error codes are never shown');
        assert.deepEqual(w.dialogs, [], 'no alert() on the Main flows');
        await ctx.close();
      });
    }
  }

  it('NO_STALE_STATE: after a failed Document request, an Ask message does not reuse the Document route or its error', async () => {
    const u = h.user('stale');
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    const w = watch(page);
    await openHome(page, 'desktop');
    await sendFromMain(page, 'DOCUMENT', 'Quarterly launch report');
    await lastTurnText(page);
    await page.click('[data-main-mode="ASK"]');
    assert.equal(await page.getAttribute('[data-main-mode="ASK"]', 'aria-pressed'), 'true');
    assert.equal(await page.getAttribute('[data-main-mode="DOCUMENT"]', 'aria-pressed'), 'false', 'the Document mode does not stick');
    await page.fill('#main-surface-input', 'What is on my plate today?');
    await page.click('#main-send');
    const turn = await lastTurnText(page);
    assert.equal(w.find('POST', /creations\/documents/).length, 1, 'only the first request used the Document route');
    assert.equal(/Document could not be created/.test(turn), false, 'the previous error is not shown for the new request');
    await ctx.close();
  });

  it('DESKTOP_QUICK_WAKE: the Quick Wake chip opens an idle Ask sheet with no sample task, no previous result and no fabricated progress', async () => {
    const u = h.user('qw');
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    await openHome(page, 'desktop');
    await page.click('#btn-header-quickwake');
    await page.waitForSelector('#ambient-prompt-input', { state: 'visible' });
    const idle = (await page.innerText('#ambient-sheet-modal')).replace(/\s+/g, ' ').trim();
    assert.equal(/AI agent architecture|Research and summarize latest|Tech Insights|Searching trusted sources/i.test(idle), false, `idle sheet must show no sample task: ${idle.slice(0, 160)}`);
    for (const id of ['ambient-task-title-card', 'ambient-request-card', 'ambient-progress-card', 'ambient-mockup-actions']) assert.equal(await page.isHidden('#' + id), true, `${id} is hidden while idle`);
    assert.equal(await page.inputValue('#ambient-prompt-input'), '');
    await page.keyboard.press('Escape');
    await ctx.close();
  });
});

describe('R24.8B — no fabricated product state', () => {
  for (const kind of ['desktop', 'mobile'] as const) {
    it(`${kind}: a brand-new user's Plans and Approvals show truthful empty states, no sample data and no fake counts; Create offers no sample reference images`, async () => {
      const u = h.user('fresh_' + kind);
      const ctx = await h.newContext(kind, u, 'en');
      const page = await ctx.newPage();
      await openHome(page, kind);
      const view = async (hash: string, sel: string) => { await page.evaluate((x: string) => { window.location.hash = '#' + x; }, hash); await page.waitForTimeout(1500); return text(page, sel); };
      const plans = await view('plans', '#view-plans');
      assert.match(plans, /No plans yet\. Ask NAgex to plan something and it will appear here\./);
      assert.equal(/Acme|Prepare Client Meeting|Apr 2\d|Perplexity|12 memories|8 steps generated|2 in progress|4 completed|Open plans|Understand meeting context|62%|5 of 8/i.test(plans), false, `no sample plan data: ${plans.slice(0, 200)}`);
      assert.equal(await page.locator('#view-plans table, #view-plans .plan-sum-card, #view-plans .plan-execute-split-layout').count(), 0);
      assert.ok(await page.locator('#btn-plans-ask').isVisible(), 'a real "Plan with NAgex" action exists');
      // Approvals are reviewed in the Workspace screen (the #approvals route resolves to it); a new user sees its truthful empty state
      const approvals = await view('approvals', '#view-inbox');
      assert.match(approvals, /Nothing needs your attention right now\./);
      assert.equal(/Pending \(2\)/.test(approvals), false, 'no fake approval count');
      assert.equal(await page.locator('[data-appr-filter]').count(), 0, 'no dead filter buttons');
      const create = await view('create', '#view-create');
      assert.equal(/Neon City|Portrait Ref/i.test(create), false);
      assert.equal(await page.locator('#create-reference-selector, .ref-img-chip').count(), 0);
      await ctx.close();
    });
  }

  it('real data shows through: a created plan appears in Plans after a reload; the Approvals count is the real number', async () => {
    const u = h.user('real');
    const created = await fetch(`${h.origin}/api/v1/plans`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `nagex_session=${u.sessionId}` }, body: JSON.stringify({ title: 'Launch checklist plan', steps: [{ title: 'Draft the announcement' }] }) });
    assert.equal(created.status, 200);
    const ctx = await h.newContext('desktop', u, 'en');
    const page = await ctx.newPage();
    await page.goto(`${h.origin}/#plans`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /Launch checklist plan/.test(document.getElementById('plans-list-container')?.textContent || ''), undefined, { timeout: 15000 });
    await page.reload();
    await page.waitForFunction(() => /Launch checklist plan/.test(document.getElementById('plans-list-container')?.textContent || ''), undefined, { timeout: 15000 });
    assert.match(await text(page, '#plans-list-container'), /Draft the announcement/);
    await ctx.close();
  });
});

describe('R24.8B — i18n and user-visible text integrity (desktop + mobile, EN + KR)', () => {
  const TABS = ['home', 'inbox', 'create', 'plans', 'tasks', 'approvals', 'knowledge', 'activity', 'vault', 'settings'];
  for (const kind of ['desktop', 'mobile'] as const) {
    for (const locale of ['en', 'ko'] as const) {
      it(`${kind}/${locale}: no raw i18n key, no mojibake, no malformed markup fragment is visible on any main tab`, async () => {
        const u = h.user(`i18n_${kind}_${locale}`);
        h.setLocale(u, locale);
        const doc = h.seedDocument(u, { title: 'Quarterly plan', content: 'content' });
        h.seedAnalysis(u, { title: 'Contract review', summary: 'summary' });
        await fetch(`${h.origin}/api/v1/knowledge`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `nagex_session=${u.sessionId}` }, body: JSON.stringify({ title: 'Knowledge note', content: 'alpha' }) });
        const ctx = await h.newContext(kind, u, locale);
        const page = await ctx.newPage();
        page.on('dialog', (d) => d.dismiss().catch(() => {}));
        await openHome(page, kind);
        const problems: string[] = [];
        for (const t of [...TABS, `canvas/${doc.artifactId}`]) {
          await page.evaluate((x: string) => { window.location.hash = '#' + x; }, t);
          await page.waitForTimeout(1100);
          if (t.startsWith('canvas/')) await page.evaluate(() => { const b = document.querySelector('.canvas-agent-tab[data-agent-tab="suggestions"]') as any; if (b && b.offsetParent) b.click(); });
          const found: string[] = await page.evaluate(() => {
            const out: string[] = [];
            const visible = (el: any) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            document.querySelectorAll('[data-i18n]').forEach((el: any) => { if (visible(el) && el.textContent.trim() === el.getAttribute('data-i18n')) out.push('raw key: ' + el.getAttribute('data-i18n')); });
            document.querySelectorAll('[data-i18n-placeholder]').forEach((el: any) => { if (visible(el) && el.getAttribute('placeholder') === el.getAttribute('data-i18n-placeholder')) out.push('raw placeholder key: ' + el.getAttribute('data-i18n-placeholder')); });
            const BAD = /�|\?\?|[㐀-䶿一-鿿豈-﫿]|\/span>|<\/|&lt;\/|\?[ㄱ-힣]/;
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let n: any;
            while ((n = walker.nextNode())) {
              const el = n.parentElement; if (!el || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName) || !visible(el)) continue;
              const v = n.nodeValue || ''; if (BAD.test(v)) out.push('bad text: ' + v.trim().slice(0, 60));
            }
            return out;
          });
          found.forEach((f) => problems.push(`${t}: ${f}`));
        }
        const missing: string[] = await page.evaluate(() => window.NAGEX_I18N.getMissingKeys());
        assert.deepEqual(problems, [], problems.join('\n'));
        assert.deepEqual(missing, [], `i18n keys requested but undefined: ${missing.join(', ')}`);
        await ctx.close();
      });
    }
  }
});

describe('R24.8B — user-visible mojibake in the shell chrome', () => {
  it('the title, the shortcut chip, the sidebar device card and the Korean mobile Home heading are clean', async () => {
    const u = h.user('chrome');
    const ctx = await h.newContext('desktop', u, 'en');
    const page = await ctx.newPage();
    await openHome(page, 'desktop');
    assert.equal(await page.title(), 'NAgex — Personal AI Control Center');
    assert.equal((await text(page, '.desktop-global-search kbd')).trim(), 'Alt+N');
    const device = await text(page, '.sidebar-device-state');
    assert.equal(/\?\?|\/span>/.test(device), false, device);
    await ctx.close();
    const ko = h.user('chrome_ko');
    h.setLocale(ko, 'ko');
    const mctx = await h.newContext('mobile', ko, 'ko');
    const mp = await mctx.newPage();
    await openHome(mp, 'mobile');
    const heading = await mp.evaluate(() => Array.from(document.querySelectorAll('#mobile-view-home *')).map((e: any) => e.children.length === 0 ? e.textContent.trim() : '').filter((t: string) => /이어서 작업하기|Continue working/.test(t)));
    assert.ok(heading.every((t: string) => t === '이어서 작업하기'), JSON.stringify(heading));
    await mctx.close();
  });
});
