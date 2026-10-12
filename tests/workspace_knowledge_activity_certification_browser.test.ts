import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;
declare const location: any;

// Workspace (Inbox + Vault), Knowledge and Activity certification: real Chromium, production server harness, real session
// and stores. Captures fail truthfully here (no model provider is configured in the harness), which is exactly the state
// these screens must report honestly. Every control offered must do something real.

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

async function open(label: string, locale: 'en' | 'ko', hash: string): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const ctx = await h.newContext('desktop', user, locale);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${h.origin}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);
  return { ctx, page, errors };
}

const post = (page: Page, url: string, body: unknown): Promise<{ status: number; body: any }> => page.evaluate(async ([u, b]: [string, unknown]) => {
  const r = await fetch(u, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b), signal: AbortSignal.timeout(20000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [url, body] as [string, unknown]);
const getJson = (page: Page, url: string): Promise<any> => page.evaluate(async (u: string) => (await (await fetch(u, { credentials: 'same-origin' })).json().catch(() => null)), url);
const RAW_KEY = /\b(?:settings|workspace|knowledge|activity|inbox|vault|auth|account|rail|nav|home)\.[A-Za-z][A-Za-z0-9]+/;
const activeView = (page: Page) => page.evaluate(() => document.querySelector('.tab-view.active-view')?.id);

describe('Workspace', () => {
  it('Add note really captures and persists; the failure is stated truthfully; another user sees nothing', async () => {
    const { ctx, page, errors } = await open('ws_note', 'en', '#inbox');
    await page.waitForSelector('#workspace-add-note');
    assert.match((await page.locator('#view-inbox h2').first().innerText()).trim(), /Workspace/);
    await page.click('#workspace-add-note');
    assert.equal(await page.locator('#workspace-note-form').isVisible(), true);
    await page.click('#workspace-note-save');
    assert.match(await page.locator('#workspace-notice').innerText(), /Write something to save/, 'an empty note is refused, not saved');
    await page.fill('#workspace-note-input', 'Call the dentist on Friday at 3pm');
    await page.click('#workspace-note-save');
    await page.waitForFunction(() => /Saved to Inbox/.test(document.querySelector('#workspace-notice')?.textContent || ''), undefined, { timeout: 20000 });
    // the capture is stored for this user and shown with WHAT it is (not just "something failed")
    const stored = await getJson(page, '/api/v1/workspace/inbox');
    assert.ok(stored.items.some((i: any) => i.content === 'Call the dentist on Friday at 3pm'), 'persisted on the server');
    await page.waitForSelector('.inbox-item-card', { timeout: 15000 });
    const card = await page.locator('.inbox-item-card').first().innerText();
    assert.match(card, /Call the dentist on Friday at 3pm/);
    assert.match(card, /FAILED/);
    assert.match(card, /No model provider is configured/, 'the real reason is shown');
    await page.reload();
    await page.waitForSelector('.inbox-item-card', { timeout: 15000 });
    assert.match(await page.locator('#inbox-items-list').innerText(), /Call the dentist/, 'still there after a refresh');
    assert.deepEqual(errors, []);
    // tenant/user isolation
    const other = await open('ws_note_other', 'en', '#inbox');
    await other.page.waitForTimeout(1500);
    assert.doesNotMatch(await other.page.locator('#inbox-items-list').innerText(), /dentist/);
    const otherJson = await getJson(other.page, '/api/v1/workspace/inbox');
    assert.equal(otherJson.items.some((i: any) => /dentist/.test(i.content || '')), false);
    await other.ctx.close();
    await ctx.close();
  });

  it('filters, Retry and Open Vault are real controls', async () => {
    const { ctx, page } = await open('ws_filters', 'en', '#inbox');
    await post(page, '/api/v1/workspace/capture', { type: 'TEXT', content: 'Draft the launch note', source: 'WEB' });
    await page.reload();
    await page.waitForSelector('.inbox-item-card', { timeout: 20000 });
    const listText = () => page.locator('#inbox-items-list').innerText();
    const waitList = (re: RegExp) => page.waitForFunction((src: string) => new RegExp(src).test(document.querySelector('#inbox-items-list')?.textContent || ''), re.source, { timeout: 10000 });
    const pill = (name: string) => page.locator(`.filter-pill[data-inbox-filter="${name}"]`);
    await pill('READY').click();
    await waitList(/Nothing in this view/);
    assert.equal(await pill('READY').getAttribute('aria-pressed'), 'true');
    assert.equal(await pill('ALL').getAttribute('aria-pressed'), 'false');
    await pill('NEEDS_REVIEW').click();
    await waitList(/Draft the launch note/);
    await pill('PROCESSING').click();
    await waitList(/Nothing in this view/);
    await pill('ALL').click();
    await waitList(/Draft the launch note/);
    void listText;

    const retries: string[] = [];
    page.on('request', (r) => { if (/\/api\/v1\/workspace\/items\/[^/]+\/retry$/.test(r.url()) && r.method() === 'POST') retries.push(r.url()); });
    const retry = page.locator('.inbox-item-card button', { hasText: /Retry/ }).first();
    if (await retry.count()) { await retry.click(); await page.waitForTimeout(800); assert.equal(retries.length, 1, 'Retry calls the real retry endpoint'); }

    // every button on a card does something: none is rendered without a handler
    const dead = await page.locator('.inbox-item-card button').evaluateAll((els: any[]) => els.filter((b) => !b.getAttribute('onclick') && !b.disabled).map((b) => b.textContent.trim()));
    assert.deepEqual(dead, []);

    await page.click('#workspace-open-vault');
    await page.waitForTimeout(500);
    assert.equal(await activeView(page), 'view-vault');
    assert.equal(await page.evaluate(() => location.hash), '#vault');
    await ctx.close();
  });

  it('Upload file adds a real item to the Inbox', async () => {
    const { ctx, page } = await open('ws_upload', 'en', '#inbox');
    await page.waitForSelector('#workspace-upload');
    await page.setInputFiles('#workspace-file-input', { name: 'agenda.txt', mimeType: 'text/plain', buffer: Buffer.from('Agenda: budget, hiring') });
    await page.waitForFunction(() => /added to your Inbox|Couldn't upload/.test(document.querySelector('#workspace-notice')?.textContent || ''), undefined, { timeout: 20000 });
    assert.match(await page.locator('#workspace-notice').innerText(), /File added to your Inbox/);
    const stored = await getJson(page, '/api/v1/workspace/inbox');
    assert.ok(stored.items.some((i: any) => (i.metadata?.originalName || i.filename || '') === 'agenda.txt' || /agenda\.txt/.test(JSON.stringify(i))), 'the upload is persisted');
    await ctx.close();
  });
});

describe('Vault', () => {
  it('Preview opens in-page, Delete asks first, deletion persists, empty and isolation are truthful', async () => {
    const { ctx, page } = await open('vault_flow', 'en', '#vault');
    await page.waitForSelector('#vault-recent-list');
    assert.match(await page.locator('#vault-recent-list').innerText(), /Nothing saved to your Vault yet/);
    const saved = await post(page, '/api/v1/workspace/vault', { title: 'Meeting notes', type: 'DOCUMENT', mimeType: 'text/plain', storageRef: 'main-result:cert', contentText: 'Notes from the meeting' });
    assert.equal(saved.status, 201);
    await page.reload();
    await page.waitForSelector('#vault-recent-list .nagex-card');
    assert.match(await page.locator('#vault-recent-list').innerText(), /Meeting notes/);

    let nativeDialogs = 0;
    page.on('dialog', (d) => { nativeDialogs += 1; d.dismiss(); });
    await page.locator('#vault-recent-list button', { hasText: 'Preview' }).first().click();
    await page.waitForSelector('#nagex-text-modal .mh-detail-desc');
    assert.equal(nativeDialogs, 0, 'the preview is an in-page dialog, not a blocking alert');
    assert.match(await page.locator('#nagex-text-modal').innerText(), /Notes from the meeting/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#nagex-text-modal').isVisible(), false);

    // declining the confirmation deletes nothing
    await page.locator('#vault-recent-list button', { hasText: 'Delete' }).first().click();
    await page.waitForTimeout(300);
    assert.equal(nativeDialogs, 1, 'Delete asks for confirmation');
    assert.equal((await getJson(page, '/api/v1/workspace/vault')).items.length, 1);
    page.removeAllListeners('dialog');
    page.on('dialog', (d) => d.accept());
    await page.locator('#vault-recent-list button', { hasText: 'Delete' }).first().click();
    await page.waitForFunction(() => /Nothing saved to your Vault yet/.test(document.querySelector('#vault-recent-list')?.textContent || ''), undefined, { timeout: 15000 });
    assert.equal((await getJson(page, '/api/v1/workspace/vault')).items.length, 0, 'the deletion really happened on the server');
    await ctx.close();

    // another user's Vault is separate
    const a = await open('vault_iso_a', 'en', '#vault');
    await post(a.page, '/api/v1/workspace/vault', { title: 'Private A', type: 'DOCUMENT', mimeType: 'text/plain', storageRef: 'main-result:a', contentText: 'secret A' });
    const b = await open('vault_iso_b', 'en', '#vault');
    assert.equal((await getJson(b.page, '/api/v1/workspace/vault')).items.some((i: any) => i.title === 'Private A'), false);
    const itemsA = (await getJson(a.page, '/api/v1/workspace/vault')).items;
    const crossRead = await b.page.evaluate(async (id: string) => (await fetch(`/api/v1/workspace/vault/${id}/preview`, { credentials: 'same-origin' })).status, itemsA[0].vaultItemId);
    assert.notEqual(crossRead, 200, 'another user cannot read this item');
    await a.ctx.close();
    await b.ctx.close();
  });
});

describe('Knowledge', () => {
  it('add, search, open source, refuse unsupported files, no internal ids, isolated per user', async () => {
    const { ctx, page, errors } = await open('know_flow', 'en', '#knowledge');
    await page.waitForSelector('#knowledge-add-btn');
    assert.match(await page.locator('#knowledge-list-container').innerText(), /No knowledge documents yet/);
    await page.setInputFiles('#knowledge-upload-input', { name: 'travel-policy.md', mimeType: 'text/markdown', buffer: Buffer.from('# Travel\nEconomy class for flights under 6 hours.') });
    await page.waitForSelector('.know-card', { timeout: 20000 });
    assert.match(await page.locator('.know-card').first().innerText(), /travel-policy\.md/);
    assert.match(await page.locator('.know-card').first().innerText(), /Indexed/i, 'only a really indexed document says so');

    await page.fill('#knowledge-search-input', 'Economy');
    await page.waitForFunction(() => document.querySelectorAll('.know-card').length === 1);
    await page.fill('#knowledge-search-input', 'zzz-no-such-text');
    await page.waitForFunction(() => document.querySelectorAll('.know-card').length === 0);
    await page.fill('#knowledge-search-input', '');
    await page.waitForSelector('.know-card');

    await page.locator('.knowledge-open-source-btn').first().click();
    await page.waitForSelector('#knowledge-source-modal .mh-detail-modal-card', { state: 'visible' });
    const modal = await page.locator('#knowledge-source-modal').innerText();
    assert.match(modal, /Economy class/);
    assert.doesNotMatch(modal, /Source ID|vlt_/, 'internal ids stay out of ordinary UI');
    await page.locator('#knowledge-source-modal .mh-detail-modal-close').click();

    // an unsupported file type is refused, not "added" as garbage
    const before = (await getJson(page, '/api/v1/knowledge')).documents.length;
    await page.setInputFiles('#knowledge-upload-input', { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 binary') });
    await page.waitForSelector('#nagex-text-modal', { state: 'visible' });
    assert.match(await page.locator('#nagex-text-modal').innerText(), /Only \.txt and \.md files/);
    assert.equal((await getJson(page, '/api/v1/knowledge')).documents.length, before);
    assert.deepEqual(errors, []);

    const other = await open('know_other', 'en', '#knowledge');
    await other.page.waitForTimeout(1200);
    assert.equal((await getJson(other.page, '/api/v1/knowledge')).documents.length, 0);
    assert.match(await other.page.locator('#knowledge-list-container').innerText(), /No knowledge documents yet/);
    await other.ctx.close();
    await ctx.close();
  });
});

describe('Activity', () => {
  it('shows real records with truthful status; application wording follows the language and user content is untouched', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const { ctx, page, errors } = await open(`activity_${locale}`, locale, '#activity');
      await page.waitForSelector('#executions-list-container');
      await page.waitForTimeout(800);
      // a real failed capture produces a real activity record
      await post(page, '/api/v1/workspace/capture', { type: 'TEXT', content: 'Book the venue for Friday', source: 'WEB' });
      await page.reload();
      await page.waitForSelector('.activity-outcome-card', { timeout: 20000 });
      const text = await page.locator('#executions-list-container').innerText();
      assert.match(text, /Book the venue for Friday/, 'the user\'s own words are shown as written');
      assert.doesNotMatch(text, RAW_KEY);
      if (locale === 'en') assert.match(text, /Could not analyze/);
      else {
        assert.match(text, /분석하지 못했어요/);
        assert.doesNotMatch(text, /Could not analyze/);
        assert.match(text, /실패/);
      }
      assert.deepEqual(errors, []);
      await ctx.close();
    }
  });

  it('a user with no activity gets an honest empty state, and activity is private to its owner', async () => {
    const a = await open('activity_priv_a', 'en', '#home');
    await post(a.page, '/api/v1/workspace/capture', { type: 'TEXT', content: 'Private errand list', source: 'WEB' });
    await a.page.waitForTimeout(1500);
    const mine = await getJson(a.page, '/api/v1/activity');
    assert.ok(mine.activities.some((x: any) => /Private errand list/.test(x.title || '')));
    const b = await open('activity_priv_b', 'en', '#activity');
    await b.page.waitForSelector('#executions-list-container');
    await b.page.waitForTimeout(1200);
    const theirs = await getJson(b.page, '/api/v1/activity');
    assert.equal(theirs.activities.some((x: any) => /Private errand list/.test(x.title || '')), false);
    assert.doesNotMatch(await b.page.locator('#executions-list-container').innerText(), /Private errand list/);
    await a.ctx.close();
    await b.ctx.close();
  });
});

describe('Workspace KR', () => {
  it('the whole Workspace screen is Korean without raw keys, and user text is untouched', async () => {
    const { ctx, page } = await open('ws_ko', 'ko', '#inbox');
    await page.waitForSelector('#workspace-add-note');
    assert.equal((await page.locator('#workspace-add-note').innerText()).trim(), '메모 추가');
    assert.equal((await page.locator('#workspace-upload').innerText()).trim(), '파일 업로드');
    assert.equal((await page.locator('#workspace-open-vault').innerText()).trim(), 'Vault 열기');
    await page.click('#workspace-add-note');
    await page.fill('#workspace-note-input', 'Call the dentist on Friday at 3pm');
    await page.click('#workspace-note-save');
    await page.waitForSelector('.inbox-item-card', { timeout: 20000 });
    const text = await page.locator('#view-inbox').innerText();
    assert.doesNotMatch(text, RAW_KEY);
    assert.match(text, /Call the dentist on Friday at 3pm/);
    assert.match(text, /실패/);
    assert.match(text, /모델 공급자가 설정되어 있지 않습니다/);
    assert.doesNotMatch(text, /No model provider|Capture processing failed/);
    await ctx.close();
  });
});
