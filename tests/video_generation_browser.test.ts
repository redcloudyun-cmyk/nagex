// "Make me a video" through the whole production path in REAL Chromium: front end -> input router -> /api/v1/creations/videos (price + approval) -> the job service ->
// the real Higgsfield adapter -> a LOOPBACK stand-in written from Higgsfield's public documentation (selected through NAGEX_VIDEO_HIGGSFIELD_BASE_URL).
//
// What a pass proves: NAgex's own chain - the price and the approval come first and nothing is sent before them, declining sends nothing, the states on screen are the
// job record's, a finished MP4 is stored for its owner and played / downloaded from NAgex's own path, a refresh keeps the work, failures are said plainly in both languages.
// What it does NOT prove: that Higgsfield accepts the request or what a real model draws. No real provider is contacted and nothing was spent.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';
import { fakeHiggsfield, type FakeHiggsfield } from './_fake_higgsfield.js';
import { makeMp4 } from './_mp4_fixture.js';

declare const document: any;
declare const window: any;

let h: CanvasAskHarness;
let hf: FakeHiggsfield;

before(async () => {
  hf = await fakeHiggsfield({ usd: 0.2, queuedPolls: 0, inProgressPolls: 1 });
  h = await startCanvasAskHarness({
    scrubProviders: true,
    env: {
      NAGEX_HIGGSFIELD_KEY_ID: hf.keyId,
      NAGEX_HIGGSFIELD_KEY_SECRET: hf.keySecret,
      NAGEX_VIDEO_HIGGSFIELD_BASE_URL: hf.baseUrl,
      NAGEX_VEO_ENABLED: '0',
    },
  });
});
after(async () => {
  await h?.close();
  await hf?.close();
});

async function contextFor(label: string, locale: 'en' | 'ko', kind: 'desktop' | 'mobile' = 'desktop'): Promise<{ ctx: BrowserContext; user: ReturnType<CanvasAskHarness['user']> }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const ctx = await h.newContext(kind, user, locale);
  return { ctx, user };
}

async function openMain(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 }).catch(() => undefined);
}

async function ask(page: Page, text: string, mobile = false): Promise<void> {
  await page.fill('#main-surface-input', text);
  if (mobile) await page.click('#main-send'); else await page.press('#main-surface-input', 'Enter');
}

const blockState = (page: Page) => page.locator('.main-video-block').last().getAttribute('data-video-state');
const waitState = (page: Page, state: string, timeout = 60000) =>
  page.waitForFunction((s: string) => { const b = document.querySelectorAll('.main-video-block'); return b.length > 0 && b[b.length - 1].getAttribute('data-video-state') === s; }, state, { timeout });

describe('video creation through the production path', () => {
  it('ko: price and approval first (nothing sent), then a real job, real states, a stored MP4 shown, played from NAgex and downloadable; other accounts get nothing', async () => {
    const submitsBefore = hf.submits.length;
    const { ctx } = await contextFor('vid_ko', 'ko');
    const page = await ctx.newPage();
    await openMain(page);
    // the Video shortcut is enabled because a video service really exists (it stays "not available yet" otherwise)
    await page.waitForFunction(() => document.querySelector('[data-main-mode="VIDEO"]')?.getAttribute('aria-disabled') === 'false', undefined, { timeout: 15000 });
    await ask(page, '10초짜리 여우가 눈밭을 달리는 영상을 만들어줘');

    await page.waitForSelector('.main-video-block[data-video-state="AWAITING_APPROVAL"]', { timeout: 30000 });
    const card = page.locator('.main-video-block').last();
    const cardText = await card.innerText();
    assert.match(cardText, /승인 대기 중/);
    assert.match(cardText, /\$0\.20/, 'the price is shown before anything is sent');
    assert.match(cardText, /Higgsfield/, 'the outside service that would receive the request is named');
    assert.match(cardText, /10\s*초/, 'the length the person asked for');
    assert.equal(hf.submits.length, submitsBefore, 'NOTHING was sent to the video service before approval');
    assert.ok(hf.estimates.length >= 1, 'only a price was asked for');
    assert.match((await card.locator('.main-video-approve').innerText()), /승인하고 시작.*\$0\.20/);

    await card.locator('.main-video-approve').click();
    await page.waitForSelector('.main-video-block[data-video-state="PENDING"], .main-video-block[data-video-state="RUNNING"], .main-video-block[data-video-state="COMPLETED"]', { timeout: 30000 });
    assert.equal(hf.submits.length, submitsBefore + 1, 'exactly one paid job started, after approval');
    assert.ok(hf.submits.at(-1)!.idempotencyKey, 'with an idempotency key');
    assert.match(String(hf.submits.at(-1)!.body.prompt), /여우/);
    assert.equal(hf.submits.at(-1)!.body.duration, 10);
    assert.equal(hf.submits.at(-1)!.authorization, `Key ${hf.keyId}:${hf.keySecret}`);

    await waitState(page, 'COMPLETED', 90000);
    const done = await page.locator('.main-video-block').last().innerText();
    assert.match(done, /영상이 준비됐어요/);
    assert.ok(!/RESOURCE|PROVIDER_|undefined|null|\[object/.test(done), 'no internal text on screen');

    await page.waitForSelector('video.main-video-player', { timeout: 20000 });
    const src = (await page.locator('video.main-video-player').getAttribute('src')) || '';
    assert.match(src, /^\/api\/v1\/creations\/videos\/vid_[0-9a-f]{24}\/media$/, 'played from NAgex\'s own path, never a provider address');
    const served = await ctx.request.get(`${h.origin}${src}`);
    assert.equal(served.status(), 200);
    assert.match(served.headers()['content-type'] || '', /video\/mp4/);
    assert.deepEqual(Buffer.from(await served.body()), makeMp4(), 'what is served is exactly what the provider produced');
    const ranged = await ctx.request.get(`${h.origin}${src}`, { headers: { range: 'bytes=0-15' } });
    assert.equal(ranged.status(), 206);
    assert.equal((await ranged.body()).length, 16);
    const download = await ctx.request.get(`${h.origin}${src}?download=1`);
    assert.match(download.headers()['content-disposition'] || '', /^attachment; filename="nagex-vid_/);
    const links = await page.locator('a.main-result-download, a.main-video-download').evaluateAll((els: any[]) => els.map((e) => e.getAttribute('href')));
    assert.ok(links.some((l: string) => /\/media\?download=1$/.test(l)), 'a download link is on screen');

    // it is a creation: listed with the person's artifacts, and still there after a refresh
    const artifacts = await (await ctx.request.get(`${h.origin}/api/v1/artifacts`)).json();
    const videoArtifact = (artifacts.artifacts || artifacts.items || []).find((a: any) => a.type === 'VIDEO' || a.artifactType === 'VIDEO');
    assert.ok(videoArtifact, 'the video is in the creation history');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#main-surface-input', { timeout: 20000 });
    const reopened = await page.evaluate(async (id: string) => window.NAGEX_MAIN_ACTIONS.openArtifact(id), videoArtifact.artifactId);
    assert.equal(reopened, true);
    await page.waitForSelector('video.main-video-player', { timeout: 20000 });
    assert.equal((await ctx.request.get(`${h.origin}${src}`)).status(), 200, 'the file survives the refresh');

    const { ctx: other } = await contextFor('vid_ko_other', 'ko');
    assert.equal((await other.request.get(`${h.origin}${src}`)).status(), 404, 'another account cannot play or download it');
    assert.deepEqual((await (await other.request.get(`${h.origin}/api/v1/creations/videos`)).json()).videos, []);
    await other.close();
    await ctx.close();
  });

  it('en: declining sends nothing; the same request is not charged twice by a double click; a refresh brings the waiting card back', async () => {
    const submitsBefore = hf.submits.length;
    const { ctx } = await contextFor('vid_en', 'en');
    const page = await ctx.newPage();
    await openMain(page);
    await ask(page, 'Create a 6 second video of paper lanterns rising over a river');
    await page.waitForSelector('.main-video-block[data-video-state="AWAITING_APPROVAL"]', { timeout: 30000 });
    assert.match(await page.locator('.main-video-block').last().innerText(), /Waiting for your approval - nothing has been sent/);

    // a refresh while waiting: the card comes back (resumed from the job record) and can still be decided
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.main-video-block[data-video-state="AWAITING_APPROVAL"]', { timeout: 30000 });
    assert.equal(hf.submits.length, submitsBefore);

    await page.locator('.main-video-block').last().locator('.main-video-decline').click();
    await waitState(page, 'DECLINED', 20000);
    assert.match(await page.locator('.main-video-block').last().innerText(), /Not started - nothing was sent/);
    assert.equal(hf.submits.length, submitsBefore, 'declined: nothing was sent');
    assert.equal(await page.locator('.main-video-block').last().locator('.main-video-approve').count(), 0, 'a declined video cannot be approved from the card');

    // double click approve on a fresh request: one paid job
    await ask(page, 'Create a 6 second video of a sailboat crossing a calm bay');
    await page.waitForSelector('.main-video-block[data-video-state="AWAITING_APPROVAL"]', { timeout: 30000 });
    const approve = page.locator('.main-video-block').last().locator('.main-video-approve');
    await approve.dblclick();
    await waitState(page, 'COMPLETED', 90000);
    assert.equal(hf.submits.length, submitsBefore + 1, 'a double click started one job');
    await ctx.close();
  });

  it('en: a service that refuses the request (no credit) is reported as unavailable with the reason, nothing is made and no video is shown', async () => {
    const { ctx } = await contextFor('vid_en_credit', 'en');
    const page = await ctx.newPage();
    await openMain(page);
    hf.opts.submitFailures!.push(403);
    await ask(page, 'Create a 5 second video of fog rolling over mountains');
    await page.waitForSelector('.main-video-block[data-video-state="AWAITING_APPROVAL"]', { timeout: 30000 });
    await page.locator('.main-video-block').last().locator('.main-video-approve').click();
    await waitState(page, 'UNAVAILABLE', 30000);
    const text = await page.locator('.main-video-block').last().innerText();
    assert.match(text, /The video service can't take this right now/);
    assert.match(text, /may be out of credit/);
    assert.ok(!/PROVIDER_INSUFFICIENT_CREDITS|detail|scripted 403/.test(text), 'no internal code or raw provider text');
    assert.equal(await page.locator('video.main-video-player').count(), 0, 'no video is presented');
    await ctx.close();
  });

  it('ko: a job the service fails is said as failed, in Korean, with the service\'s own reason kept out of the way; nothing is stored', async () => {
    const { ctx } = await contextFor('vid_ko_fail', 'ko');
    const page = await ctx.newPage();
    await openMain(page);
    const previous = { final: hf.opts.finalState, polls: hf.opts.inProgressPolls };
    hf.opts.finalState = 'nsfw';
    hf.opts.inProgressPolls = 0;
    try {
      await ask(page, '5초짜리 안개 낀 산 영상을 만들어줘');
      await page.waitForSelector('.main-video-block[data-video-state="AWAITING_APPROVAL"]', { timeout: 30000 });
      await page.locator('.main-video-block').last().locator('.main-video-approve').click();
      await waitState(page, 'FAILED', 60000);
      const text = await page.locator('.main-video-block').last().innerText();
      assert.match(text, /영상을 만들지 못했어요/);
      assert.match(text, /내용상의 이유로 이 요청을 거절/);
      assert.equal(await page.locator('video.main-video-player').count(), 0);
    } finally {
      hf.opts.finalState = previous.final; hf.opts.inProgressPolls = previous.polls;
    }
    await ctx.close();
  });

  it('phones (390px): the card fits, nothing overflows sideways, and the buttons are touch-sized', async () => {
    const { ctx } = await contextFor('vid_mobile', 'en', 'mobile');
    const page = await ctx.newPage();
    await openMain(page);
    await ask(page, 'Create a 5 second video of a cat walking on a rooftop', true);
    await page.waitForSelector('.main-video-block[data-video-state="AWAITING_APPROVAL"]', { timeout: 30000 });
    const metrics = await page.evaluate(() => {
      const block = document.querySelector('.main-video-block:last-of-type') as any || document.querySelectorAll('.main-video-block')[document.querySelectorAll('.main-video-block').length - 1] as any;
      const rect = block.getBoundingClientRect();
      const buttons = Array.from(block.querySelectorAll('button')).map((b: any) => b.getBoundingClientRect().height);
      return { width: Math.round(rect.width), viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, buttons };
    });
    assert.ok(metrics.scrollWidth <= metrics.viewport + 1, `no horizontal scroll (${metrics.scrollWidth} > ${metrics.viewport})`);
    assert.ok(metrics.width <= metrics.viewport, 'the card fits the screen');
    assert.ok(metrics.buttons.length >= 2 && metrics.buttons.every((height: number) => height >= 40), `touch-size buttons: ${metrics.buttons}`);
    await ctx.close();
  });
});
