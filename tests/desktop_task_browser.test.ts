// "Open Notepad, write this sentence and save it as NAgex-Test.txt in my Documents folder" - as the PERSON lives it on the Main screen (real Chromium, real Main UI, Korean and English):
// the request becomes ONE card that says what will happen on which PC and waits for approval; nothing happens before; after approval the card shows only what the PC REPORTS (waiting for the PC,
// working, then "done" only once the PC has read the saved file back); a refusal by the PC is said in plain words and nothing is claimed.
//
// HONEST SCOPE: the server, the Local Device Agent runtime, the signed transport, enrollment and the device EXECUTOR are the real ones; only the native Windows controller is a scripted stand-in
// (tests/_fake_desktop_port.ts), because this test must also run on machines that have no Windows desktop. That a real application is driven is proven separately, by the opt-in
// desktop_windows_notepad_real.test.ts on a real PC. A fake runtime does not satisfy real E2E acceptance.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { createDesktopPlanWiring } from '../src/device-agent/desktop-plan-wiring.js';
import { enrollThisDevice } from '../src/device-agent/device-enrollment.js';
import { LocalDeviceAgentRuntime } from '../src/device-agent/local-device-agent-runtime.js';
import { LocalDeviceCredentialStore, PlaintextLocalStorageFallback } from '../src/device-agent/local-device-credential.store.js';
import { FakeDesktop } from './_fake_desktop_port.js';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';

declare const document: any;

const SENTENCE = 'NAgex Desktop Agent 실기기 제어 검증 — 2026-10-16';
const PROMPT = {
  ko: `메모장을 열고 다음 문장을 작성한 뒤, 내 문서 폴더에 NAgex-Test.txt로 저장해줘. "${SENTENCE}"`,
  en: `Open Notepad, write "${SENTENCE}" and save it as NAgex-Test.txt in my Documents folder.`,
};
const NO_TECHNICAL_TEXT = /DESKTOP_|DEVICE_|APPROVAL_|APP_WINDOW|TARGET_FILE|mainDesktop\.|mainRoute\.|dplan_|cmd_[0-9a-f]{6}|apr_[0-9a-f]{6}|undefined|\[object|WRITE_TEXT_AND_SAVE|WINDOWS_UIA/;

let h: CanvasAskHarness;
const stoppers: Array<() => Promise<void>> = [];
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { for (const stop of stoppers) await stop().catch(() => undefined); await h?.close(); });

interface Pc { fake: FakeDesktop; docs: string; runtime: LocalDeviceAgentRuntime; stop: () => Promise<void>; start: () => Promise<void>; deviceName: string }

// A PC of this person: enrolled for real (key pair, signed transport) with the REAL executor; the controller is the scripted stand-in.
async function enrolledPc(user: DisposableUser, name: string, options: { connect?: boolean } = {}): Promise<Pc> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-desktop-ui-'));
  const docs = path.join(dir, 'Documents');
  fs.mkdirSync(docs);
  const store = new LocalDeviceCredentialStore(path.join(dir, 'device-credential.enc'), new PlaintextLocalStorageFallback());
  const fake = new FakeDesktop();
  const caps = fake.isAvailable() ? ['desktop:UIA_INTERACTIVE:NOTEPAD'] : [];
  const enrolled = await enrollThisDevice({ serverBaseUrl: h.origin, sessionId: user.sessionId, credentialStore: store, agentVersion: 'ui-test', capabilityInventory: caps, deviceName: name, platform: 'win32' });
  assert.equal(enrolled.enrolled, true);
  let runtime!: LocalDeviceAgentRuntime;
  const build = () => {
    const wiring = createDesktopPlanWiring({
      credentialStore: store, dataDir: dir, controller: fake, resolveRoot: () => docs, volatileRoots: [],
      report: async (commandId, executionId, stage, resultCode, evidence) => runtime.reportCommand(commandId, executionId, stage, resultCode, evidence),
    });
    runtime = new LocalDeviceAgentRuntime({ credentialStore: store, serverBaseUrl: h.origin, agentVersion: 'ui-test', capabilityInventory: wiring.capabilityInventory, heartbeatIntervalMs: 300, onPendingCommand: wiring.onPendingCommand });
  };
  build();
  const pc: Pc = {
    fake, docs, deviceName: name,
    get runtime() { return runtime; },
    stop: async () => { await runtime.stop(); },
    start: async () => { build(); await runtime.start(); },
  } as Pc;
  stoppers.push(async () => { await runtime.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  if (options.connect !== false) await pc.start();
  return pc;
}

async function personAndPage(label: string, locale: 'en' | 'ko'): Promise<{ user: DisposableUser; ctx: BrowserContext; page: Page }> {
  const user = h.user(label);
  if (locale === 'ko') h.setLocale(user, 'ko');
  const ctx = await h.newContext('desktop', user, locale);
  const page = await ctx.newPage();
  await page.goto(`${h.origin}/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#main-surface-input', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('#nagex-main-surface')?.dataset.sessionState === 'EMPTY_HOME', undefined, { timeout: 20000 });
  return { user, ctx, page };
}

const ask = async (page: Page, text: string) => { await page.fill('#main-surface-input', text); await page.click('#main-send'); };
const card = (page: Page) => page.locator('.main-dtask-block').last();
const waitCard = (page: Page, state: string, timeout = 30000) =>
  page.waitForFunction((s: string) => { const b = document.querySelectorAll('.main-dtask-block'); return b.length > 0 && b[b.length - 1].getAttribute('data-task-state') === s; }, state, { timeout })
    .catch(async (error: unknown) => {
      const seen = await page.evaluate(() => Array.from(document.querySelectorAll('.main-dtask-block')).map((b: any) => `${b.getAttribute('data-task-state')}: ${String(b.innerText).replace(/\s+/g, ' ').slice(0, 300)}`));
      throw new Error(`${error instanceof Error ? error.message : String(error)} | WAITED_FOR=${state} CARDS=${JSON.stringify(seen)}`);
    });
const cardText = (page: Page) => card(page).innerText();

describe('the Main screen: a request to use Notepad on my PC', () => {
  it('ko: with no PC enrolled it says so plainly - nothing is asked, approved or opened', async () => {
    const { page, ctx } = await personAndPage('dt_none_ko', 'ko');
    await ask(page, PROMPT.ko);
    await page.waitForFunction(() => document.body.innerText.includes('아직 NAgex가 내 PC를 사용할 수 없어요'), undefined, { timeout: 20000 });
    const body = await page.evaluate(() => document.body.innerText);
    assert.ok(body.includes('이 PC 등록'), 'it says what to do');
    assert.equal(await page.locator('.main-dtask-block').count(), 0, 'no card, nothing to approve');
    assert.doesNotMatch(body, NO_TECHNICAL_TEXT);
    await ctx.close();
  });

  it('ko: HAPPY - the card says what will happen and on which PC, waits; after Approve the PC does it and the card shows "done" only after the PC read the file back', async () => {
    const { user, ctx, page } = await personAndPage('dt_happy_ko', 'ko');
    const pc = await enrolledPc(user, 'MIN-DESKTOP');
    await ask(page, PROMPT.ko);
    await waitCard(page, 'APPROVAL');
    let text = await cardText(page);
    assert.ok(text.includes('MIN-DESKTOP'), 'the PC is named');
    assert.ok(text.includes(SENTENCE), 'the exact text is shown');
    assert.ok(text.includes('NAgex-Test.txt') && text.includes('문서'), 'the file and the folder are shown');
    assert.ok(text.includes('화면'), 'it says it happens on the screen');
    assert.equal(await card(page).locator('.main-btask-approve').count(), 1);
    assert.equal(await card(page).locator('.main-btask-decline').count(), 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(fs.readdirSync(pc.docs), [], 'nothing is written before the person approves');
    assert.deepEqual(pc.fake.calls, [], 'the PC has not been asked anything');

    await card(page).locator('.main-btask-approve').click();
    await waitCard(page, 'COMPLETED', 40000);
    text = await cardText(page);
    assert.ok(text.includes('NAgex-Test.txt') && text.includes('일치'), 'the result says the file was read back and matches');
    assert.match(text, /\d+\s*바이트/, 'with its size');
    assert.equal(fs.readFileSync(path.join(pc.docs, 'NAgex-Test.txt'), 'utf8'), SENTENCE);
    assert.equal(await card(page).locator('.main-btask-approve').count(), 0, 'no buttons once it is done');
    // the PC's own steps, in plain words
    await card(page).locator('.main-btask-steps summary').click();
    const steps = await card(page).locator('.main-btask-steps li').allInnerTexts();
    assert.ok(steps.length >= 4 && steps.some((s) => s.includes('다시 읽어')), steps.join(' | '));
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), NO_TECHNICAL_TEXT);
    await ctx.close();
  });

  it('en: Decline ends it at once - nothing is sent to the PC and nothing is written', async () => {
    const { user, ctx, page } = await personAndPage('dt_decline_en', 'en');
    const pc = await enrolledPc(user, 'OFFICE-PC');
    await ask(page, PROMPT.en);
    await waitCard(page, 'APPROVAL');
    assert.match(await cardText(page), /Open Notepad on OFFICE-PC/);
    await card(page).locator('.main-btask-decline').click();
    await waitCard(page, 'DECLINED');
    assert.match(await cardText(page), /Not started/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(fs.readdirSync(pc.docs), []);
    assert.deepEqual(pc.fake.calls, []);
    // the approval is dead: it cannot be used afterwards
    const approvals = await (await ctx.request.get(`${h.origin}/api/v1/approvals`)).json();
    assert.ok(!JSON.stringify(approvals).includes('"status":"APPROVED"'), 'nothing was approved');
    await ctx.close();
  });

  it('en: HAPPY in English; and asking again for the same file is refused BY THE PC, which says so in plain words and changes nothing', async () => {
    const { user, ctx, page } = await personAndPage('dt_twice_en', 'en');
    const pc = await enrolledPc(user, 'LAPTOP');
    await ask(page, PROMPT.en);
    await waitCard(page, 'APPROVAL');
    await card(page).locator('.main-btask-approve').click();
    await waitCard(page, 'COMPLETED', 40000);
    assert.match(await cardText(page), /Saved Documents › NAgex-Test\.txt and read it back/);
    const first = fs.statSync(path.join(pc.docs, 'NAgex-Test.txt')).mtimeMs;

    await ask(page, PROMPT.en);
    await page.waitForFunction(() => document.querySelectorAll('.main-dtask-block').length >= 2, undefined, { timeout: 20000 });
    await waitCard(page, 'APPROVAL');
    await card(page).locator('.main-btask-approve').click();
    await waitCard(page, 'FAILED', 40000);
    const text = await cardText(page);
    assert.match(text, /already exists in Documents/);
    assert.match(text, /never replaces a file/);
    assert.equal(fs.statSync(path.join(pc.docs, 'NAgex-Test.txt')).mtimeMs, first, 'the file was not touched');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), NO_TECHNICAL_TEXT);
    await ctx.close();
  });

  it('ko: a PC that is off is told, not hidden - the card waits for it and finishes when NAgex Desktop is back', async () => {
    const { user, ctx, page } = await personAndPage('dt_offline_ko', 'ko');
    const pc = await enrolledPc(user, 'HOME-PC', { connect: false });
    await ask(page, PROMPT.ko);
    await waitCard(page, 'APPROVAL');
    assert.match(await cardText(page), /HOME-PC.*연결되어 있지 않아요/s, 'the PC is said not to be connected');
    await card(page).locator('.main-btask-approve').click();
    await waitCard(page, 'QUEUED');
    assert.match(await cardText(page), /기다리는 중/);
    assert.deepEqual(fs.readdirSync(pc.docs), [], 'nothing happens while the PC is away');
    await pc.start();
    await waitCard(page, 'COMPLETED', 40000);
    assert.equal(fs.readFileSync(path.join(pc.docs, 'NAgex-Test.txt'), 'utf8'), SENTENCE);
    await ctx.close();
  });

  it('en: what cannot be read from the request is asked for (no card, no approval): no text, no file name, another folder', async () => {
    const { user, ctx, page } = await personAndPage('dt_unclear_en', 'en');
    await enrolledPc(user, 'UNCLEAR-PC');
    const cases: Array<[string, RegExp]> = [
      ['Open Notepad and save it as notes.txt in my Documents folder.', /What should the note say/],
      [`Open Notepad, write "${SENTENCE}" and save it.`, /What should the file be called/],
      [`Open Notepad, write "${SENTENCE}" and save it as notes.txt in my Downloads folder.`, /only save into your Documents folder/],
    ];
    for (const [prompt, expected] of cases) {
      await ask(page, prompt);
      await page.waitForFunction((re: string) => new RegExp(re).test(document.body.innerText), expected.source, { timeout: 20000 });
      assert.equal(await page.locator('.main-dtask-block').count(), 0, 'no card is shown for an unclear request');
    }
    const approvals = await (await ctx.request.get(`${h.origin}/api/v1/approvals`)).json();
    assert.ok(!JSON.stringify(approvals).includes('device.desktop.document.write_and_save'), 'no approval was created');
    await ctx.close();
  });

  it('a question about Notepad is answered as a question - it never starts anything on the PC', async () => {
    const { user, ctx, page } = await personAndPage('dt_question_en', 'en');
    const pc = await enrolledPc(user, 'QUESTION-PC');
    await ask(page, 'How do I save a file in Notepad?');
    await page.waitForFunction(() => document.querySelectorAll('.main-thread, .main-turn, [data-turn]').length > 0 || document.body.innerText.length > 0, undefined, { timeout: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(await page.locator('.main-dtask-block').count(), 0);
    assert.deepEqual(pc.fake.calls, []);
    await ctx.close();
  });
});
