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

  it('browser search result rows route each certified local result type to a real target', async () => {
    const user = h.user('convergence-types');
    const artifact = h.seedDocument(user, {
      title: 'Search artifact target',
      content: 'Artifact search target content.',
    });
    const ctx = await h.newContext('desktop', user);
    const page = await ctx.newPage();
    const cookie = `nagex_session=${user.sessionId}`;
    const server = await import('../src/server_web.js');

    const taskRes = await page.request.post(`${h.origin}/api/v1/tasks`, {
      headers: { cookie },
      data: {
        name: 'Search task target',
        objective: 'Verify search task routing',
        type: 'ONE_TIME',
        trigger: { type: 'MANUAL' },
        approvalPolicy: 'ALWAYS_APPROVE',
      },
    });
    assert.equal(taskRes.status(), 201);

    const knowledgeRes = await page.request.post(`${h.origin}/api/v1/knowledge`, {
      headers: { cookie },
      data: {
        title: 'Search knowledge target',
        content: 'Knowledge search target content.',
        mimeType: 'text/plain',
      },
    });
    assert.equal(knowledgeRes.status(), 201);
    const knowledge = await knowledgeRes.json();

    const vaultRes = await page.request.post(`${h.origin}/api/v1/workspace/vault`, {
      headers: { cookie },
      data: {
        title: 'Search vault target',
        type: 'DOCUMENT',
        mimeType: 'text/plain',
        storageRef: 'search-vault-target',
        contentText: 'Vault search target content.',
      },
    });
    assert.equal(vaultRes.status(), 201);
    const vault = await vaultRes.json();

    const activity = server.activityStore.record({
      tenantId: user.tenantId,
      principalId: user.userId,
      type: 'CERTIFICATION',
      title: 'Search activity target',
      description: 'Activity search target content.',
      status: 'COMPLETED',
      dedupeKey: 'search-activity-target',
    });

    async function searchAndClick(source: string, query: string): Promise<void> {
      await page.evaluate(() => window.NAGEX_BROWSER_CONVERGENCE.openSearchPanel());
      await page.waitForFunction(() => document.getElementById('nagex-real-search-panel')?.hidden === false);
      await page.fill('#nagex-real-search-input', query);
      const row = page.locator(`.nagex-real-search-row[data-source="${source}"]`).first();
      await row.waitFor({ state: 'visible' });
      await row.click();
    }

    page.on('dialog', async (dialog) => {
      assert.match(dialog.message(), /Search vault target|Vault item .* has no persisted preview\/download content/);
      await dialog.accept();
    });

    await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });

    await searchAndClick('TASKS', 'Search task target');
    await page.waitForFunction(() => window.location.hash === '#tasks' && document.querySelector('#view-tasks')?.classList.contains('active-view'));

    await searchAndClick('ARTIFACTS', 'Search artifact target');
    await page.waitForSelector('#canvas-renderer-region .canvas-document-text');
    assert.equal(await page.textContent('#canvas-renderer-region .canvas-document-text'), 'Artifact search target content.');

    await searchAndClick('KNOWLEDGE', 'Search knowledge target');
    await page.waitForFunction((title: string) => {
      const modal = document.getElementById('knowledge-source-modal');
      return modal && modal.style.display !== 'none' && modal.textContent?.includes(title);
    }, knowledge.name || 'Search knowledge target');
    await page.evaluate(() => { const modal = document.getElementById('knowledge-source-modal'); if (modal) modal.style.display = 'none'; });

    await searchAndClick('VAULT', 'Search vault target');
    await page.waitForFunction((title: string) => window.location.hash === '#vault' && document.body.textContent?.includes(title), vault.title);

    const activitySearch = await page.request.get(`${h.origin}/api/v1/search?q=${encodeURIComponent('Search activity target')}`, { headers: { cookie } });
    assert.equal(activitySearch.status(), 200);
    assert.ok(((await activitySearch.json()).results || []).some((result: any) => result.source === 'ACTIVITY' && result.id === activity.activityId));
    await searchAndClick('ACTIVITY', 'Search activity target');
    await page.waitForFunction(() => window.location.hash === '#activity' && document.querySelector('#view-executions')?.classList.contains('active-view'));
    await ctx.close();
  });
});
