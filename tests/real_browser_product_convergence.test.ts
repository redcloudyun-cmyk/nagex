import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const document: any;
declare const window: any;

let h: CanvasAskHarness;

before(async () => {
  h = await startCanvasAskHarness({ scrubProviders: true });
});

after(async () => {
  await h?.close();
});

describe('NAgex real browser product convergence', () => {
  it('global search uses real backend results and opens an artifact in Canvas', async () => {
    const user = h.user('convergence-search');
    const seeded = h.seedDocument(user, {
      title: 'Browser convergence document',
      content: 'Canonical browser convergence content.',
    });
    const ctx = await h.newContext('desktop', user);
    const page = await ctx.newPage();
    await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });

    await page.click('#btn-header-search');
    await page.fill('#nagex-real-search-input', 'Browser convergence');
    await page.waitForSelector(`.nagex-real-search-row[data-id="${seeded.artifactId}"]`);
    await page.click(`.nagex-real-search-row[data-id="${seeded.artifactId}"]`);

    await page.waitForSelector('#canvas-renderer-region .canvas-document-text');
    assert.equal(await page.textContent('#canvas-artifact-title'), 'Browser convergence document');
    assert.equal(await page.textContent('#canvas-renderer-region .canvas-document-text'), 'Canonical browser convergence content.');
    await ctx.close();
  });

  it('Canvas revision control calls the real revision endpoint and shows truthful unavailable state when no model is configured', async () => {
    const user = h.user('convergence-revision');
    const seeded = h.seedDocument(user, {
      title: 'Revision candidate',
      content: 'Version one.',
    });
    const ctx = await h.newContext('desktop', user);
    const page = await ctx.newPage();
    const revisions: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname.endsWith('/revisions')) revisions.push(url.pathname);
    });

    await page.goto(`${h.origin}/#canvas/${seeded.artifactId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#nagex-document-revision-control');
    await page.fill('#nagex-document-revision-input', 'Make the summary more concise.');
    await page.click('#nagex-document-revision-submit');
    await page.waitForFunction(() => {
      const text = document.querySelector('#nagex-document-revision-status')?.textContent || '';
      return /unavailable|failed|provider|model|사용할 수|수정/.test(text);
    });

    assert.equal(revisions.length, 1);
    assert.equal(revisions[0], `/api/v1/creations/documents/${seeded.documentId}/revisions`);
    assert.equal(await page.textContent('#canvas-renderer-region .canvas-document-text'), 'Version one.');
    await ctx.close();
  });

  it('same certified search and Canvas surfaces fit the representative mobile viewport', async () => {
    const user = h.user('convergence-mobile');
    const seeded = h.seedDocument(user, {
      title: 'Mobile convergence document',
      content: 'Mobile route restore content.',
    });
    const ctx = await h.newContext('mobile', user);
    const page = await ctx.newPage();
    await page.goto(`${h.origin}/#canvas/${seeded.artifactId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mh-canvas-renderer-region .canvas-document-text');
    assert.equal(await page.textContent('#mh-canvas-renderer-region .canvas-document-text'), 'Mobile route restore content.');
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    assert.ok(overflow <= 4, `mobile horizontal overflow ${overflow}px`);
    await ctx.close();
  });
});
