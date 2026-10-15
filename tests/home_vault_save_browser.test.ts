// D-9 serial integration - the Home journey for the approval-gated "save to my Vault", on the REAL screens, in real Chromium, against the PRODUCTION server (plan route, plan seal, task /
// approval routes, Capability Broker, VaultSaveService, Vault + Activity routes all real). Only the model is a LOCAL deterministic stand-in (tests/_local_ai_world.ts) so there is an
// answer on screen to save; the Vault plan itself needs no model. Nothing leaves the machine. EN + KR at 1440 / 430 / 390 / 360.
//
// Journey: answer on screen -> "save that to my Vault" -> the EXACT draft is shown (nothing stored) -> "request approval" (still nothing stored) -> the person's own Approve -> saved AND
// read back -> "Open in Vault" shows the saved text on THE screen that width uses (desktop Vault, or the phone's native Vault) -> a brand-new browser lists it -> Activity records it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { startLocalAiWorld, type LocalAiWorld } from './_local_ai_world.js';
import { resolveNagexDataDir } from '../src/governance/file-record.store.js';

declare const window: any;
declare const document: any;

let h: CanvasAskHarness;
let world: LocalAiWorld;
let vaultStore: typeof import('../src/server_web.js')['vaultStore'];
let activityStore: typeof import('../src/server_web.js')['activityStore'];
before(async () => {
  world = await startLocalAiWorld();
  h = await startCanvasAskHarness({ scrubProviders: true, env: world.env });
  ({ vaultStore, activityStore } = await import('../src/server_web.js'));
});
after(async () => { await h?.close(); await world?.close(); });

const SIZES: Array<[number, number]> = [[1440, 900], [430, 932], [390, 844], [360, 740]];
const SUMMARY = {
  ko: '## 주간 회의 요약\n\n- 출시일은 다음 주 금요일로 확정했습니다.\n- 담당자: 민수\n\n다음 회의는 목요일 오후 3시입니다.',
  en: '## Weekly meeting summary\n\n- The launch date is confirmed for next Friday.\n- Owner: Dana\n\nThe next meeting is Thursday at 3 PM.',
} as const;
const TITLE = { ko: '주간 회의 요약', en: 'Weekly meeting summary' } as const;
const ASK_SUMMARY = { ko: '이번 주 회의 내용을 짧게 요약해서 알려줘', en: "What was decided in this week's meeting? Summarize it." } as const;
const ASK_SAVE = { ko: '방금 요약을 내 보관함에 저장해줘', en: 'Save that summary to my Vault' } as const;
const REQUEST = { ko: '승인 요청하기', en: 'Request approval to run' } as const;

async function contextAt(width: number, height: number, user: DisposableUser, locale: 'en' | 'ko'): Promise<BrowserContext> {
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width, height }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return ctx;
}
async function openHome(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}
async function settle(page: Page): Promise<string> {
  await page.waitForFunction(() => { const turns = document.querySelectorAll('.main-turn'); const last = turns[turns.length - 1] as any; return Boolean(last) && last.getAttribute('data-kind') !== 'pending'; }, undefined, { timeout: 30000 });
  return page.evaluate(() => { const turns = document.querySelectorAll('.main-turn'); return ((turns[turns.length - 1] as any)?.innerText ?? '').replace(/\s+/g, ' ').trim(); });
}
async function ask(page: Page, text: string): Promise<void> {
  await page.fill('#main-surface-input', text);
  await page.click('#main-send');
}
const items = (user: DisposableUser) => vaultStore.listItems(user.tenantId, user.userId);
const vaultActivity = (user: DisposableUser) => activityStore.list(user.tenantId, user.userId).filter((a) => a.type.startsWith('vault.'));
const overflow = (page: Page) => page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
// Playwright's "visible" does not notice an element that is clipped by a scroller or covered by the fixed bottom navigation (that is how a collapsed phone conversation went unseen). A person
// must be able to SEE and TOUCH it: after scrolling it into view, its centre lies inside the viewport and the element itself (not something laid over it) is what a finger would hit.
async function assertReachable(locator: ReturnType<Page['locator']>, label: string): Promise<void> {
  // centre it in the viewport (never merely "somewhere inside" it: the fixed bottom navigation covers the lowest 56px on phones)
  await locator.evaluate((el: any) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  const hit = await locator.evaluate((el: any) => {
    const b = el.getBoundingClientRect();
    const nav = document.querySelector('.mobile-bottom-nav');
    const navTop = nav && window.getComputedStyle(nav).display !== 'none' ? Math.round(nav.getBoundingClientRect().top) : null;
    const limit = navTop ?? window.innerHeight;
    const x = Math.round(b.left + b.width / 2);
    const y = Math.round(Math.min(Math.max(Math.min(Math.max(b.top + b.height / 2, 60), limit - 4), b.top + 1), b.bottom - 1));
    const top = document.elementFromPoint(x, y);
    return {
      inside: x >= 0 && x <= window.innerWidth && y >= 0 && y < limit,
      itself: Boolean(top) && (el === top || el.contains(top)),
      covered: (top ? (top.className || top.tagName) : null) + ` [element ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}; point ${x},${y}; nav top ${navTop}; viewport ${window.innerWidth}x${window.innerHeight}]`,
    };
  });
  assert.deepEqual({ inside: hit.inside, itself: hit.itself }, { inside: true, itself: true }, `${label} must be visible and touchable (covered by: ${hit.covered})`);
}
const requestButton = (page: Page, locale: 'en' | 'ko') => page.locator('.main-turn .main-inline-actions button', { hasText: REQUEST[locale] });

describe('answer on screen -> "save that to my Vault" -> draft -> approval -> saved, read back, reopened on the right Vault screen (EN/KR, 4 widths)', () => {
  for (const locale of ['ko', 'en'] as const) {
    for (const [width, height] of SIZES) {
      const phone = width < 600;
      it(`${locale} ${width}px: nothing is stored until the person approves; Approve stores exactly one item; Open shows its text on the ${phone ? 'phone' : 'desktop'} Vault; a fresh browser lists it; Activity records it`, async () => {
        const user = h.user(`hv_${locale}_${width}`);
        if (locale === 'ko') h.setLocale(user, 'ko');
        const ctx = await contextAt(width, height, user, locale);
        const page = await ctx.newPage();
        const posts: string[] = [];
        page.on('request', (r) => { if (r.method() !== 'GET') posts.push(new URL(r.url()).pathname); });
        await openHome(page);

        await ask(page, ASK_SUMMARY[locale]);
        assert.match(await settle(page), locale === 'ko' ? /주간 회의 요약/ : /Weekly meeting summary/);
        await assertReachable(page.locator('.main-turn').last(), 'the answer');
        await assertReachable(page.locator('#main-send'), 'the send button');

        // the EXACT draft is shown; nothing is requested or stored
        await ask(page, ASK_SAVE[locale]);
        await page.waitForSelector('.main-vault-draft', { timeout: 30000 });
        const draftText = await page.locator('.main-vault-draft').innerText();
        assert.match(draftText, locale === 'ko' ? /승인하신 뒤에만, 아래 내용이 그대로 저장돼요/ : /Exactly this is saved - only after you approve/);
        assert.match(draftText, locale === 'ko' ? /내 보관함/ : /My Vault/);
        assert.match(draftText, locale === 'ko' ? /바로 앞의 답변 \(수정 없음\)/ : /The previous answer, unedited/);
        assert.equal(await page.locator('.main-vault-draft-text').textContent(), SUMMARY[locale], 'the draft is the previous answer, character for character');
        assert.equal(items(user).length, 0, 'nothing stored by showing the draft');
        assert.deepEqual(posts.filter((p) => /tasks|approvals|vault/.test(p)), [], 'no task, approval or Vault write yet');
        assert.doesNotMatch(await page.locator('body').innerText(), /vault\.save_note|mainVault\.|mainRun\.|mainText\./, 'no internal ids or raw i18n keys');
        const request = requestButton(page, locale);
        assert.equal(await request.count(), 1);
        if (phone) assert.ok((await request.boundingBox())!.height >= 43.5, 'the request button is a 44px target');
        assert.equal(await overflow(page), 0);
        await assertReachable(page.locator('.main-vault-draft-text'), 'the draft text');
        await assertReachable(request, 'the request-approval button');
        await assertReachable(page.locator('#main-send'), 'the send button (draft state)');

        // keyboard: the draft text scrolls and is focusable; the request button is reached and used from the keyboard
        await page.locator('.main-vault-draft-text').focus();
        assert.equal(await page.evaluate(() => document.activeElement?.className), 'main-vault-draft-text');
        await request.focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.main-run-block[data-run-state="WAITING_APPROVAL"]', { timeout: 20000 });
        await page.waitForSelector('.main-approval-card', { timeout: 20000 });
        const proposal = await page.locator('.main-run-proposal').innerText();
        assert.match(proposal, locale === 'ko' ? /다음 회의는 목요일 오후 3시입니다/ : /The next meeting is Thursday at 3 PM/);
        assert.equal(items(user).length, 0, 'asking for approval stores nothing');
        assert.equal(vaultActivity(user).length, 0);
        assert.equal(await overflow(page), 0);
        const approve = page.locator('.main-approval-card button.btn-primary');
        await assertReachable(page.locator('.main-run-proposal'), 'the proposal');
        await assertReachable(approve, 'the Approve button');
        await assertReachable(page.locator('.main-approval-card button.btn-secondary'), 'the Decline button');
        if (phone) assert.ok((await approve.boundingBox())!.height >= 43.5, 'Approve is a 44px target');

        // the person's own Approve (keyboard) -> saved AND read back
        await approve.focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.main-run-block[data-run-state="SAVED_TO_VAULT"]', { timeout: 30000 });
        const done = await page.locator('.main-run-block').innerText();
        assert.match(done, locale === 'ko' ? /보관함에 저장했어요/ : /Saved to your Vault/);
        assert.match(done, locale === 'ko' ? /다시 읽어 확인했어요/ : /read back from your Vault/);
        assert.doesNotMatch(done, /Tool responded|도구가 응답했어요/, 'a Vault save is not reported as a tool response');
        assert.equal(items(user).length, 1, 'exactly one item');
        assert.equal(items(user)[0].metadata.contentText, SUMMARY[locale]);
        assert.equal(items(user)[0].title, TITLE[locale]);
        assert.equal(await overflow(page), 0);

        // "Open in Vault": the screen this width uses shows the saved text
        const open = page.locator('.main-run-open');
        assert.equal(await open.isVisible(), true);
        await assertReachable(page.locator('.main-run-block'), 'the saved result');
        await assertReachable(open, 'the Open in Vault button');
        if (phone) assert.ok((await open.boundingBox())!.height >= 43.5, 'Open is a 44px target');
        await open.focus();
        await page.keyboard.press('Enter');
        if (phone) {
          await page.waitForSelector('#mh-vault-saved-text', { timeout: 20000 });
          assert.equal(await page.locator('#mobile-view-vault').isVisible(), true, 'the phone Vault screen is the one showing');
          assert.equal(await page.locator('#mh-vault-saved-text').textContent(), SUMMARY[locale]);
          assert.equal(await page.locator('#mh-vault-detail-modal h3').textContent(), TITLE[locale]);
          assert.equal(await page.evaluate(() => document.activeElement?.id), 'mh-vault-detail-close', 'focus moves into the sheet');
          const close = await page.locator('#mh-vault-detail-close').boundingBox();
          assert.ok(close && close.width >= 43.5 && close.height >= 43.5, `close is a 44px target (${close?.width}x${close?.height})`);
          assert.equal(await overflow(page), 0);
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('#mh-vault-detail-modal').isVisible(), false, 'Escape closes the sheet');
          assert.match(await page.locator('#mh-vault-list').innerText(), new RegExp(TITLE[locale]));
        } else {
          await page.waitForSelector('#nagex-text-modal .mh-detail-desc', { timeout: 20000 });
          assert.equal(await page.locator('#nagex-text-modal .mh-detail-desc').textContent(), SUMMARY[locale]);
          assert.equal(await page.locator('#nagex-text-modal h3').textContent(), TITLE[locale]);
        }

        // a brand-new browser (same person) finds it in the Vault and in Activity
        const fresh = await contextAt(width, height, user, locale);
        const page2 = await fresh.newPage();
        await page2.goto(`${h.origin}/#vault`, { waitUntil: 'domcontentloaded' });
        const vaultList = phone ? '#mh-vault-list' : '#vault-recent-list';
        await page2.waitForSelector(vaultList, { state: 'visible', timeout: 20000 });
        await page2.waitForFunction(({ sel, title }: { sel: string; title: string }) => (document.querySelector(sel)?.textContent || '').includes(title), { sel: vaultList, title: TITLE[locale] }, { timeout: 20000 });
        assert.equal(await overflow(page2), 0);
        if (phone) {
          await page2.locator('#mh-vault-list .mh-vault-card', { hasText: TITLE[locale] }).click();
          await page2.waitForSelector('#mh-vault-saved-text', { timeout: 10000 });
          assert.equal(await page2.locator('#mh-vault-saved-text').textContent(), SUMMARY[locale], 'tapping the card shows the saved text');
        }
        await page2.goto(`${h.origin}/#activity`, { waitUntil: 'domcontentloaded' });
        const activityList = phone ? '#mh-activity-list' : '#executions-list-container';
        await page2.waitForSelector(activityList, { state: 'visible', timeout: 20000 });
        await page2.waitForFunction(({ sel, title }: { sel: string; title: string }) => (document.querySelector(sel)?.textContent || '').includes(title), { sel: activityList, title: TITLE[locale] }, { timeout: 20000 });
        assert.ok(!(await page2.locator(activityList).innerText()).includes(locale === 'ko' ? '출시일' : 'launch date'), 'Activity carries the title only, never the text');
        assert.equal(vaultActivity(user).length, 1);
        await fresh.close();

        // the browser never wrote to the Vault itself: one task, one approval path
        assert.equal(posts.filter((p) => p === '/api/v1/tasks/from-reviewed-plan').length, 1);
        assert.doesNotMatch(posts.join(' '), /workspace\/vault$/);
        await ctx.close();
      });
    }
  }
});

describe('decline, ask again, nothing to save, the answer it may use, failure, other people, and what must not change', () => {
  for (const locale of ['ko', 'en'] as const) {
    for (const [width, height] of [[1440, 900], [390, 844]] as Array<[number, number]>) {
      it(`${locale} ${width}px: declining stores nothing and says so; asking again gives a fresh approval that works; a double click makes one approval`, async () => {
        const user = h.user(`hv_decline_${locale}_${width}`);
        if (locale === 'ko') h.setLocale(user, 'ko');
        const ctx = await contextAt(width, height, user, locale);
        const page = await ctx.newPage();
        await openHome(page);
        await ask(page, ASK_SUMMARY[locale]);
        await settle(page);
        await ask(page, ASK_SAVE[locale]);
        await page.waitForSelector('.main-vault-draft', { timeout: 30000 });
        await requestButton(page, locale).dblclick();
        await page.waitForSelector('.main-approval-card', { timeout: 20000 });
        assert.equal(await page.locator('.main-approval-card').count(), 1, 'one approval, even after a double click');
        assert.equal(((await page.evaluate(async () => ((await (await fetch('/api/v1/tasks')).json()) as any).tasks.length)) as number), 1, 'one task');
        await page.locator('.main-approval-card button.btn-secondary').click();
        await page.waitForSelector('.main-run-block[data-run-state="DECLINED"]', { timeout: 30000 });
        assert.match(await page.locator('.main-run-block').innerText(), locale === 'ko' ? /실행하지 않음 - 거절하셨어요/ : /Not run - you declined/);
        assert.equal(await page.locator('.main-run-open').isVisible(), false, 'no Open for something that was not saved');
        assert.equal(items(user).length, 0, 'declined: nothing stored');
        assert.equal(vaultActivity(user).length, 0);
        assert.equal(await overflow(page), 0);

        // the same words again: a fresh preview, its own approval
        await ask(page, ASK_SAVE[locale]);
        await page.waitForFunction(() => document.querySelectorAll('.main-vault-draft').length === 2, undefined, { timeout: 30000 });
        await page.locator('.main-turn').last().locator('.main-inline-actions button', { hasText: REQUEST[locale] }).click();
        await page.locator('.main-turn').last().locator('.main-approval-card button.btn-primary').click();
        await page.waitForSelector('.main-turn:last-child .main-run-block[data-run-state="SAVED_TO_VAULT"]', { timeout: 30000 });
        assert.equal(items(user).length, 1);
        await ctx.close();
      });
    }
  }

  it('ko: text quoted in the request is saved as written (no previous answer needed)', async () => {
    const user = h.user('hv_inline');
    h.setLocale(user, 'ko');
    const ctx = await contextAt(1440, 900, user, 'ko');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, '"금요일 3시에 민수와 계약 검토" 내 보관함에 저장해줘');
    await page.waitForSelector('.main-vault-draft', { timeout: 30000 });
    assert.equal(await page.locator('.main-vault-draft-text').textContent(), '금요일 3시에 민수와 계약 검토');
    assert.match(await page.locator('.main-vault-draft').innerText(), /요청에 적어 주신 내용/);
    await requestButton(page, 'ko').click();
    await page.waitForSelector('.main-approval-card', { timeout: 20000 });
    await page.locator('.main-approval-card button.btn-primary').click();
    await page.waitForSelector('.main-run-block[data-run-state="SAVED_TO_VAULT"]', { timeout: 30000 });
    assert.deepEqual(items(user).map((i) => i.metadata.contentText), ['금요일 3시에 민수와 계약 검토']);
    await ctx.close();
  });

  for (const locale of ['ko', 'en'] as const) {
    it(`${locale}: with nothing to save it asks what to save - no plan, no approval, nothing stored`, async () => {
      const user = h.user(`hv_nothing_${locale}`);
      if (locale === 'ko') h.setLocale(user, 'ko');
      const ctx = await contextAt(1440, 900, user, locale);
      const page = await ctx.newPage();
      const posts: string[] = [];
      page.on('request', (r) => { if (r.method() !== 'GET') posts.push(new URL(r.url()).pathname); });
      await openHome(page);
      await ask(page, locale === 'ko' ? '내 보관함에 저장해줘' : 'Save it to my Vault');
      assert.match(await settle(page), locale === 'ko' ? /무엇을 저장할지 알려 주세요/ : /Tell me what to save/);
      assert.equal(await page.locator('.main-vault-draft').count(), 0);
      assert.equal(await requestButton(page, locale).count(), 0);
      assert.deepEqual(posts.filter((p) => /tasks|approvals|vault/.test(p)), []);
      assert.equal(items(user).length, 0);
      await ctx.close();
    });
  }

  it('ko: only the answer the person was just looking at can be saved - not one from before another request, and not one from before a new conversation', async () => {
    const user = h.user('hv_binding');
    h.setLocale(user, 'ko');
    const ctx = await contextAt(1440, 900, user, 'ko');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, ASK_SUMMARY.ko);
    await settle(page);
    // an unrelated request in between (a question back to the person): the earlier answer is no longer "the previous answer"
    await ask(page, '그거 좀 해줘');
    await settle(page);
    await ask(page, ASK_SAVE.ko);
    assert.match(await settle(page), /무엇을 저장할지 알려 주세요/);
    assert.equal(await page.locator('.main-vault-draft').count(), 0, 'an older answer is not silently used');
    // a fresh answer is saveable again, and a new conversation takes it away
    await ask(page, ASK_SUMMARY.ko);
    await settle(page);
    await page.click('#main-new-conversation');
    await page.waitForFunction(() => document.querySelectorAll('.main-turn').length === 0, undefined, { timeout: 20000 });
    await ask(page, ASK_SAVE.ko);
    assert.match(await settle(page), /무엇을 저장할지 알려 주세요/);
    assert.equal(items(user).length, 0);
    await ctx.close();
  });

  it('en: a Vault that can not write is reported as NOT saved - no item, no "saved" anywhere, no Open, the person is told to ask again', async () => {
    const user = h.user('hv_disk_full');
    const ctx = await contextAt(1440, 900, user, 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, ASK_SUMMARY.en);
    await settle(page);
    await ask(page, ASK_SAVE.en);
    await page.waitForSelector('.main-vault-draft', { timeout: 30000 });
    await requestButton(page, 'en').click();
    await page.waitForSelector('.main-approval-card', { timeout: 20000 });
    const dir = resolveNagexDataDir('vault', 'NAGEX_VAULT_DIR');
    const aside = `${dir}.aside-${Date.now()}`;
    fs.renameSync(dir, aside);
    fs.writeFileSync(dir, 'blocked');
    try {
      await page.locator('.main-approval-card button.btn-primary').click();
      await page.waitForSelector('.main-run-block[data-run-state="VAULT_NOT_SAVED"]', { timeout: 30000 });
      const text = await page.locator('.main-run-block').innerText();
      assert.match(text, /Not saved/);
      assert.match(text, /nothing was saved/);
      assert.doesNotMatch(text, /Saved to your Vault|read back/);
      assert.equal(await page.locator('.main-run-open').isVisible(), false);
    } finally {
      fs.rmSync(dir, { force: true });
      fs.renameSync(aside, dir);
    }
    assert.equal(items(user).length, 0);
    assert.deepEqual(vaultActivity(user).map((a) => a.status), ['FAILED']);
    await ctx.close();
  });

  it('another person sees nothing of it (desktop and phone Vault screens), and can not open the item by id', async () => {
    const owner = h.user('hv_owner');
    const other = h.user('hv_stranger');
    const ctx = await contextAt(1440, 900, owner, 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await ask(page, 'Save "private note for me" to my Vault');
    await page.waitForSelector('.main-vault-draft', { timeout: 30000 });
    await requestButton(page, 'en').click();
    await page.waitForSelector('.main-approval-card', { timeout: 20000 });
    await page.locator('.main-approval-card button.btn-primary').click();
    await page.waitForSelector('.main-run-block[data-run-state="SAVED_TO_VAULT"]', { timeout: 30000 });
    const id = items(owner)[0].vaultItemId;
    for (const [width, height] of [[1440, 900], [390, 844]] as Array<[number, number]>) {
      const strangerCtx = await contextAt(width, height, other, 'en');
      const sp = await strangerCtx.newPage();
      await sp.goto(`${h.origin}/#vault`, { waitUntil: 'domcontentloaded' });
      await sp.waitForSelector(width < 600 ? '#mh-vault-list' : '#vault-recent-list', { state: 'visible', timeout: 20000 });
      await sp.waitForTimeout(800);
      assert.doesNotMatch(await sp.locator(width < 600 ? '#mh-vault-list' : '#vault-recent-list').innerText(), /private note/);
      const result = await sp.evaluate(async (itemId: string) => ({
        direct: (await fetch(`/api/v1/workspace/vault/${itemId}`)).status,
        preview: (await fetch(`/api/v1/workspace/vault/${itemId}/preview`)).status,
        opened: await (window as any).NAGEX.openMobileVaultItem?.(itemId),
      }), id);
      assert.deepEqual({ direct: result.direct, preview: result.preview }, { direct: 404, preview: 404 });
      assert.ok(!result.opened, 'an id that is not in the person\'s own Vault opens nothing');
      await strangerCtx.close();
    }
    await ctx.close();
  });

  it('what must not change: a quick note ("메모:") is still a plain capture, and the inline "Save to Vault" button still saves at once with no approval', async () => {
    const user = h.user('hv_unchanged');
    h.setLocale(user, 'ko');
    const ctx = await contextAt(1440, 900, user, 'ko');
    const page = await ctx.newPage();
    const posts: string[] = [];
    page.on('request', (r) => { if (r.method() !== 'GET') posts.push(new URL(r.url()).pathname); });
    await openHome(page);
    await ask(page, '메모: 우유 사기');
    assert.match(await settle(page), /Inbox|받은|저장/);
    assert.deepEqual(posts.filter((p) => /approvals|tasks\//.test(p)), [], 'a quick note asks for no approval');
    await ask(page, ASK_SUMMARY.ko);
    await settle(page);
    await page.locator('.main-turn .main-inline-actions button', { hasText: '보관함에 저장' }).last().click();
    await page.waitForFunction(() => /Saved|저장/.test((document.querySelector('.main-turn:last-child') as any)?.innerText || ''), undefined, { timeout: 20000 });
    assert.ok(posts.includes('/api/v1/workspace/vault'), 'the direct button writes through the unchanged route');
    assert.deepEqual(posts.filter((p) => /approvals|from-reviewed-plan/.test(p)), [], 'no approval was added to ordinary saving');
    assert.equal(items(user).length, 1);
    await ctx.close();
  });
});
