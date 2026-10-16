// "Make me an image" through the whole production path, in REAL Chromium: the front end -> the input router -> /api/v1/creations/generate -> ImageExecutor ->
// the real GoogleImageAdapter -> a LOCAL stand-in for the Generative Language API (loopback, selected through NAGEX_IMAGE_GOOGLE_BASE_URL).
//
// What a pass proves: NAgex's own chain (request, provider call, stored bytes, canonical owner-only serving, preview, download link, truthful failure text in both
// languages). What it does NOT prove: that Google accepts the request or what a real model draws - the live check needs an image-capable quota on the key and is
// recorded separately in the sprint evidence. No real provider is contacted (every provider credential is scrubbed, the only configured image service is the loopback one).
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const document: any;

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const FAKE_KEY = 'AIzaSyLOOPBACK-STAND-IN-KEY-0000000000';
const RAW_PROVIDER_TEXT = 'You exceeded your current quota (raw english provider text)';

let mode: 'ok' | 'quota' | 'auth' = 'ok';
const received: Array<{ url?: string; key?: string | string[]; prompt: string }> = [];
let google: http.Server;
let h: CanvasAskHarness;

before(async () => {
  google = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let prompt = '';
      try { prompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).contents?.[0]?.parts?.[0]?.text ?? ''; } catch { /* not json */ }
      received.push({ url: req.url, key: req.headers['x-goog-api-key'], prompt });
      res.writeHead(mode === 'ok' ? 200 : mode === 'quota' ? 429 : 403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mode === 'ok'
        ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_1X1.toString('base64') } }] }, finishReason: 'STOP' }] }
        : { error: { status: mode === 'quota' ? 'RESOURCE_EXHAUSTED' : 'PERMISSION_DENIED', message: RAW_PROVIDER_TEXT } }));
    });
  });
  await new Promise<void>((resolve) => google.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(google.address() as AddressInfo).port}/v1beta`;
  h = await startCanvasAskHarness({
    scrubProviders: true,
    env: { NAGEX_IMAGE_GOOGLE_BASE_URL: base, NAGEX_GOOGLE_API_KEY: FAKE_KEY, NAGEX_OPENAI_API_KEY: '' },
  });
});
after(async () => {
  await h?.close();
  google?.closeAllConnections?.();
  await new Promise<void>((resolve) => google.close(() => resolve()));
});

async function contextFor(label: string, locale: 'en' | 'ko'): Promise<{ ctx: BrowserContext; user: ReturnType<CanvasAskHarness['user']> }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const ctx = await h.newContext('desktop', user, locale);
  return { ctx, user };
}

async function openMain(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}

async function ask(page: Page, text: string): Promise<void> {
  await page.fill('#main-surface-input', text);
  await page.click('#main-send');
}

describe('image creation through the production path', () => {
  it('ko: the request becomes a stored image - provider called with the person\'s words, preview shown, owner-only serving, download link, exact bytes', async () => {
    mode = 'ok';
    received.length = 0;
    const { ctx } = await contextFor('img_ok_ko', 'ko');
    const page = await ctx.newPage();
    await openMain(page);
    await ask(page, '벚꽃이 핀 한옥 마을의 이미지를 만들어줘');

    await page.waitForSelector('.main-image-page img', { timeout: 60000 });
    const img = page.locator('.main-image-page img');
    await page.waitForFunction(() => { const i = document.querySelector('.main-image-page img') as any; return i && i.complete && i.naturalWidth > 0; }, undefined, { timeout: 20000 });
    const src = (await img.getAttribute('src')) || '';
    assert.match(src, /^\/api\/v1\/creations\/images\/img_[0-9a-f]{24}$/, 'NAgex-owned image path, never a provider URL');

    assert.equal(received.length, 1, 'exactly one provider call');
    assert.match(received[0].prompt, /한옥/, 'the person\'s own words reach the provider');
    assert.equal(received[0].key, FAKE_KEY, 'the key travels in a header');
    assert.ok(!String(received[0].url).includes('key='), 'never in the URL');

    const link = page.locator('.main-image-page a.main-result-download');
    assert.equal(await link.count(), 1);
    assert.equal((await link.textContent())?.trim(), '이미지 내려받기');
    assert.equal(await link.getAttribute('href'), src);
    assert.match((await link.getAttribute('download')) || '', /^nagex-img_[0-9a-f]{24}\.png$/);

    const served = await ctx.request.get(`${h.origin}${src}`);
    assert.equal(served.status(), 200);
    assert.match(served.headers()['content-type'] || '', /image\/png/);
    assert.deepEqual(Buffer.from(await served.body()), PNG_1X1, 'what is served is exactly what the provider produced');

    // another account gets the same answer as for an image that does not exist
    const { ctx: other } = await contextFor('img_ok_ko_other', 'ko');
    const denied = await other.request.get(`${h.origin}${src}`);
    assert.equal(denied.status(), 404);
    await other.close();
    await ctx.close();
  });

  for (const [locale, mode_, prompt, expected] of [
    ['ko', 'quota', '바다 위에 뜬 등대 이미지를 만들어줘', /사용 한도에 도달해서 이미지를 만들지 못했어요/],
    ['en', 'quota', 'Create an image of a lighthouse over the sea', /usage limit right now, so no image was created/],
    ['ko', 'auth', '숲속의 오두막 이미지를 만들어줘', /인증 정보를 받아들이지 않아서 이미지를 만들지 못했어요/],
  ] as const) {
    it(`${locale}: a provider ${mode_} failure is said plainly in the screen's language - no image, no raw provider text, no fake success`, async () => {
      mode = mode_;
      received.length = 0;
      const { ctx } = await contextFor(`img_fail_${locale}_${mode_}`, locale);
      const page = await ctx.newPage();
      await openMain(page);
      await ask(page, prompt);

      await page.waitForFunction((re: string) => new RegExp(re).test(document.querySelector('#main-thread-card')?.innerText || ''), expected.source, { timeout: 60000 });
      const text = await page.locator('#main-thread-card').innerText();
      assert.match(text, expected);
      assert.ok(!text.includes(RAW_PROVIDER_TEXT), 'the provider\'s own English text is not shown');
      assert.ok(!/RESOURCE_EXHAUSTED|PROVIDER_QUOTA_EXCEEDED|PERMISSION_DENIED|PROVIDER_AUTH_FAILED/.test(text), 'no internal code is shown');
      assert.equal(await page.locator('.main-image-page img').count(), 0, 'no image is presented');
      assert.equal(received.length, 1);
      await ctx.close();
    });
  }
});
