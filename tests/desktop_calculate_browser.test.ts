// "Use the Calculator to work out 17 x 24" - as the PERSON lives it on the Main screen (real Chromium, real Main UI, Korean and English): the request becomes ONE card that says what will happen on which PC,
// the exact calculation and what NAgex will check, and waits for approval; nothing happens before; after approval the card shows only what the PC REPORTED - and "done" only once the PC read the result from
// the Calculator's display and it matched NAgex's own calculation. A wrong display, a missing PC and a PC without the Calculator are said plainly.
//
// HONEST SCOPE: the server, the Local Device Agent runtime, the signed transport, enrollment and the device EXECUTOR are the real ones; only the native Windows controller is a scripted stand-in
// (tests/_fake_calculator_port.ts), because this test must also run on machines without a Windows desktop. That a real Calculator is driven is proven separately, by the opt-in
// desktop_task_real_ui.test.ts on a real PC. A fake runtime does not satisfy real E2E acceptance.
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
import { FakeCalculator } from './_fake_calculator_port.js';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';

declare const document: any;

const PROMPT = { ko: '계산기로 17 곱하기 24 계산해줘', en: 'Use the Calculator to work out 17 times 24' };
const NO_TECHNICAL_TEXT = /DESKTOP_|DEVICE_|APPROVAL_|APP_WINDOW|CALC_|OPERAND_|mainDesktop\.|mainRoute\.|dplan_|cmd_[0-9a-f]{6}|apr_[0-9a-f]{6}|undefined|\[object|CALCULATE\b|WINDOWS_UIA|num\dButton|equalButton/;

let h: CanvasAskHarness;
const stoppers: Array<() => Promise<void>> = [];
before(async () => { h = await startCanvasAskHarness({ scrubProviders: true }); });
after(async () => { for (const stop of stoppers) await stop().catch(() => undefined); await h?.close(); });

// A PC of this person: enrolled for real (key pair, signed transport) with the REAL executor; the controller is the scripted stand-in. `capabilities` lets a test enrol a PC that cannot drive the Calculator.
async function enrolledPc(user: DisposableUser, name: string, options: { fake?: FakeCalculator; capabilities?: string[] } = {}): Promise<{ fake: FakeCalculator }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-calc-ui-'));
  const store = new LocalDeviceCredentialStore(path.join(dir, 'device-credential.enc'), new PlaintextLocalStorageFallback());
  const fake = options.fake ?? new FakeCalculator();
  const probe = createDesktopPlanWiring({ credentialStore: store, dataDir: dir, controller: fake, report: async () => false });
  const caps = options.capabilities ?? probe.capabilityInventory;
  const enrolled = await enrollThisDevice({ serverBaseUrl: h.origin, sessionId: user.sessionId, credentialStore: store, agentVersion: 'ui-test', capabilityInventory: caps, deviceName: name, platform: 'win32' });
  assert.equal(enrolled.enrolled, true);
  let runtime!: LocalDeviceAgentRuntime;
  const wiring = createDesktopPlanWiring({
    credentialStore: store, dataDir: dir, controller: fake, volatileRoots: [],
    report: async (commandId, executionId, stage, resultCode, evidence) => runtime.reportCommand(commandId, executionId, stage, resultCode, evidence),
  });
  runtime = new LocalDeviceAgentRuntime({ credentialStore: store, serverBaseUrl: h.origin, agentVersion: 'ui-test', capabilityInventory: caps, heartbeatIntervalMs: 300, onPendingCommand: wiring.onPendingCommand });
  stoppers.push(async () => { await runtime.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  await runtime.start();
  return { fake };
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
      const seen = await page.evaluate(() => Array.from(document.querySelectorAll('.main-dtask-block')).map((b: any) => `${b.getAttribute('data-task-state')}: ${String(b.innerText).replace(/\s+/g, ' ').slice(0, 200)}`));
      throw new Error(`${error instanceof Error ? error.message : String(error)} | WAITED_FOR=${state} CARDS=${JSON.stringify(seen)}`);
    });
const cardText = (page: Page) => card(page).innerText();

describe('the Main screen: a request to calculate in the Calculator on my PC', () => {
  it('ko: HAPPY - the card names the PC, the calculation and what NAgex will check, and waits; after Approve the PC does it and the card says "done" only after the display matched', async () => {
    const { user, ctx, page } = await personAndPage('calc_happy_ko', 'ko');
    const pc = await enrolledPc(user, 'MIN-DESKTOP');
    await ask(page, PROMPT.ko);
    await waitCard(page, 'APPROVAL');
    let text = await cardText(page);
    assert.ok(text.includes('MIN-DESKTOP'), 'the PC is named');
    assert.ok(text.includes('17 × 24'), 'the exact calculation is shown');
    assert.ok(text.includes('408'), 'and what NAgex will check the display against');
    assert.ok(text.includes('계산기') && text.includes('화면'), 'the application and that it happens on the screen');
    assert.equal(await card(page).locator('.main-btask-approve').count(), 1);
    assert.equal(await card(page).locator('.main-btask-decline').count(), 1);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(pc.fake.calls, [], 'the PC has not been asked anything before the person approves');

    await card(page).locator('.main-btask-approve').click();
    await waitCard(page, 'COMPLETED', 40000);
    text = await cardText(page);
    assert.ok(text.includes('17 × 24') && text.includes('408') && text.includes('일치'), 'the result says what the display showed and that it matches');
    assert.deepEqual(pc.fake.pressed, ['clearButton', 'num1Button', 'num7Button', 'multiplyButton', 'num2Button', 'num4Button', 'equalButton']);
    assert.equal(await card(page).locator('.main-btask-approve').count(), 0, 'no buttons once it is done');
    await card(page).locator('.main-btask-steps summary').click();
    const steps = await card(page).locator('.main-btask-steps li').allInnerTexts();
    assert.ok(steps.length >= 6 && steps.some((s) => s.includes('계산기 창')) && steps.some((s) => s.includes('화면의 결과를 읽어')), steps.join(' | '));
    assert.ok(!steps.some((s) => s.includes('메모장')), 'a calculation never talks about Notepad');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), NO_TECHNICAL_TEXT);
    await ctx.close();
  });

  it('en: Decline ends it at once - nothing is sent to the PC and nothing is pressed', async () => {
    const { user, ctx, page } = await personAndPage('calc_decline_en', 'en');
    const pc = await enrolledPc(user, 'OFFICE-PC');
    await ask(page, PROMPT.en);
    await waitCard(page, 'APPROVAL');
    assert.match(await cardText(page), /Open Calculator on OFFICE-PC and calculate 17 × 24/);
    await card(page).locator('.main-btask-decline').click();
    await waitCard(page, 'DECLINED');
    assert.match(await cardText(page), /Not started/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.deepEqual(pc.fake.calls, []);
    const approvals = await (await ctx.request.get(`${h.origin}/api/v1/approvals`)).json();
    assert.ok(!JSON.stringify(approvals).includes('"status":"APPROVED"'), 'nothing was approved');
    await ctx.close();
  });

  it('en: HAPPY in English with another operator; and the card shows the result the PC read', async () => {
    const { user, ctx, page } = await personAndPage('calc_happy_en', 'en');
    const pc = await enrolledPc(user, 'LAPTOP');
    await ask(page, 'Open the calculator and calculate 1,200 plus 345');
    await waitCard(page, 'APPROVAL');
    assert.match(await cardText(page), /1200 \+ 345/);
    await card(page).locator('.main-btask-approve').click();
    await waitCard(page, 'COMPLETED', 40000);
    const text = await cardText(page);
    assert.match(text, /Calculated 1200 \+ 345 in Calculator and read the result from its display: 1545/);
    assert.match(text, /matches NAgex's own check/);
    assert.deepEqual(pc.fake.pressed.slice(-2), ['num5Button', 'equalButton']);
    await ctx.close();
  });

  it('en: a Calculator that shows a DIFFERENT result is never reported as done - the card says it did not match and claims nothing', async () => {
    const { user, ctx, page } = await personAndPage('calc_wrong_en', 'en');
    const fake = new FakeCalculator();
    fake.wrongResult = 409;
    await enrolledPc(user, 'FLAKY-PC', { fake });
    await ask(page, PROMPT.en);
    await waitCard(page, 'APPROVAL');
    await card(page).locator('.main-btask-approve').click();
    await waitCard(page, 'FAILED', 40000);
    const text = await cardText(page);
    assert.match(text, /did not match NAgex's own calculation/);
    assert.doesNotMatch(text, /Done/);
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), NO_TECHNICAL_TEXT);
    await ctx.close();
  });

  it('ko: a PC that cannot drive the Calculator, or no PC at all, is said plainly - no card, nothing to approve', async () => {
    const { user, ctx, page } = await personAndPage('calc_nocap_ko', 'ko');
    await enrolledPc(user, 'NOTEPAD-ONLY-PC', { capabilities: ['desktop:UIA_INTERACTIVE:NOTEPAD'] });
    await ask(page, PROMPT.ko);
    await page.waitForFunction(() => document.body.innerText.includes('아직 NAgex가 내 PC를 사용할 수 없어요'), undefined, { timeout: 20000 });
    assert.equal(await page.locator('.main-dtask-block').count(), 0, 'no card, nothing to approve');
    const approvals = await (await ctx.request.get(`${h.origin}/api/v1/approvals`)).json();
    assert.ok(!JSON.stringify(approvals).includes('device.desktop.calculator.calculate'), 'no approval was created');
    await ctx.close();
  });

  it('a question about the Calculator is answered as a question - it never starts anything on the PC; and the Notepad request still works beside it', async () => {
    const { user, ctx, page } = await personAndPage('calc_question_en', 'en');
    const pc = await enrolledPc(user, 'QUESTION-PC');
    await ask(page, 'How do I use the Calculator to work out 17 times 24?');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(await page.locator('.main-dtask-block').count(), 0);
    assert.deepEqual(pc.fake.calls, []);
    await ask(page, 'Open Notepad, write "hello" and save it as hello.txt in my Documents folder.');
    await waitCard(page, 'APPROVAL');
    assert.match(await cardText(page), /Open Notepad on QUESTION-PC/, 'the other canonical action keeps its own card');
    await ctx.close();
  });
});
