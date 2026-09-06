import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { FRONTEND_BUILD_VERSION, server } from '../src/server_web.js';

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('GET /privacy and /terms are publicly served clean URLs with no login required', async () => {
  await withServer(async (origin) => {
    for (const pathname of ['/privacy', '/terms']) {
      const response = await fetch(`${origin}${pathname}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/);
      assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    }
  });
});

test('Privacy page discloses OAuth handling, no-sale/no-ads, human approval, disconnect, and retention', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/privacy`)).text();
    assert.doesNotMatch(html, /__NAGEX_BUILD_VERSION__/);
    assert.match(html, new RegExp(`legal\\.js\\?v=${FRONTEND_BUILD_VERSION}`));
    assert.match(html, /explicitly grant consent/i);
    assert.match(html, /does not sell your Google user data/i);
    assert.match(html, /does not use your Google user data for advertising/i);
    assert.match(html, /never creates, modifies, or deletes a calendar event without your explicit approval/i);
    assert.match(html, /stored only on the NAgex server/i);
    assert.match(html, /never (?:sent to|be sent to|be exposed).*browser JavaScript|never.*browser JavaScript/i);
    assert.match(html, /disconnect Google Calendar at any time/i);
    assert.match(html, /revoke NAgex's access/i);
    assert.match(html, /Data Retention/i);
    assert.match(html, /redcloudyun@gmail\.com/);
  });
});

test('Terms page identifies test/development status, user approval responsibility, third-party terms, and availability disclaimer', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/terms`)).text();
    assert.doesNotMatch(html, /__NAGEX_BUILD_VERSION__/);
    assert.match(html, /test and development/i);
    assert.match(html, /responsible for reviewing the exact action/i);
    assert.match(html, /subject to their own terms of service/i);
    assert.match(html, /does not guarantee uninterrupted/i);
    assert.match(html, /redcloudyun@gmail\.com/);
  });
});

test('both legal pages ship an EN block visible by default and a KR block hidden by default', async () => {
  await withServer(async (origin) => {
    for (const pathname of ['/privacy', '/terms']) {
      const html = await (await fetch(`${origin}${pathname}`)).text();
      assert.match(html, /<div data-lang="en">/);
      assert.match(html, /<div data-lang="kr" hidden>/);
    }
  });
});

test('the app homepage links to /privacy and /terms', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /href="\/privacy"/);
    assert.match(html, /href="\/terms"/);
  });
});
