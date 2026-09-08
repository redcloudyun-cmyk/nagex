import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { FRONTEND_BUILD_VERSION, server } from '../src/server_web.js';

const expectedNoCacheHeaders = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  pragma: 'no-cache',
  expires: '0',
};

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('mutable frontend resources are never cached and HTML is deterministically versioned', async () => {
  await withServer(async (origin) => {
    for (const pathname of ['/', '/index.html', '/style.css', '/app.js', '/i18n.js']) {
      const response = await fetch(`${origin}${pathname}`);
      assert.equal(response.status, 200);
      for (const [name, value] of Object.entries(expectedNoCacheHeaders)) {
        assert.equal(response.headers.get(name), value, `${pathname} ${name}`);
      }
      assert.doesNotMatch(response.headers.get('cache-control') ?? '', /max-age/i);
    }

    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, new RegExp(`style\\.css\\?v=${FRONTEND_BUILD_VERSION}`));
    assert.match(html, new RegExp(`i18n\\.js\\?v=${FRONTEND_BUILD_VERSION}`));
    assert.match(html, new RegExp(`app\\.js\\?v=${FRONTEND_BUILD_VERSION}`));
    assert.doesNotMatch(html, /__NAGEX_BUILD_VERSION__/);
  });
});

test('only the global header renders the compact logo with bounded sizing', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const css = await (await fetch(`${origin}/style.css`)).text();

    assert.match(html, /src="assets\/nagex-compact-logo\.png"[^>]*class="nagex-compact-logo header-logo"/);
    assert.doesNotMatch(html, /brand-logo-sidebar|class="[^"]*sidebar-logo/);
    assert.equal((html.match(/class="nagex-compact-logo header-logo"/g) ?? []).length, 1);
    // A leading nav-grouping comment (Primary/Secondary/Advanced — MASTER.md
    // Section 14.9 §5) may appear between the list and its first item.
    assert.match(html, /<div class="sidebar-top-group">\s*<ul class="nav-menu">\s*(?:<!--[^>]*-->\s*)?<li class="nav-item active" data-tab="tab-home">/s);
    assert.match(html, /<link rel="icon" type="image\/png" href="assets\/favicon\.png">/);
    assert.match(html, /<link rel="apple-touch-icon" href="assets\/nagex-app-icon\.png">/);
    assert.match(html, /id="ambient-plan-preview"/);
    assert.match(html, /id="ambient-plan-steps"/);
    assert.match(html, /id="ambient-result-card"/);
    assert.match(await (await fetch(`${origin}/app.js`)).text(), /api\/v1\/ambient\/intent/);
    assert.match(css, /\.header-logo\s*{[^}]*max-height:\s*28px;[^}]*width:\s*auto;[^}]*max-width:\s*150px;[^}]*object-fit:\s*contain;/s);
    assert.match(css, /\.nagex-compact-logo\s*{[^}]*width:\s*auto;[^}]*object-fit:\s*contain;/s);
    assert.match(css, /\.brand-logo-group\s*{[^}]*overflow:\s*hidden;/s);
  });
});
