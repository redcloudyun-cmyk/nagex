// R26-B in REAL Chromium against the PRODUCTION server: "방금 만든 회의를 한 시간 늦춰줘" from the Main input to a confirmed change on the calendar. The real routing, plan sealing, approval store, approval
// card, task runner, capability broker, calendar service and execution pipeline run unchanged; only Google's REST API is a local fake (tests/_fake_google_calendar.ts: ids, 409 / 410, offsets and injectable
// faults). No model is asked: moving an event is planned by NAgex from the person's words. A pass proves NAgex's own chain and honesty; it is not a live Google write (that needs an authorized account).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';
import { createFakeGoogleCalendar } from './_fake_google_calendar.js';
import { zonedParts } from '../src/common/time-context.js';

declare const document: any;

let h: CanvasAskHarness;
const fake = createFakeGoogleCalendar();
const realFetch = globalThis.fetch;
let tokenStore: { saveForPrincipal: (tenantId: string, principalId: string, tokens: any) => void };
let scope = '';

before(async () => {
  // Google's API host is answered by the fake; everything else is untouched. The server resolves global fetch at call time.
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input?.url ?? input);
    return url.startsWith('https://www.googleapis.com/calendar/v3/') ? fake.fetch(input, init) : realFetch(input, init);
  }) as typeof fetch;
  h = await startCanvasAskHarness({ scrubProviders: true, env: { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_REDIRECT_URI: 'https://nagex-test.invalid/cb' } });
  tokenStore = (await import('../src/integrations/google/token.store.js')).googleTokenStore as any;
  scope = (await import('../src/integrations/google/oauth.client.js')).GOOGLE_CALENDAR_SCOPES.join(' ');
});
after(async () => { await h?.close(); globalThis.fetch = realFetch; });

async function contextFor(user: DisposableUser, locale: 'en' | 'ko'): Promise<BrowserContext> {
  const base = await h.newContext('desktop', user, locale);
  const ctx = await h.browser.newContext({ viewport: { width: 1440, height: 900 }, locale: locale === 'ko' ? 'ko-KR' : 'en-US', timezoneId: 'Asia/Seoul' });
  await ctx.addCookies(await base.cookies());
  await ctx.addInitScript((l: string) => { try { localStorage.setItem('nagex_locale', l); } catch { /* storage unavailable */ } }, locale);
  await base.close();
  return ctx;
}

async function openHome(page: Page): Promise<void> {
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
}

function connectedUser(label: string, locale: 'en' | 'ko'): DisposableUser {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  tokenStore.saveForPrincipal(user.tenantId, user.userId, { accessToken: `at_${label}`, refreshToken: `rt_${label}`, expiresAt: Date.now() + 3600_000, scope });
  return user;
}

const tomorrow = (hour: number, minute = 0) => {
  const t = zonedParts(Date.now() + 24 * 3600_000, 'Asia/Seoul');
  return `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

// the meeting is created the real way: request approval -> the person's approval -> create (through the production HTTP routes)
async function createMeeting(page: Page, summary: string, startHour: number): Promise<string> {
  return page.evaluate(async ({ summary, start, end }: { summary: string; start: string; end: string }) => {
    const post = async (path: string, body: unknown) => (await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const payload = { calendarId: 'primary', summary, description: '', start, end, timezone: 'Asia/Seoul', attendees: [] };
    const approval: any = await post('/api/v1/approvals/calendar-event', { payload });
    await post(`/api/v1/approvals/${approval.approvalId}/approve`, {});
    const done: any = await post('/api/v1/tools/google-calendar/create-event', { approvalId: approval.approvalId, payload: approval.canonicalPayload });
    return done.externalId as string;
  }, { summary, start: tomorrow(startHour), end: tomorrow(startHour + 1) });
}

const ASK = { en: 'Push the meeting I just created back an hour', ko: '방금 만든 회의를 한 시간 늦춰줘' } as const;
const patches = () => fake.calls.filter((c) => c.method === 'PATCH');

describe('"방금 만든 회의를 한 시간 늦춰줘": proposal, approval, change, read-back', () => {
  for (const locale of ['ko', 'en'] as const) {
    it(`${locale}: the exact before -> after is shown, nothing changes before the person's approval, the change runs once and is confirmed by reading the event back`, async () => {
      const user = connectedUser(`cal_resched_${locale}`, locale);
      const ctx = await contextFor(user, locale);
      const page = await ctx.newPage();
      await openHome(page);
      const eventId = await createMeeting(page, locale === 'ko' ? '프로젝트 리뷰 회의' : 'Project review meeting', 14);
      const patchesBefore = patches().length;
      const posts: string[] = [];
      page.on('request', (r) => { if (r.method() !== 'GET') posts.push(new URL(r.url()).pathname); });

      await page.fill('#main-surface-input', ASK[locale]);
      await page.click('#main-send');
      await page.waitForSelector('.main-turn[data-kind="task"]', { timeout: 20000 });
      // 1. a reviewed plan with the exact change - no model was asked, nothing was changed
      const plan = await page.locator('.main-turn[data-kind="task"]').last().innerText();
      assert.match(plan, /14:00/);
      assert.match(plan, /15:00/);
      assert.equal(patches().length, patchesBefore, 'planning changed nothing');
      assert.equal(posts.some((p) => /ai\/chat|creations/.test(p)), false);
      const request = page.locator('.main-turn .main-inline-actions button', { hasText: locale === 'ko' ? '승인 요청하기' : 'Request approval to run' });
      assert.equal(await request.count(), 1);

      // 2. the approval card reads as a person would: the event, what it is now, what it becomes - and no ids
      await request.click();
      await page.waitForSelector('.main-run-block[data-run-state="WAITING_APPROVAL"]', { timeout: 20000 });
      const waiting = await page.locator('.main-run-block').innerText();
      assert.match(waiting, locale === 'ko' ? /프로젝트 리뷰 회의/ : /Project review meeting/);
      assert.match(waiting, locale === 'ko' ? /현재 시작/ : /Now starts/);
      assert.match(waiting, locale === 'ko' ? /변경 후 시작/ : /Will start/);
      assert.match(waiting, /14:00/);
      assert.match(waiting, /15:00/);
      assert.doesNotMatch(waiting, new RegExp(`${eventId}|nag[a-v0-9]{32}|apr_|tsk_|exe_|eventId`), 'no internal identifiers');
      assert.equal(patches().length, patchesBefore, 'requesting approval changed nothing');
      await page.waitForSelector('.main-approval-card', { timeout: 20000 });

      // 3. only the person's click lets it run - once - and the result is "confirmed" because the event was read back
      await page.locator('.main-approval-card button.btn-primary').click();
      await page.waitForSelector('.main-run-block[data-run-state="CALENDAR_CONFIRMED"]', { timeout: 30000 });
      const done = await page.locator('.main-run-block').innerText();
      assert.match(done, locale === 'ko' ? /완료 - 캘린더에서 확인했어요/ : /Done - confirmed on your calendar/);
      assert.match(done, locale === 'ko' ? /다시 읽어 그대로 반영된 것을 확인/ : /read the event back to confirm/);
      assert.equal(patches().length, patchesBefore + 1, 'exactly one change was sent');
      const lastCalls = fake.calls.slice(-2).map((c) => c.method);
      assert.deepEqual(lastCalls, ['PATCH', 'GET'], 'the change, then the read-back');
      const stored = fake.events().find((e) => e.id === eventId)!;
      assert.equal(stored.start.dateTime.slice(11, 16), '15:00');
      assert.equal(stored.end.dateTime.slice(11, 16), '16:00', 'the length was kept');
      assert.equal(stored.summary, locale === 'ko' ? '프로젝트 리뷰 회의' : 'Project review meeting');
      assert.equal(await page.locator('.main-run-open').isVisible(), true, 'a way to open the event');
      assert.doesNotMatch(await page.locator('body').innerText(), /mainCalendar\.|mainRun\.|mainRoute\.|mainText\./, 'no raw i18n keys');
      await ctx.close();
    });
  }

  it('en: when Google accepts the change but the calendar still shows the old time, the person is told it is NOT confirmed - never "done"', async () => {
    const user = connectedUser('cal_resched_mismatch', 'en');
    const ctx = await contextFor(user, 'en');
    const page = await ctx.newPage();
    await openHome(page);
    await createMeeting(page, 'Quarterly planning', 10);
    fake.faults.ignorePatches = true;
    try {
      await page.fill('#main-surface-input', 'Push the meeting I just created back an hour');
      await page.click('#main-send');
      await page.waitForSelector('.main-turn[data-kind="task"]', { timeout: 20000 });
      await page.locator('.main-turn .main-inline-actions button', { hasText: 'Request approval to run' }).click();
      await page.waitForSelector('.main-approval-card', { timeout: 20000 });
      await page.locator('.main-approval-card button.btn-primary').click();
      await page.waitForSelector('.main-run-block[data-run-state="CALENDAR_MISMATCH"]', { timeout: 30000 });
      const text = await page.locator('.main-run-block').innerText();
      assert.match(text, /your calendar shows something different/i);
      assert.match(text, /did not match what you approved \(.*start/i);
      assert.doesNotMatch(text, /Done - confirmed/);
    } finally {
      fake.faults.ignorePatches = false;
    }
    await ctx.close();
  });

  it('ko: two meetings created just now -> the person is asked which one; nothing is proposed, nothing is changed', async () => {
    const user = connectedUser('cal_resched_ambiguous', 'ko');
    const ctx = await contextFor(user, 'ko');
    const page = await ctx.newPage();
    await openHome(page);
    await createMeeting(page, '디자인 리뷰', 11);
    await createMeeting(page, '팀 점심 회의', 12);
    const before = patches().length;
    await page.fill('#main-surface-input', ASK.ko);
    await page.click('#main-send');
    await page.waitForFunction(() => /어느 일정인가요/.test(document.body.innerText), undefined, { timeout: 20000 });
    const text = await page.locator('.main-turn').last().innerText();
    assert.match(text, /디자인 리뷰/);
    assert.match(text, /팀 점심 회의/);
    assert.match(text, /아무것도 바꾸지 않았어요/);
    assert.equal(await page.locator('.main-turn .main-inline-actions button', { hasText: '승인 요청하기' }).count(), 0, 'no plan to approve');
    assert.equal(patches().length, before);
    await ctx.close();
  });
});
