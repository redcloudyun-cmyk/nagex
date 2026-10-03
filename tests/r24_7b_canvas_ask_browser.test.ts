// R24.7B — Canvas Ask in REAL Chromium against the REAL production server (desktop 1440x900 and mobile 390x844).
//
// Provider credentials are scrubbed from the server's environment, so this
// file is deterministic and never calls a model. It certifies everything
// around the model call with real routing, real sessions and real stores:
// real document content in Canvas, route restore of an artifact outside Home's
// top 5, ownership, unsupported types, signed-out behavior, the exact request
// the client sends, the truthful "no model available" state, no mutation, EN/KR,
// the Home-embedded surface, and mobile layout.
// The answered path with a REAL model is certified by r24_7b_canvas_ask_live.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Page, Request } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';

declare const window: any;
declare const document: any;
declare const innerWidth: number;

let h: CanvasAskHarness;
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { await h?.close(); });

interface Surface { kind: 'desktop' | 'mobile'; region: string; text: string; ask: string; answer: string; send: string; title: string }
const DESKTOP: Surface = { kind: 'desktop', region: '#canvas-renderer-region', text: '#canvas-renderer-region .canvas-document-text', ask: '#canvas-ask-input', answer: '#canvas-ask-answer', send: '#view-canvas .canvas-ask-submit', title: '#canvas-artifact-title' };
const MOBILE: Surface = { kind: 'mobile', region: '#mh-canvas-renderer-region', text: '#mh-canvas-renderer-region .canvas-document-text', ask: '#mh-canvas-ask-input', answer: '#mh-canvas-ask-answer', send: '#mobile-view-canvas .mh-canvas-ask-submit', title: '#mh-canvas-artifact-title' };

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

async function openCanvas(page: Page, artifactId: string): Promise<void> {
  await page.goto(`${h.origin}/#canvas/${artifactId}`, { waitUntil: 'domcontentloaded' });
}
async function answerState(page: Page, s: Surface): Promise<string | null> { return page.getAttribute(s.answer, 'data-ask-state'); }
async function waitState(page: Page, s: Surface, state: string, timeout = 15000): Promise<void> {
  await page.waitForFunction(({ sel, st }: { sel: string; st: string }) => document.querySelector(sel)?.getAttribute('data-ask-state') === st, { sel: s.answer, st: state }, { timeout });
}
async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth);
}
function recordAskRequests(page: Page): { asks: Request[]; others: string[]; armed: boolean; mark(): void } {
  const rec = { asks: [] as Request[], others: [] as string[], armed: false, mark() { rec.armed = true; rec.others.length = 0; } };
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (r.method() === 'POST' && /^\/api\/v1\/artifacts\/[^/]+\/ask$/.test(u.pathname)) rec.asks.push(r);
    // Anything that could be a side channel or a mutation: any non-GET API call other than the ask itself,
    // or any chat / conversation / research / revision / variation call, issued AFTER `rec.mark()`.
    else if (rec.armed && u.pathname.startsWith('/api/') && (r.method() !== 'GET' || /\/api\/v1\/(ai\/chat|conversations|research)|\/revisions|\/variation/.test(u.pathname))) rec.others.push(`${r.method()} ${u.pathname}`);
  });
  return rec;
}

const DOC = ['# Launch plan', '', 'The launch codename is PELICAN-7314.', 'The budget is 42 thousand dollars.', '', '<script>window.__pwned = true</script> <img src=x onerror="window.__pwned = true">', ''].join('\n');

describe('R24.7B browser — desktop Focus Canvas', () => {
  it('shows the REAL document content read-only (as text, never executed) and no editor or placeholder', async () => {
    const u = h.user('d1');
    const seeded = h.seedDocument(u, { title: 'Launch plan', content: DOC });
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    await openCanvas(page, seeded.artifactId);
    await page.waitForSelector(DESKTOP.text);
    assert.equal(await page.textContent(DESKTOP.text), DOC);
    assert.equal(await page.textContent(DESKTOP.title), 'Launch plan');
    assert.equal(await page.evaluate(() => window.__pwned === true), false, 'document HTML/script must never execute');
    const region = await page.innerHTML(DESKTOP.region);
    assert.equal(/Metadata preview|Rich content editor|DOCUMENT Workspace|<textarea|contenteditable/i.test(region), false);
    assert.equal(await page.locator(`${DESKTOP.region} script, ${DESKTOP.region} img`).count(), 0, 'no element was created from document content');
    await ctx.close();
  });

  it('reopens an OLDER owned artifact (outside Home\'s newest five) by route after a reload; Home does not list it', async () => {
    const u = h.user('d2');
    const ids: Array<{ artifactId: string; content: string }> = [];
    for (let i = 0; i < 8; i++) {
      const content = `Older-restore document number ${i}`;
      const s = h.seedDocument(u, { title: `Doc ${i}`, content, at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
      ids.push({ artifactId: s.artifactId, content });
    }
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    const home = await page.request.get(`${h.origin}/api/v1/personal/home`, { headers: { cookie: `nagex_session=${u.sessionId}` } });
    const homeIds = ((await home.json()).recentCreations || []).map((c: any) => c.artifactProjection?.artifactId);
    assert.equal(homeIds.includes(ids[0].artifactId), false, 'the oldest artifact is NOT in Home\'s top-5 list');
    await openCanvas(page, ids[0].artifactId);
    await page.waitForSelector(DESKTOP.text);
    assert.equal(await page.textContent(DESKTOP.text), ids[0].content);
    await page.reload();
    await page.waitForSelector(DESKTOP.text);
    assert.equal(await page.textContent(DESKTOP.text), ids[0].content, 'survives a real reload');
    await ctx.close();
  });

  it('another user\'s artifact id and an unknown id are indistinguishable: the same not-found message, no content', async () => {
    const a = h.user('d3a');
    const b = h.user('d3b');
    const aDoc = h.seedDocument(a, { title: 'A secret', content: 'A-ONLY-SECRET-TEXT' });
    const ctx = await h.newContext('desktop', b);
    const page = await ctx.newPage();
    const outcome = async (id: string) => {
      await openCanvas(page, id);
      await page.waitForFunction(() => /could not be opened/.test(document.querySelector('#canvas-renderer-region')?.textContent || ''));
      return { text: await page.textContent(DESKTOP.region), title: await page.textContent(DESKTOP.title) };
    };
    const foreign = await outcome(aDoc.artifactId);
    await page.goto('about:blank');
    const unknown = await outcome('art_000000000000000000000000');
    assert.deepEqual(foreign, unknown);
    assert.equal(await page.content().then((c) => c.includes('A-ONLY-SECRET-TEXT') || c.includes('A secret')), false);
    await ctx.close();
  });

  it('IMAGE and RESEARCH: Ask is disabled with a truthful reason and NO request is ever sent', async () => {
    const u = h.user('d4');
    const img = h.seedOther(u, 'IMAGE', { title: 'A picture', preview: 'Image (1:1)' });
    const res = h.seedOther(u, 'RESEARCH', { title: 'Market research', preview: 'A 500 character preview of the research answer…' });
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    const rec = recordAskRequests(page);
    await openCanvas(page, img.artifactId);
    await page.waitForFunction((sel: string) => document.querySelector(sel)?.getAttribute('data-ask-state') === 'unsupported', DESKTOP.answer);
    assert.match((await page.textContent(DESKTOP.answer)) || '', /cannot inspect the content of this image/);
    assert.equal(await page.isDisabled(DESKTOP.ask), true);
    await page.evaluate((id: string) => window.NAGEX.restoreCanvasFromRoute(id), res.artifactId);
    await page.waitForFunction((sel: string) => /only a short preview is saved/.test(document.querySelector(sel)?.textContent || ''), DESKTOP.answer);
    assert.equal(await page.isDisabled(DESKTOP.ask), true);
    await page.evaluate(() => window.NAGEX.submitCanvasAsk()); // even a programmatic submit is refused client-side
    assert.equal(rec.asks.length, 0);
    // The server agrees if the client is bypassed.
    const direct = await page.request.post(`${h.origin}/api/v1/artifacts/${res.artifactId}/ask`, { data: { question: 'What did it find?' }, headers: { cookie: `nagex_session=${u.sessionId}` } });
    assert.equal(direct.status(), 422);
    assert.equal((await direct.json()).reason, 'RESEARCH_PREVIEW_ONLY');
    await ctx.close();
  });

  it('signed-out (Security Gate S1): the artifact itself is not served — no content, no Ask surface, no ask request (EN and KR)', async () => {
    // Before S1 an artifact in the legacy default principal's namespace was readable without a session (the recorded
    // IMAGE_BROWSER_AUTH_DEBT) and only Ask refused. S1 removed that fallback: a signed-out caller has no identity, so
    // the artifact read is 401 and nothing of it reaches the page.
    const seeded = h.seedDocument({ userId: 'usr_admin_001', tenantId: 'ten_production_01' }, { title: 'Default principal doc', content: 'Signed-out content.' });
    for (const locale of ['en', 'ko'] as const) {
      const ctx = await h.newContext('desktop', undefined, locale);
      const page = await ctx.newPage();
      const rec = recordAskRequests(page);
      const artifactResponse = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/artifacts/${seeded.artifactId}`);
      await openCanvas(page, seeded.artifactId);
      assert.equal((await artifactResponse).status(), 401);
      await page.waitForTimeout(800);
      assert.equal(await page.locator(DESKTOP.text).count(), 0, 'no document text is rendered for a signed-out visitor');
      assert.equal((await page.content()).includes('Signed-out content.'), false, 'the artifact content never reaches the page');
      assert.equal(rec.asks.length, 0);
      await ctx.close();
    }
  });

  // Security Gate S1 — the reachable "auth" state. The signed-out visitor can no longer open an artifact at all, so the
  // Ask "Sign in to ask" copy is now reached by a user who WAS signed in: they opened the artifact, and then the session
  // ended (revoked on another device, logout-all, expiry) while the page stayed open with its cookie still in the browser.
  // This drives the real production session store and the real server; nothing about authentication is faked.
  async function revokedSessionAsk(surface: Surface, kind: 'desktop' | 'mobile', locale: 'en' | 'ko', expectedAuthCopy: string): Promise<void> {
    const server = await import('../src/server_web.js');
    const user = h.user(`rv_${kind}_${locale}`);
    h.setLocale(user, locale);
    const seeded = h.seedDocument(user, { title: 'Revocable', content: DOC });
    const ctx = await h.newContext(kind, user, locale);
    const page = await ctx.newPage();
    const rec = recordAskRequests(page);
    await openCanvas(page, seeded.artifactId);
    await page.waitForSelector(surface.text);
    assert.equal(await page.textContent(surface.text), DOC, 'the signed-in user reads the artifact');

    // 1. While the session is live the Ask reaches the real pipeline (no model configured -> the truthful 503), proving the session works.
    await page.fill(surface.ask, 'What is the launch codename?');
    const [live] = await Promise.all([page.waitForResponse((r) => /\/ask$/.test(r.url())), page.click(surface.send)]);
    assert.equal(live.status(), 503);
    assert.equal((await live.json()).error, 'ASK_MODEL_UNAVAILABLE');
    await waitState(page, surface, 'error');

    // 2. End the session in the real store. The browser still holds the cookie.
    assert.equal(server.sessionStore.revokeSession(user.sessionId), true, 'the live session was revoked');
    assert.equal(server.sessionStore.getSession(user.sessionId), null);
    assert.equal(((await (await fetch(`${h.origin}/api/v1/auth/session`, { headers: { cookie: `nagex_session=${user.sessionId}` } })).json()) as { authenticated: boolean }).authenticated, false);

    // 3. Ask again from the same open page.
    rec.mark();
    await page.fill(surface.ask, 'Is this still answered?');
    const [refused] = await Promise.all([page.waitForResponse((r) => /\/ask$/.test(r.url())), page.click(surface.send)]);
    assert.equal(refused.status(), 401, 'the Ask is refused at the session boundary');
    const body = await refused.json();
    assert.equal(body.error, 'AUTHENTICATION_REQUIRED');
    assert.equal('answer' in body, false, 'no answer was produced');
    assert.equal('grounding' in body, false, 'the artifact was never read for grounding');

    // 4. The UI shows the authentication-required state with the localized copy, and fabricates nothing.
    await waitState(page, surface, 'auth');
    assert.equal((await page.textContent(surface.answer))?.trim(), expectedAuthCopy);
    assert.equal(await page.locator(`${surface.answer} .canvas-ask-answer-text`).count(), 0, 'no answer text');
    assert.equal(rec.asks.length, 2);
    assert.deepEqual(rec.others, [], 'no other call (chat, research, revision, variation, mutation) was made after the revocation');

    // 5. The same boundary applies to reading: after a reload the artifact is not served to the revoked session.
    const reread = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/artifacts/${seeded.artifactId}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal((await reread).status(), 401);
    await page.waitForTimeout(600);
    assert.equal((await page.content()).includes('PELICAN-7314'), false, 'artifact content is not shown to a revoked session');
    await ctx.close();
  }

  it('revoked session (Security Gate S1): after the session ends the Ask is refused with the authentication state — real session boundary, EN and KR on desktop', async () => {
    await revokedSessionAsk(DESKTOP, 'desktop', 'en', 'Sign in to ask about this artifact.');
    await revokedSessionAsk(DESKTOP, 'desktop', 'ko', '이 아티팩트에 대해 물어보려면 로그인하세요.');
  });

  it('revoked session (Security Gate S1): the mobile Canvas behaves the same (EN and KR)', async () => {
    await revokedSessionAsk(MOBILE, 'mobile', 'en', 'Sign in to ask about this artifact.');
    await revokedSessionAsk(MOBILE, 'mobile', 'ko', '이 아티팩트에 대해 물어보려면 로그인하세요.');
  });

  it('the client sends exactly { question, locale } to exactly one endpoint — no artifact content, owner, tenant or grounding — and nothing else', async () => {
    const u = h.user('d5');
    const seeded = h.seedDocument(u, { title: 'Launch plan', content: DOC });
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    const rec = recordAskRequests(page);
    await openCanvas(page, seeded.artifactId);
    await page.waitForSelector(DESKTOP.text);
    rec.mark();
    await page.fill(DESKTOP.ask, 'What is the budget?');
    await page.press(DESKTOP.ask, 'Enter');
    await waitState(page, DESKTOP, 'error');
    assert.equal(rec.asks.length, 1);
    assert.equal(new URL(rec.asks[0].url()).pathname, `/api/v1/artifacts/${seeded.artifactId}/ask`);
    const body = JSON.parse(rec.asks[0].postData() || '{}');
    assert.deepEqual(Object.keys(body).sort(), ['locale', 'question']);
    assert.equal(body.question, 'What is the budget?');
    assert.equal(body.locale, 'en');
    assert.deepEqual(rec.others, [], 'no main-chat, conversation, research, revision, variation or any other mutating call');
    await ctx.close();
  });

  it('with no model available the UI is truthful: an error, no answer, the question kept, input usable again (EN and KR)', async () => {
    const u = h.user('d6');
    const seeded = h.seedDocument(u, { title: 'Launch plan', content: DOC });
    for (const [locale, expected] of [['en', 'NAgex cannot answer right now because no model is available.'], ['ko', '사용할 수 있는 모델이 없어 지금은 답할 수 없어요.']] as const) {
      h.setLocale(u, locale);
      const ctx = await h.newContext('desktop', u, locale);
      const page = await ctx.newPage();
      await openCanvas(page, seeded.artifactId);
      await page.waitForSelector(DESKTOP.text);
      await page.fill(DESKTOP.ask, 'What is the launch codename?');
      const [response] = await Promise.all([page.waitForResponse((r) => /\/ask$/.test(r.url())), page.click(DESKTOP.send)]);
      assert.equal(response.status(), 503);
      assert.equal((await response.json()).error, 'ASK_MODEL_UNAVAILABLE');
      await waitState(page, DESKTOP, 'error');
      assert.equal((await page.textContent(DESKTOP.answer))?.trim(), expected);
      assert.equal(await page.inputValue(DESKTOP.ask), 'What is the launch codename?', 'the question is kept so the user can retry');
      assert.equal(await page.isDisabled(DESKTOP.ask), false);
      assert.equal(await page.locator(`${DESKTOP.answer} .canvas-ask-answer-text`).count(), 0, 'no fabricated answer');
      await ctx.close();
    }
  });

  it('asking mutates nothing: the stored document is byte-identical, and no revision/variation/save call was made', async () => {
    const u = h.user('d7');
    const seeded = h.seedDocument(u, { title: 'Launch plan', content: DOC });
    const before = h.documentFileHash(seeded.documentId);
    const artifactsBefore = h.artifactStore.list(u.tenantId, u.userId, 50).length;
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    const rec = recordAskRequests(page);
    await openCanvas(page, seeded.artifactId);
    await page.waitForSelector(DESKTOP.text);
    rec.mark();
    for (const q of ['Rewrite this shorter and save it.', 'Delete this document.']) {
      await page.fill(DESKTOP.ask, q);
      await page.click(DESKTOP.send);
      await waitState(page, DESKTOP, 'error');
    }
    assert.equal(h.documentFileHash(seeded.documentId), before);
    assert.equal(h.artifactStore.list(u.tenantId, u.userId, 50).length, artifactsBefore, 'no derived artifact was created');
    assert.deepEqual(rec.others, []);
    await ctx.close();
  });

  it('opening a different artifact resets the previous Ask input and answer (no stale answer on another artifact)', async () => {
    const u = h.user('d8');
    const one = h.seedDocument(u, { title: 'One', content: 'first document' });
    const two = h.seedDocument(u, { title: 'Two', content: 'second document' });
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    await openCanvas(page, one.artifactId);
    await page.waitForSelector(DESKTOP.text);
    await page.fill(DESKTOP.ask, 'first question');
    await page.click(DESKTOP.send);
    await waitState(page, DESKTOP, 'error');
    await page.evaluate((id: string) => window.NAGEX.restoreCanvasFromRoute(id), two.artifactId);
    await page.waitForFunction(() => document.querySelector('#canvas-renderer-region .canvas-document-text')?.textContent === 'second document');
    assert.equal(await page.isHidden(DESKTOP.answer), true);
    assert.equal(await page.inputValue(DESKTOP.ask), '');
    await ctx.close();
  });

  it('ANALYSIS: the Canvas shows the saved summary Ask is grounded in, labeled as a summary', async () => {
    const u = h.user('d9');
    const seeded = h.seedAnalysis(u, { title: 'Contract review', summary: 'The contract renews on 1 March and caps liability at 50k.' });
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    await openCanvas(page, seeded.artifactId);
    await page.waitForSelector(DESKTOP.text);
    assert.equal(await page.textContent(DESKTOP.text), 'The contract renews on 1 March and caps liability at 50k.');
    assert.match((await page.textContent(`${DESKTOP.region} .canvas-document-caption`)) || '', /Saved summary of this file/);
    assert.equal(await page.isDisabled(DESKTOP.ask), false, 'ANALYSIS Ask is supported (summary-grounded)');
    const body = await page.content();
    assert.equal(/private-name\.pdf|object-storage\/private/.test(body), false, 'no file name or storage path reaches the page');
    await ctx.close();
  });

  it('EN/KR: the Ask placeholder and intro are localized and no raw i18n key leaks', async () => {
    const u = h.user('d10');
    const seeded = h.seedDocument(u, { title: 'Launch plan', content: DOC });
    for (const [locale, placeholder, intro] of [['en', /about this artifact/i, /never changes it/], ['ko', /아티팩트에 대해/, /아무것도 바꾸지 않아요/]] as const) {
      h.setLocale(u, locale);
      const ctx = await h.newContext('desktop', u, locale);
      const page = await ctx.newPage();
      await openCanvas(page, seeded.artifactId);
      await page.waitForSelector(DESKTOP.text);
      assert.match((await page.getAttribute(DESKTOP.ask, 'placeholder')) || '', placeholder);
      assert.match((await page.textContent('#view-canvas .canvas-agent-empty')) || '', intro);
      assert.equal(/\bcanvas\.[a-zA-Z]+\b/.test((await page.innerText('#view-canvas')) || ''), false, 'no raw canvas.* key in visible text');
      await ctx.close();
    }
  });
});

describe('R24.7B browser — Home embedded Canvas', () => {
  it('Ask on Home resolves ITS OWN artifact (not the Focus state) and shows the truthful result in the Home answer region', async () => {
    const u = h.user('h1');
    const seeded = h.seedDocument(u, { title: 'Home doc', content: 'Home embedded document content.' });
    const ctx = await h.newContext('desktop', u);
    const page = await ctx.newPage();
    const rec = recordAskRequests(page);
    await page.goto(`${h.origin}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#home-embedded-canvas[data-artifact-id]');
    assert.equal(await page.getAttribute('#home-embedded-canvas', 'data-artifact-id'), seeded.artifactId);
    assert.equal(await page.evaluate(() => !window.NAGEX._canvasState || window.NAGEX._canvasState.active !== true), true, 'Focus Canvas state is not active: Home must not depend on it');
    await page.fill('#home-canvas-ask-input', 'What does this say?');
    await page.click('#home-agent-panel .canvas-ask-submit');
    await waitState(page, { ...DESKTOP, answer: '#home-canvas-ask-answer' }, 'error');
    assert.equal(rec.asks.length, 1);
    assert.equal(new URL(rec.asks[0].url()).pathname, `/api/v1/artifacts/${seeded.artifactId}/ask`);
    await ctx.close();
  });
});

describe('R24.7B browser — mobile 390x844', () => {
  it('real document content, usable input, visible error state, no horizontal overflow (long unbroken text and long lines)', async () => {
    const u = h.user('m1');
    const long = ['# Mobile layout', 'W'.repeat(600), ('Long sentence for wrapping on a narrow phone screen. ').repeat(80), 'https://example.com/' + 'a'.repeat(300)].join('\n\n');
    const seeded = h.seedDocument(u, { title: 'Mobile doc', content: long });
    const ctx = await h.newContext('mobile', u);
    const page = await ctx.newPage();
    await openCanvas(page, seeded.artifactId);
    await page.waitForSelector(MOBILE.text);
    assert.equal(await page.textContent(MOBILE.text), long);
    assert.ok((await horizontalOverflow(page)) <= 0, `overflow ${await horizontalOverflow(page)}px`);
    const input = page.locator(MOBILE.ask);
    await input.scrollIntoViewIfNeeded();
    const box = await input.boundingBox();
    assert.ok(box && box.width > 150 && box.height >= 40 && box.x >= 0 && box.x + box.width <= 390, `input box ${JSON.stringify(box)}`);
    await input.fill('What is this about?');
    await page.click(MOBILE.send);
    await waitState(page, MOBILE, 'error');
    const answerBox = await page.locator(MOBILE.answer).boundingBox();
    assert.ok(answerBox && answerBox.x >= 0 && answerBox.x + answerBox.width <= 390 && answerBox.height > 20, `answer box ${JSON.stringify(answerBox)}`);
    assert.equal(await page.locator(MOBILE.answer).isVisible(), true);
    assert.ok((await horizontalOverflow(page)) <= 0);
    assert.equal(await page.isDisabled(MOBILE.ask), false);
    await ctx.close();
  });

  it('KR on mobile, route restore of an older artifact, and the unsupported IMAGE reason', async () => {
    const u = h.user('m2');
    const old = h.seedDocument(u, { title: '오래된 문서', content: '모바일 한국어 문서 내용입니다.', at: new Date(Date.UTC(2025, 0, 1)).toISOString() });
    for (let i = 0; i < 6; i++) h.seedDocument(u, { title: `newer ${i}`, content: `n${i}`, at: new Date(Date.UTC(2026, 0, 1 + i)).toISOString() });
    const img = h.seedOther(u, 'IMAGE', { title: '그림', preview: 'Image (1:1)' });
    h.setLocale(u, 'ko');
    const ctx = await h.newContext('mobile', u, 'ko');
    const page = await ctx.newPage();
    await openCanvas(page, old.artifactId);
    await page.waitForSelector(MOBILE.text);
    assert.equal(await page.textContent(MOBILE.text), '모바일 한국어 문서 내용입니다.');
    assert.match((await page.getAttribute(MOBILE.ask, 'placeholder')) || '', /아티팩트에 대해/);
    await page.evaluate((id: string) => window.NAGEX.restoreCanvasFromRoute(id), img.artifactId);
    await page.waitForFunction((sel: string) => document.querySelector(sel)?.getAttribute('data-ask-state') === 'unsupported', MOBILE.answer);
    assert.match((await page.textContent(MOBILE.answer)) || '', /이미지의 내용을 확인할 수 없어서/);
    assert.equal(await page.isDisabled(MOBILE.ask), true);
    assert.ok((await horizontalOverflow(page)) <= 0);
    await ctx.close();
  });

  it('mobile signed-out and not-owned behave like desktop', async () => {
    const a = h.user('m3a');
    const b = h.user('m3b');
    const aDoc = h.seedDocument(a, { title: 'A mobile secret', content: 'A-MOBILE-SECRET' });
    const ctx = await h.newContext('mobile', b);
    const page = await ctx.newPage();
    await openCanvas(page, aDoc.artifactId);
    await page.waitForFunction(() => /could not be opened/.test(document.querySelector('#mh-canvas-renderer-region')?.textContent || ''));
    assert.equal((await page.content()).includes('A-MOBILE-SECRET'), false);
    await ctx.close();

    // Signed-out (S1): the artifact read is 401 — nothing renders, nothing can be asked.
    const seeded = h.seedDocument({ userId: 'usr_admin_001', tenantId: 'ten_production_01' }, { title: 'Default mobile doc', content: 'Signed-out mobile content.' });
    const anon = await h.newContext('mobile');
    const p2 = await anon.newPage();
    const recAnon = recordAskRequests(p2);
    const anonArtifactResponse = p2.waitForResponse((r) => new URL(r.url()).pathname === `/api/v1/artifacts/${seeded.artifactId}`);
    await openCanvas(p2, seeded.artifactId);
    assert.equal((await anonArtifactResponse).status(), 401);
    await p2.waitForTimeout(800);
    assert.equal(await p2.locator(MOBILE.text).count(), 0);
    assert.equal((await p2.content()).includes('Signed-out mobile content.'), false);
    assert.equal(recAnon.asks.length, 0);
    await anon.close();
  });
});

// Keep crypto referenced for hash assertions in future cases.
void sha;
