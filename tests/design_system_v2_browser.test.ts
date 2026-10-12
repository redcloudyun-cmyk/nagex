import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';
import { githubTokenStore } from '../src/integrations/github/token.store.js';

declare const window: any;
declare const document: any;
declare const getComputedStyle: any;
declare const localStorage: any;

// Design System V2 contract in real Chromium: measured typography, weight, spacing, control sizes, card density, locale font stacks, natural
// Korean copy and live language switching on Desktop Home, Apps & Connections, the shell, and the list screens. These are computed-style
// assertions against the token scale (never screenshots): a regression to heavy weights, oversized controls or artificial card heights fails here.

let h: CanvasAskHarness;
before(async () => { process.env.GITHUB_CLIENT_ID = 'v2'; process.env.GITHUB_CLIENT_SECRET = 'v2'; process.env.GITHUB_REDIRECT_URI = 'https://v2.invalid/cb'; h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

const HOUR = 3600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
async function stubRichHome(page: Page): Promise<void> {
  await page.route('**/api/v1/personal/home', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const home = body.data || body;
    home.today = { ...(home.today || {}), meetings: [{ id: 'm1', title: 'Weekly sync with design', startsAt: iso(HOUR) }] };
    home.todo = { status: 'OK', items: [{ id: 't1', kind: 'REMINDER', title: 'Call the client back', dueAt: iso(2 * HOUR), state: 'Due today' }] };
    home.recentResults = [{ id: 'r1', type: 'DOCUMENT', title: 'Quarterly plan v2', state: 'Completed', createdAt: iso(-2 * HOUR), sourceId: 'a1' }];
    home.suggestions = [{ id: 's1', kind: 'MEETING_PREP', title: 'Prepare for Budget review', reason: 'Your meeting starts in 15 minutes and I found 2 related items.', sourceRefs: [], action: { type: 'PREPARE', label: 'Prepare', requiresApproval: false }, generatedAt: new Date().toISOString() }];
    home.calendarConnection = { provider: 'google_calendar', state: 'CONNECTED', reason: null, retryable: false, scopes: [], missingScopes: [], connectPath: null, verifiedAt: new Date().toISOString(), message: '' };
    home.sourceStatus = { ...(home.sourceStatus || {}), calendar: 'CONNECTED', activity: 'OK' };
    await route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body.data ? { ...body, data: home } : home) });
  });
}

async function open(label: string, locale: 'en' | 'ko', hash: string, size = { width: 1440, height: 900 }, seed?: (u: ReturnType<CanvasAskHarness['user']>) => void): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  seed?.(user);
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: size, locale: locale === 'ko' ? 'ko-KR' : 'en-US' });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await stubRichHome(page);
  await page.goto(`${h.origin}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.reload();
  await page.waitForTimeout(1200);
  return { ctx, page, errors };
}

// the heaviest weight of every visible text node inside a container, and the smallest font size
const textStats = (page: Page, selector: string) => page.evaluate((sel: string) => {
  const root = document.querySelector(sel); if (!root) return null;
  let maxWeight = 0; let minSize = 999; let count = 0; const heavy: string[] = [];
  const walker = document.createTreeWalker(root, 4);
  while (walker.nextNode()) {
    const node: any = walker.currentNode; const text = (node.textContent || '').trim(); if (!text) continue;
    const el = node.parentElement; const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const weight = parseInt(cs.fontWeight, 10) || 400; const size = parseFloat(cs.fontSize);
    count += 1; maxWeight = Math.max(maxWeight, weight); minSize = Math.min(minSize, size);
    if (weight >= 700) heavy.push(`${weight} ${text.slice(0, 24)}`);
  }
  return { maxWeight, minSize, count, heavy };
}, selector);
const css = (page: Page, selector: string, props: string[]) => page.evaluate(([sel, list]) => {
  const el: any = document.querySelector(sel as string); if (!el) return null;
  const cs = getComputedStyle(el); const out: Record<string, string> = {};
  for (const p of list as string[]) out[p] = cs.getPropertyValue(p);
  return out;
}, [selector, props] as const);
const px = (value: string | undefined) => parseFloat(value || '0');
const SCALE = [0, 4, 8, 12, 16, 20, 24, 32];

describe('Design System V2: Home', () => {
  it('idle Home (EN and KR): hero 28px/600, body 14-15px, no weight above 600, compact controls and cards with no artificial minimum height', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const { ctx, page, errors } = await open(`v2_home_${locale}`, locale, '#home');
      await page.waitForSelector('.main-briefing-card');
      const hero = (await css(page, '#main-greeting', ['font-size', 'font-weight']))!;
      assert.equal(px(hero['font-size']), 28, `${locale} hero size`);
      assert.ok(px(hero['font-weight']) <= 600, 'hero is not bold');
      const sub = (await css(page, '#main-greeting-sub', ['font-size']))!;
      assert.equal(px(sub['font-size']), 15);
      const stats = (await textStats(page, '#nagex-main-surface'))!;
      assert.ok(stats.maxWeight <= 600, `${locale}: no text above weight 600 on Home (${stats.heavy.join(' | ')})`);
      assert.ok(stats.minSize >= 11, `${locale}: no text below 11px (${stats.minSize})`);
      const card = (await css(page, '.main-briefing-card', ['min-height', 'padding-top', 'padding-left', 'border-top-left-radius', 'box-shadow']))!;
      assert.ok(['0px', 'auto', 'normal'].includes(card['min-height']), `no artificial card minimum height (${card['min-height']})`);
      assert.ok([12, 16].includes(px(card['padding-top'])) && [16, 12].includes(px(card['padding-left'])), 'card padding on the scale');
      assert.ok(px(card['border-top-left-radius']) <= 12, 'small corner radius');
      assert.doesNotMatch(card['box-shadow'], /\b(?:1[4-9]|[2-9]\d)px\b/, 'no heavy elevation');
      const title = (await css(page, '.main-briefing-card h2', ['font-size', 'font-weight']))!;
      assert.deepEqual([px(title['font-size']), px(title['font-weight'])], [14, 600]);
      const chip = (await css(page, '.main-mode-chip', ['height', 'font-weight', 'font-size']))!;
      assert.ok(px(chip.height) <= 32, `compact mode chips (${chip.height})`);
      assert.ok(px(chip['font-weight']) <= 500);
      const send = (await css(page, '.main-send', ['width', 'height']))!;
      assert.equal(px(send.width), 38);
      const composer = await page.locator('.main-composer-card').boundingBox();
      assert.ok(composer && composer.height < 210, `composer is compact (${composer?.height})`);
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  it('Home copy: natural English and natural Korean (not literal), and the greeting reads naturally in each language', async () => {
    const en = await open('v2_copy_en', 'en', '#home');
    await en.page.waitForSelector('.main-briefing-card');
    assert.equal((await en.page.locator('#main-greeting-sub').innerText()).trim(), 'What can I help with?');
    assert.deepEqual(await en.page.locator('.main-briefing-card h2').allTextContents(), ['Today', 'To-do', 'Since yesterday', 'Suggestions']);
    assert.match(await en.page.locator('#main-surface-input').getAttribute('placeholder') ?? '', /Ask me to research, write, plan, or get something done/);
    await en.ctx.close();

    const ko = await open('v2_copy_ko', 'ko', '#home');
    await ko.page.waitForSelector('.main-briefing-card');
    assert.equal((await ko.page.locator('#main-greeting-sub').innerText()).trim(), '무엇을 도와드릴까요?');
    assert.deepEqual(await ko.page.locator('.main-briefing-card h2').allTextContents(), ['오늘', '할 일', '어제 이후', '추천']);
    assert.equal((await ko.page.locator('#main-myday-toggle, [data-main-myday]').first().innerText().catch(() => '')).trim() || '오늘의 일정과 할 일', '오늘의 일정과 할 일');
    assert.match(await ko.page.locator('#main-greeting').innerText(), /님, 좋은 (아침|오후|저녁)(이에요|예요)$|님, 좋은 (아침|오후|저녁)이에요|님, 좋은 오후예요/);
    assert.equal((await ko.page.locator('#main-plan-toggle').innerText()).trim(), '실행 전에 계획 보여 주기');
    // no stiff 합니다체 in the chrome around the user's own content
    const chrome = await ko.page.evaluate(() => [...document.querySelectorAll('#nagex-main-surface .main-briefing-empty, #nagex-main-surface .main-briefing-note, #nagex-main-surface .main-composer-card button, #nagex-main-surface #main-greeting-sub')].map((el: any) => el.textContent.trim()).join(' '));
    assert.doesNotMatch(chrome, /(습니다|입니다)/);
    await ko.ctx.close();
  });

  it('live language switch: copy, greeting order and the Hangul font stack change without a reload', async () => {
    const { ctx, page } = await open('v2_live', 'en', '#home');
    await page.waitForSelector('.main-briefing-card');
    const family = () => page.evaluate(() => getComputedStyle(document.querySelector('#nagex-main-surface')).fontFamily);
    assert.match(await family(), /^Inter/);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    await page.evaluate(() => window.NAGEX_I18N.setLocale('ko'));
    await page.waitForFunction(() => /무엇을 도와드릴까요/.test(document.getElementById('main-greeting-sub')?.textContent || ''), undefined, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'ko');
    assert.match(await family(), /^"?Noto Sans KR/, 'Korean uses the Hangul font stack');
    assert.deepEqual(await page.locator('.main-briefing-card h2').allTextContents(), ['오늘', '할 일', '어제 이후', '추천']);
    await page.evaluate(() => window.NAGEX_I18N.setLocale('en'));
    await page.waitForFunction(() => /What can I help with/.test(document.getElementById('main-greeting-sub')?.textContent || ''), undefined, { timeout: 5000 });
    assert.match(await family(), /^Inter/);
    await ctx.close();
  });
});

describe('Design System V2: shell and Apps & Connections', () => {
  it('shell: 176px sidebar from the token, 13.5px/500 navigation (600 when active), header chips at 12px, no fabricated user block', async () => {
    for (const [width, height] of [[1440, 900], [1680, 900], [1920, 1080]] as const) {
      const { ctx, page } = await open(`v2_shell_${width}`, 'en', '#home', { width, height });
      const side = (await css(page, '.sidebar-left', ['width', 'height']))!;
      assert.equal(px(side.width), 176);
      assert.ok(px(side.height) >= height - 110, `sidebar follows the viewport (${side.height} @${height})`);
      const link = (await css(page, '.sidebar-left .nav-item:not(.active) .nav-link', ['font-size', 'font-weight', 'height']))!;
      assert.deepEqual([px(link['font-size']), px(link['font-weight']), px(link.height)], [13.5, 500, 34]);
      const active = (await css(page, '.sidebar-left .nav-item.active .nav-link', ['font-weight']))!;
      assert.equal(px(active['font-weight']), 600);
      assert.equal(await page.locator('.sidebar-bottom-user').isVisible(), false, 'the static "User / Personal AI Assistant" label is not shown');
      const chip = (await css(page, '.quickwake-subdued-chip', ['font-size', 'font-weight', 'height']))!;
      assert.deepEqual([px(chip['font-size']), px(chip['font-weight']), px(chip.height)], [12, 500, 30]);
      assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)), 0, `no horizontal overflow @${width}`);
      await ctx.close();
    }
  });

  it('Apps & Connections (EN and KR): page title 24/600, tabs 34px, 220px+ cards sized by content, 18px section headings, nothing above weight 600, tokens on the spacing scale', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const { ctx, page } = await open(`v2_conn_${locale}`, locale, '#settings/connections', { width: 1440, height: 900 }, (u) => githubTokenStore.saveForPrincipal(u.tenantId, u.userId, { accessToken: 'gho_v2', refreshToken: null, expiresAt: null, scope: 'read:user,repo', tokenType: 'bearer' }, { login: 'octocat', id: 1 }));
      await page.waitForSelector('#nagex-connections .nagex-conn-card');
      const title = (await css(page, '.settings-page-heading h2', ['font-size', 'font-weight']))!;
      assert.deepEqual([px(title['font-size']), px(title['font-weight'])], [24, 600], `${locale} page title`);
      const tab = (await css(page, '.settings-top-tabs .settings-cat-tab:not(.active)', ['height', 'font-size', 'font-weight']))!;
      assert.deepEqual([px(tab.height), px(tab['font-size']), px(tab['font-weight'])], [34, 13.5, 500]);
      const heading = (await css(page, '.nagex-conn-section > h3', ['font-size', 'font-weight']))!;
      assert.deepEqual([px(heading['font-size']), px(heading['font-weight'])], [18, 600]);
      const cardTitle = (await css(page, '.nagex-conn-card h4', ['font-size', 'font-weight']))!;
      assert.deepEqual([px(cardTitle['font-size']), px(cardTitle['font-weight'])], [15, 600]);
      const card = (await css(page, '.nagex-conn-card', ['min-height', 'padding-top', 'padding-left', 'border-top-left-radius']))!;
      assert.ok(['0px', 'auto', 'normal'].includes(card['min-height']));
      assert.ok(SCALE.includes(px(card['padding-top'])) && SCALE.includes(px(card['padding-left'])));
      assert.ok(px(card['border-top-left-radius']) <= 12);
      const grid = (await css(page, '.nagex-conn-grid', ['row-gap', 'column-gap']))!;
      assert.ok(SCALE.includes(px(grid['row-gap'])) && SCALE.includes(px(grid['column-gap'])), `grid gaps on the scale (${grid['row-gap']})`);
      const body = (await css(page, '#nagex-conn-body', ['row-gap']))!;
      assert.equal(px(body['row-gap']), 24);
      const btn = (await css(page, '.nagex-conn-card .nagex-conn-btn', ['height', 'font-size', 'font-weight']))!;
      assert.ok(px(btn.height) >= 30 && px(btn.height) <= 34 && px(btn['font-weight']) === 500 && px(btn['font-size']) === 13.5, `compact card button (${JSON.stringify(btn)})`);
      const stats = (await textStats(page, '#cat-panel-connections'))!;
      assert.ok(stats.maxWeight <= 600, `${locale}: no text above weight 600 on Connections (${stats.heavy.join(' | ')})`);
      const icon = (await css(page, '.nagex-conn-icon', ['width', 'height']))!;
      assert.deepEqual([px(icon.width), px(icon.height)], [36, 36]);
      // a modal and the drawer use the same scale and weights
      await page.click('#nagex-conn-add');
      const dlg = (await textStats(page, '#nagex-conn-layer'))!;
      assert.ok(dlg.maxWeight <= 600 && dlg.minSize >= 12, `modal type (${dlg.maxWeight}/${dlg.minSize})`);
      const field = (await css(page, '#nagex-conn-layer input[name="name"]', ['height', 'font-size']))!;
      assert.deepEqual([px(field.height), px(field['font-size'])], [34, 14]);
      await page.keyboard.press('Escape');
      await ctx.close();
    }
  });

  it('Korean copy on Apps & Connections is natural 해요체 (no stiff 합니다체 around the controls) and the header reads 앱 및 연결', async () => {
    const { ctx, page } = await open('v2_conn_copy', 'ko', '#settings/connections');
    await page.waitForSelector('#nagex-connections .nagex-conn-card');
    const text = await page.locator('#cat-panel-connections').innerText();
    assert.match(text, /앱 및 연결/);
    assert.match(text, /NAgex가 사용할 앱과 도구를 연결하고 관리하세요\./);
    assert.match(text, /연결하기/);
    assert.match(text, /직접 운영하는 도구 서버를 연결해요/);
    assert.doesNotMatch(text, /(습니다|입니다)\./, 'no stiff register in the page copy');
    await ctx.close();
  });
});

describe('Design System V2: list screens share one system', () => {
  it('Recent, Workspace, Knowledge and Activity: same 24/600 title, one content column, styled buttons and filter pills, localized chips, no weight above 600 outside the header', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const lefts: number[] = [];
      for (const [name, hash, view] of [['recent', '#recent', '#view-recent'], ['workspace', '#inbox', '#view-inbox'], ['knowledge', '#knowledge', '#view-knowledge'], ['activity', '#activity', '#view-executions']] as const) {
        const { ctx, page, errors } = await open(`v2_${name}_${locale}`, locale, hash);
        await page.waitForSelector(`${view}.active-view`);
        const title = (await css(page, `${view} h2`, ['font-size', 'font-weight']))!;
        assert.deepEqual([px(title['font-size']), px(title['font-weight'])], [24, 600], `${name}/${locale} title`);
        lefts.push(Math.round((await page.locator(`${view} h2`).first().boundingBox())!.x));
        const stats = (await textStats(page, view))!;
        assert.ok(stats.maxWeight <= 600, `${name}/${locale}: no text above weight 600 (${stats.heavy.join(' | ')})`);
        assert.equal(await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth)), 0);
        if (name === 'workspace') {
          const primary = (await css(page, '#workspace-add-note', ['height', 'font-weight', 'font-size', 'background-color']))!;
          assert.deepEqual([px(primary.height), px(primary['font-weight']), px(primary['font-size'])], [34, 500, 13.5]);
          const secondary = (await css(page, '#workspace-upload', ['height', 'background-color']))!;
          assert.equal(px(secondary.height), 34);
          const pills = (await page.locator('.filter-pill[data-inbox-filter]').allInnerTexts()).map((x) => x.trim());
          assert.deepEqual(pills, locale === 'en' ? ['All', 'Needs review', 'Ready', 'Processing'] : ['전체', '검토 필요', '준비됨', '처리 중']);
          const pill = (await css(page, '.filter-pill', ['height', 'font-size']))!;
          assert.deepEqual([px(pill.height), px(pill['font-size'])], [30, 13]);
        }
        assert.deepEqual(errors, []);
        await ctx.close();
      }
      assert.ok(Math.max(...lefts) - Math.min(...lefts) <= 2, `${locale}: every list screen starts at the same left edge (${lefts.join(', ')})`);
    }
  });

  it('Activity cards carry no inline weights or fixed rem sizes any more (classes and tokens only)', async () => {
    const { ctx, page } = await open('v2_activity_markup', 'en', '#activity');
    await page.waitForSelector('#view-executions.active-view');
    const inline = await page.evaluate(() => [...document.querySelectorAll('#view-executions [style]')].map((el: any) => el.getAttribute('style')).filter((s: string) => /font-(weight|size)|text-transform/.test(s)));
    assert.deepEqual(inline, []);
    await ctx.close();
  });
});
