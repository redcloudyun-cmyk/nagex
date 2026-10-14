// R23.7C-D in real Chromium against the production server: the Main "Slides" mode, the truthful no-model failure, a stored presentation opened
// from Recent (outline + real download of the .pptx), ownership isolation, EN/KR, desktop and phone. The deck itself is seeded through the real
// stores (the planner needs a model, which the harness deliberately does not have); the server, routes, download and UI are the real code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { startCanvasAskHarness } from './_canvas_ask_harness.js';
import { PresentationStore } from '../src/creation/presentation.store.js';
import { buildPptx, PPTX_MIME } from '../src/creation/pptx/pptx-writer.js';
import { readZip } from '../src/creation/pptx/zip-writer.js';

declare const document: any;
declare const window: any;

const tempDir = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), name));

test('Slides: enabled mode, truthful failure without a model, stored deck opens as an outline with a real .pptx download (EN/KR, desktop + phone), ownership isolated', async () => {
  const metaDir = tempDir('pres-main-meta-'); const bytesDir = tempDir('pres-main-bytes-');
  process.env.NAGEX_PRESENTATIONS_DIR = metaDir; process.env.NAGEX_PRESENTATION_BYTES_DIR = bytesDir;
  const h = await startCanvasAskHarness({ scrubProviders: true });
  const store = new PresentationStore({ metaDir, bytesDir });
  try {
    const seed = (user: { tenantId: string; userId: string }, title: string, locale: 'en' | 'ko') => {
      const slides = locale === 'ko'
        ? [{ title: '목표', bullets: ['베타 출시', '비용 절감'] }, { title: '다음 단계', bullets: ['채용'] }]
        : [{ title: 'Goals', bullets: ['Ship the beta', 'Cut costs'] }, { title: 'Next steps', bullets: ['Hire'] }];
      const presentationId = `pres_${crypto.randomBytes(12).toString('hex')}`;
      const bytes = buildPptx({ title, subtitle: 'Prepared by NAgex', locale, slides });
      const now = new Date().toISOString();
      const openTarget = `/api/v1/creations/presentations/${presentationId}`;
      const artifact = h.artifactStore.saveCompleted({ tenantId: user.tenantId, ownerId: user.userId, type: 'PRESENTATION', title, preview: 'Prepared by NAgex', sourceType: 'CAPTURE', sourceId: presentationId, openTarget });
      store.save({ presentationId, tenantId: user.tenantId, ownerId: user.userId, title, subtitle: 'Prepared by NAgex', summary: 'Prepared by NAgex', locale, slides, mimeType: PPTX_MIME, byteLength: bytes.length, binaryStoragePath: store.saveBinary(presentationId, bytes), sourceRefs: [], providerExecutionMetadata: { providerId: 'nagex-local-pptx', createdAt: now }, artifactId: artifact.artifactId, createdAt: now, updatedAt: now });
      return { presentationId, artifactId: artifact.artifactId, openTarget, slides };
    };

    for (const [kind, width] of [['desktop', 1440], ['mobile', 390]] as const) {
      for (const locale of ['en', 'ko'] as const) {
        const owner = h.user(`deck_${kind}_${locale}`);
        if (locale === 'ko') h.setLocale(owner, 'ko');
        const other = h.user(`deck_other_${kind}_${locale}`);
        const title = locale === 'ko' ? '3분기 계획' : 'Quarterly deck';
        const deck = seed(owner, title, locale);
        const base = await h.newContext('mobile', owner, locale);
        const ctx = await h.browser.newContext(kind === 'mobile'
          ? { viewport: { width, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: locale === 'ko' ? 'ko-KR' : 'en-US', acceptDownloads: true }
          : { viewport: { width, height: 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', acceptDownloads: true });
        await ctx.addCookies(await base.cookies());
        await ctx.addInitScript((l: string) => { try { window.localStorage.setItem('nagex_locale', l); } catch { /* ignore */ } }, locale);
        await base.close();
        const page: Page = await ctx.newPage();
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e.message)));
        page.on('dialog', async (d) => { errors.push('dialog: ' + d.message()); await d.dismiss().catch(() => undefined); });
        const tag = `${kind}/${locale}`;
        page.on('console', () => undefined);
        const posts: string[] = [];
        page.on('request', (r) => { if (r.method() === 'POST') posts.push(new URL(r.url()).pathname); });

        // 1) the Slides mode is enabled and fails truthfully without a model (no panel, no download link, no internal code)
        await page.goto(`${h.origin}/#home`);
        await page.waitForSelector('#main-surface-input', { timeout: 20000 });
        const chip = page.locator('[data-main-mode="SLIDES"]');
        assert.equal(await chip.isDisabled(), false, `${tag}: Slides chip is enabled`);
        assert.notEqual(await chip.getAttribute('aria-disabled'), 'true');
        await page.click('#main-shortcut-toggle');
        await chip.click();
        await page.fill('#main-surface-input', locale === 'ko' ? '분기 계획 발표 자료' : 'A deck for the quarterly plan');
        await page.click('#main-send');
        await page.waitForFunction(() => { const turns = document.querySelectorAll('.main-turn'); const last = turns[turns.length - 1] as any; return Boolean(last) && last.getAttribute('data-kind') !== 'pending'; }, undefined, { timeout: 30000 });
        const turn = await page.evaluate(() => { const turns = document.querySelectorAll('.main-turn'); return ((turns[turns.length - 1] as any).innerText as string).replace(/\s+/g, ' '); });
        assert.ok(posts.includes('/api/v1/creations/presentations'), `${tag}: the request reached the canonical presentation route`);
        assert.match(turn, locale === 'ko' ? /발표 자료를 만들지 못했어요/ : /Presentation could not be created/);
        assert.match(turn, locale === 'ko' ? /AI 모델이 없어서/ : /no AI model is available/);
        assert.equal(/NO_MODEL_PROVIDER_CONFIGURED/.test(await page.evaluate(() => document.body.innerText)), false, `${tag}: no internal code`);
        assert.equal(await page.locator('.main-result-download').count(), 0, `${tag}: no download link after a failure`);

        // 2) a stored deck opens from Recent: outline, canonical download link, no Canvas route, no provider identity
        await page.goto(`${h.origin}/#recent`);
        await page.reload();
        await page.waitForSelector('#recent-list .recent-item', { timeout: 20000 });
        const row = page.locator('#recent-list .recent-item', { hasText: title });
        assert.equal(await row.count(), 1, `${tag}: the deck is listed in Recent`);
        assert.equal(await row.locator('img').count(), 0, `${tag}: a deck has no image thumbnail`);
        await row.locator('.recent-open').click();
        await page.waitForSelector('#main-result-panel:not([hidden]) .main-deck-outline', { timeout: 15000 });
        const outline = await page.evaluate(() => ({
          items: [...document.querySelectorAll('.main-deck-outline > li')].map((li: any) => li.querySelector('strong')?.textContent),
          bullets: document.querySelectorAll('.main-deck-outline li li').length,
          href: document.querySelector('.main-result-download')?.getAttribute('href') || null,
          openDisabled: (document.getElementById('main-result-open') as any)?.disabled,
          text: (document.getElementById('main-result-preview') as any).innerText as string,
        }));
        assert.deepEqual(outline.items, deck.slides.map((s) => s.title), `${tag}: the outline lists every slide`);
        assert.equal(outline.bullets, deck.slides.reduce((n, s) => n + s.bullets.length, 0));
        assert.equal(outline.href, `${deck.openTarget}/download`, `${tag}: the download link is the canonical NAgex path`);
        assert.equal(outline.openDisabled, true, `${tag}: a deck has no separate Canvas viewer`);
        assert.equal(/nagex-local-pptx|presentationml|binaryStorage/i.test(outline.text), false, `${tag}: no renderer identity or storage detail`);
        assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= width, `${tag}: horizontal overflow`);

        // 3) the download is the real file
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.locator('.main-result-download').click()]);
        assert.equal(download.suggestedFilename(), `${title}.pptx`, `${tag}: download name`);
        const saved = path.join(tempDir('pres-dl-'), 'deck.pptx');
        await download.saveAs(saved);
        const entries = readZip(fs.readFileSync(saved));
        assert.ok(entries.some((e) => e.name === 'ppt/presentation.xml') && entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).length === 1 + deck.slides.length, `${tag}: the downloaded file is the deck`);

        // 4) ownership: another signed-in user gets the same 404 for viewer and download; an anonymous caller is refused
        for (const suffix of ['', '/download']) {
          const foreign = await fetch(`${h.origin}${deck.openTarget}${suffix}`, { headers: { cookie: `nagex_session=${other.sessionId}` } });
          assert.equal(foreign.status, 404, `${tag}: another owner sees nothing (${suffix || 'viewer'})`);
          const anonymous = await fetch(`${h.origin}${deck.openTarget}${suffix}`);
          assert.equal(anonymous.status, 401, `${tag}: anonymous callers are refused (${suffix || 'viewer'})`);
        }

        await page.click('#main-result-close'); // on a phone the result panel covers the screen until it is closed
        // 5) the created-deck path of the Main thread (the server answer is stubbed to the stored deck; the viewer and download are real)
        await page.route('**/api/v1/creations/presentations', (route) => route.request().method() === 'POST'
          ? route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ status: 'SUCCESS', creationId: deck.presentationId, creationKind: 'PRESENTATION', title, summary: 's', content: '# md', openTarget: deck.openTarget, artifactId: deck.artifactId, mimeType: PPTX_MIME, metadata: { slideCount: deck.slides.length, downloadTarget: `${deck.openTarget}/download`, byteLength: 1 } }) })
          : route.continue());
        await page.goto(`${h.origin}/#home`);
        await page.waitForSelector('#main-surface-input');
        await page.click('#main-shortcut-toggle');
        await page.click('[data-main-mode="SLIDES"]');
        await page.fill('#main-surface-input', locale === 'ko' ? '로드맵 발표 자료 만들어줘' : 'Make a deck about the roadmap');
        await page.click('#main-send');
        await page.waitForSelector('#main-result-panel:not([hidden]) .main-deck-outline', { timeout: 20000 });
        const created = await page.evaluate(() => { const turns = document.querySelectorAll('.main-turn'); return ((turns[turns.length - 1] as any).innerText as string).replace(/\s+/g, ' '); });
        assert.match(created, locale === 'ko' ? /발표 자료를 만들었어요/ : /Presentation created/);
        assert.equal(await page.locator('.main-result-download').getAttribute('href'), `${deck.openTarget}/download`);
        assert.deepEqual(errors, [], `${tag}: page errors or dialogs`);
        await ctx.close();
      }
    }
  } finally {
    await h.close();
    delete process.env.NAGEX_PRESENTATIONS_DIR; delete process.env.NAGEX_PRESENTATION_BYTES_DIR;
  }
});
