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
  await page.waitForSelector(kind === 'desktop' ? '#home-section-create .ph-capability-tile' : '#mh-section-create .ph-capability-tile', { state: 'visible', timeout: 20000 });
}
const tile = (kind: 'desktop' | 'mobile', id: string) => `${kind === 'desktop' ? '#home-section-create' : '#mh-section-create'} .ph-capability-tile[data-capability="${id}"]`;
const text = async (page: Page, sel: string) => ((await page.textContent(sel)) || '').replace(/\s+/g, ' ').trim();

describe('R24.8B desktop — Ask and Create entry points work from the visible product surface', () => {
  it('DESKTOP_GENERAL_ASK: the header "Search anything or ask NAgex…" control opens the Ask sheet; the idle sheet shows no sample task; a request reaches the real pipeline', async () => {
    const u = h.user('ga');
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    const w = watch(page);
    await openHome(page, 'desktop');
    assert.match(await text(page, '#btn-header-search'), /Search anything or ask NAgex/);
    await page.click('#btn-header-search');
    await page.waitForSelector('#ambient-prompt-input', { state: 'visible' });
    const idle = (await page.innerText('#ambient-sheet-modal')).replace(/s+/g, ' ').trim(); // visible text only
    assert.equal(/AI agent architecture|Research and summarize latest|Tech Insights|Searching trusted sources/i.test(idle), false, `idle sheet must show no sample task: ${idle.slice(0, 160)}`);
    for (const id of ['ambient-task-title-card', 'ambient-request-card', 'ambient-progress-card', 'ambient-mockup-actions']) assert.equal(await page.isHidden('#' + id), true, `${id} is hidden while idle`);
    await page.fill('#ambient-prompt-input', 'Plan a launch checklist for next week.');
    await page.press('#ambient-prompt-input', 'Enter');
    await page.waitForFunction(() => document.getElementById('ambient-prompt-input')?.disabled === false && !!document.getElementById('ambient-request-card') && getComputedStyle(document.getElementById('ambient-request-card')).display !== 'none', undefined, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    assert.ok(w.find('POST', /^\/api\/v1\/ambient\/intent$/).length >= 1, 'the request reached POST /api/v1/ambient/intent');
    assert.equal(/Searching trusted sources|Checked your availability|Found related notes|Reading recent updates|Generating visual asset/i.test((await page.innerText('#ambient-sheet-modal'))), false, 'no fabricated progress is shown');
    assert.match(await text(page, '#ambient-request-card'), /Plan a launch checklist for next week/, 'the request card shows the REAL request');
    // Quick Wake opens the very same sheet; Escape closes it.
    await page.keyboard.press('Escape');
    await page.click('#btn-floating-quickwake');
    await page.waitForSelector('#ambient-prompt-input', { state: 'visible' });
    assert.equal(await page.inputValue('#ambient-prompt-input'), '');
    await ctx.close();
  });

  it('DESKTOP_REPORT_ENTRY: the Report tile opens the Ask sheet in Report mode, reaches POST /api/v1/creations/documents, and "no model" is reported truthfully (EN and KR)', async () => {
    for (const [locale, titleRe, placeholderRe, errorRe] of [
      ['en', /Write a report/, /What should NAgex write a report about\?/, /cannot write reports right now because no model is available/],
      ['ko', /보고서 작성/, /어떤 내용의 보고서를 작성할까요\?/, /사용할 수 있는 모델이 없어 지금은 보고서를 작성할 수 없어요/],
    ] as const) {
      const u = h.user('rep_' + locale);
      h.setLocale(u, locale);
      const ctx = await h.newContext('desktop', u, locale);
      const page = await ctx.newPage();
      const w = watch(page);
      await openHome(page, 'desktop');
      await page.click(tile('desktop', 'REPORT'));
      await page.waitForSelector('#ambient-prompt-input', { state: 'visible' });
      assert.match(await text(page, '#ambient-modal-title'), titleRe);
      assert.match((await page.getAttribute('#ambient-prompt-input', 'placeholder')) || '', placeholderRe);
      await page.fill('#ambient-prompt-input', 'Quarterly launch report');
      await page.click('#btn-ambient-run');
      await page.waitForSelector('#ambient-creation-status[data-state="error"]', { timeout: 30000 });
      const reqs = w.find('POST', /^\/api\/v1\/creations\/documents$/);
      assert.equal(reqs.length, 1, 'exactly one request to the canonical document-creation path');
      assert.equal(JSON.parse(reqs[0].body).prompt, 'Quarterly launch report');
      assert.match(await text(page, '#ambient-creation-status'), errorRe);
      assert.equal(await page.inputValue('#ambient-prompt-input'), 'Quarterly launch report', 'the text is kept for a retry');
      assert.equal(await page.isDisabled('#ambient-prompt-input'), false);
      assert.deepEqual(w.dialogs, [], 'no alert() on the Desktop flow');
      assert.equal(w.find('POST', /ambient\/intent|route-input/).length, 0, 'a Report request is not sent to general Ask');
      await ctx.close();
    }
  });

  it('DESKTOP_RESEARCH_ENTRY: the Research tile opens the sheet in Research mode, reaches POST /api/v1/research, and an unavailable search is reported truthfully (EN and KR)', async () => {
    for (const [locale, titleRe, errorRe] of [
      ['en', /Research/, /(live web search is unavailable|No verified sources were found|no model is available)/],
      ['ko', /리서치/, /(실시간 웹 검색을 사용할 수 없어|확인된 출처를 찾지 못해서|사용할 수 있는 모델이 없어)/],
    ] as const) {
      const u = h.user('res_' + locale);
      h.setLocale(u, locale);
      const ctx = await h.newContext('desktop', u, locale);
      const page = await ctx.newPage();
      const w = watch(page);
      await openHome(page, 'desktop');
      await page.click(tile('desktop', 'RESEARCH'));
      await page.waitForSelector('#ambient-prompt-input', { state: 'visible' });
      assert.match(await text(page, '#ambient-modal-title'), titleRe);
      await page.fill('#ambient-prompt-input', 'latest agent frameworks');
      await page.click('#btn-ambient-run');
      await page.waitForSelector('#ambient-creation-status[data-state="error"]', { timeout: 30000 });
      const reqs = w.find('POST', /^\/api\/v1\/research$/);
      assert.equal(reqs.length, 1);
      assert.equal(JSON.parse(reqs[0].body).query, 'latest agent frameworks');
      assert.match(await text(page, '#ambient-creation-status'), errorRe);
      assert.equal(await page.inputValue('#ambient-prompt-input'), 'latest agent frameworks');
      assert.deepEqual(w.dialogs, []);
      await ctx.close();
    }
  });
});

describe('R24.8B — the Ask sheet never shows a previous result or sample request when reopened', () => {
  it('NO_STALE_ASK_STATE: after a failed Report request, reopening the general Ask sheet shows a clean idle sheet', async () => {
    const u = h.user('stale');
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    await openHome(page, 'desktop');
    await page.click(tile('desktop', 'REPORT'));
    await page.fill('#ambient-prompt-input', 'Quarterly launch report');
    await page.click('#btn-ambient-run');
    await page.waitForSelector('#ambient-creation-status[data-state="error"]', { timeout: 30000 });
    await page.keyboard.press('Escape');
    await page.click('#btn-header-search');
    await page.waitForSelector('#ambient-prompt-input', { state: 'visible' });
    assert.equal(await page.isHidden('#ambient-creation-status'), true, 'the previous error/result area is hidden');
    assert.equal((await page.textContent('#ambient-creation-status')) || '', '', 'and empty');
    assert.equal(await page.inputValue('#ambient-prompt-input'), '');
    assert.match(await text(page, '#ambient-modal-title'), /NAgex Assistant/);
    assert.equal(/Write a report/.test((await page.getAttribute('#ambient-prompt-input', 'placeholder')) || ''), false, 'the Report-mode placeholder does not stick');
    for (const id of ['ambient-task-title-card', 'ambient-request-card', 'ambient-progress-card']) assert.equal(await page.isHidden('#' + id), true);
    // A Report-mode sheet must not stay in Report mode for the next general request either.
    await page.fill('#ambient-prompt-input', 'What is on my plate today?');
    await page.click('#btn-ambient-run');
    await page.waitForTimeout(1500);
    assert.equal((await page.evaluate(() => document.getElementById('ambient-creation-status')?.getAttribute('data-state') || '')), '', 'a general request does not use the creation status area');
    await ctx.close();
  });
});

describe('R24.8B mobile 390x844 — Report routes to the Report flow; Research and general Ask keep working', () => {
  it('MOBILE_REPORT_ENTRY: the Report tile + composer send reaches POST /api/v1/creations/documents (not general Ask) and failure is explained', async () => {
    const u = h.user('mrep');
    const ctx = await h.newContext('mobile', u);
    const page = await ctx.newPage();
    const w = watch(page);
    await openHome(page, 'mobile');
    await page.click(tile('mobile', 'REPORT'));
    await page.fill('#mh-command-input', 'Quarterly launch report');
    await page.click('#mh-command-send');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(2500);
    const reqs = w.find('POST', /^\/api\/v1\/creations\/documents$/);
    assert.equal(reqs.length, 1);
    assert.equal(JSON.parse(reqs[0].body).prompt, 'Quarterly launch report');
    assert.equal(w.find('POST', /ambient\/intent|route-input/).length, 0, 'it did not fall through to general Ask');
    assert.equal(w.dialogs.length, 1);
    assert.match(w.dialogs[0], /cannot write reports right now because no model is available/);
    assert.equal(await page.inputValue('#mh-command-input'), 'Quarterly launch report', 'text kept for retry');
    await ctx.close();
  });

  it('MOBILE_RESEARCH_ENTRY: the Research tile + composer reaches POST /api/v1/research and failure is explained (it used to be silent)', async () => {
    const u = h.user('mres');
    const ctx = await h.newContext('mobile', u);
    const page = await ctx.newPage();
    const w = watch(page);
    await openHome(page, 'mobile');
    await page.click(tile('mobile', 'RESEARCH'));
    await page.fill('#mh-command-input', 'latest agent frameworks');
    await page.click('#mh-command-send');
    await page.waitForTimeout(2500);
    assert.equal(w.find('POST', /^\/api\/v1\/research$/).length, 1);
    assert.equal(w.dialogs.length, 1);
    assert.match(w.dialogs[0], /(live web search is unavailable|No verified sources were found|no model is available)/);
    await ctx.close();
  });

  it('MOBILE_GENERAL_ASK: a plain message from the composer still goes to the general Ask pipeline', async () => {
    const u = h.user('mga');
    const ctx = await h.newContext('mobile', u);
    const page = await ctx.newPage();
    const w = watch(page);
    await openHome(page, 'mobile');
    await page.fill('#mh-command-input', 'What is on my plate today?');
    await page.click('#mh-command-send');
    await page.waitForTimeout(2500);
    assert.ok(w.find('POST', /route-input|ambient\/intent|ai\/chat/).length >= 1, JSON.stringify(w.seen.map((s) => s.method + ' ' + s.path).slice(-6)));
    assert.equal(w.find('POST', /creations\/documents|\/research/).length, 0);
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
      const approvals = await view('approvals', '#view-approvals');
      assert.match(approvals, /Pending \(0\)/);
      assert.equal(/Pending \(2\)/.test(approvals), false);
      assert.match(approvals, /Nothing is waiting for your approval\./);
      assert.equal(await page.locator('#view-approvals [data-appr-filter]').count(), 0, 'no dead filter buttons');
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
