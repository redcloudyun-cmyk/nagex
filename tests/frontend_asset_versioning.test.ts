import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { FRONTEND_VERSIONED_FILES, createServerInstance } from '../src/server_web.js';

// A fix that reaches the server must also reach the browser. Every page asset carries ?v=<build version>, and that version is computed from FRONTEND_VERSIONED_FILES: an asset the page references
// but the list omits can change without the stamp changing, so a browser keeps the OLD copy after a deployment ("the fix is deployed but nothing changed"). Several assets were missing from
// the list; this pins that every versioned asset of every page is covered, exists, and is served with no-store headers.
const PUBLIC = path.resolve(__dirname, '..', '..', 'public');
const PAGES = ['index.html', 'desktop-quickwake.html', 'privacy.html', 'terms.html'];
const VERSIONED = /(?:src|href)="([^"?]+)\?v=__NAGEX_BUILD_VERSION__"/g;

function referenced(): Array<{ page: string; asset: string }> {
  const out: Array<{ page: string; asset: string }> = [];
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
    for (const match of html.matchAll(VERSIONED)) out.push({ page, asset: match[1] });
  }
  return out;
}

test('every versioned asset a page references is part of the build-version hash and exists', () => {
  const refs = referenced();
  assert.ok(refs.length > 40, `the pages reference their assets with the stamp (${refs.length})`);
  const missing = refs.filter((r) => !FRONTEND_VERSIONED_FILES.includes(r.asset)).map((r) => `${r.page}: ${r.asset}`);
  assert.deepEqual(missing, [], 'these assets can change without the ?v= stamp changing');
  for (const file of FRONTEND_VERSIONED_FILES) assert.ok(fs.existsSync(path.join(PUBLIC, file)), `${file} exists`);
  assert.equal(new Set(FRONTEND_VERSIONED_FILES).size, FRONTEND_VERSIONED_FILES.length, 'no duplicates');
});

test('every versioned asset is served with no-store headers, and the shared composer script is among them', async () => {
  const instance = createServerInstance();
  await new Promise<void>((resolve, reject) => { instance.listen(0, '127.0.0.1', () => resolve()); instance.once('error', reject); });
  const origin = `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
  try {
    const assets = [...new Set(referenced().map((r) => r.asset))];
    assert.ok(assets.includes('composer-keys.js'));
    for (const asset of assets) {
      const response = await fetch(`${origin}/${asset}`);
      assert.equal(response.status, 200, asset);
      assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate', `${asset} is not cacheable`);
      await response.arrayBuffer();
    }
  } finally {
    (instance as any).closeIdleConnections?.();
    (instance as any).closeAllConnections?.();
    await new Promise<void>((resolve) => instance.close(() => resolve()));
  }
});
