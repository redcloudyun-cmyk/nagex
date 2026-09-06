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

test('logo markup and CSS preserve direct assets and bounded sizing', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    const css = await (await fetch(`${origin}/style.css`)).text();

    assert.match(html, /src="assets\/nagex-compact-logo\.png"[^>]*class="nagex-compact-logo header-logo"/);
    assert.match(html, /src="assets\/nagex-compact-logo-dark-bg\.png"[^>]*class="nagex-compact-logo sidebar-logo"/);
    assert.match(css, /\.header-logo\s*{[^}]*max-height:\s*28px;[^}]*width:\s*auto;[^}]*max-width:\s*150px;[^}]*object-fit:\s*contain;/s);
    assert.match(css, /\.sidebar-logo\s*{[^}]*max-height:\s*30px;[^}]*width:\s*auto;[^}]*max-width:\s*160px;[^}]*object-fit:\s*contain;/s);
    assert.match(css, /\.nagex-compact-logo\s*{[^}]*width:\s*auto;[^}]*object-fit:\s*contain;/s);
    assert.match(css, /\.brand-logo-group, \.brand-logo-sidebar\s*{[^}]*overflow:\s*hidden;/s);
  });
});
