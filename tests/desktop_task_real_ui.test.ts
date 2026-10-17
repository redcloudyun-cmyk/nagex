// REAL DEVICE, THROUGH THE WEB UI: the person types a natural-language request into NAgex Main (real Chromium, the real Main screen, Korean), sees ONE card that names the PC and waits, approves it, and the real
// Local Device Agent drives a real Notepad window on this PC to write the text and save it; the card turns "done" only after the PC read the saved file back - and this test then reads the file itself.
//
//   - the server, the Main UI, the signed device transport, the enrollment, the approval store, the device executor AND the native Windows controller are the REAL ones (no scripted stand-in: that is
//     tests/desktop_task_browser.test.ts, which runs everywhere);
//   - the click on "Approve" is made by this test's browser automation, standing in for the person: it proves that nothing happens BEFORE it and that the approval is what releases the action - it is
//     not a human's click, and it is reported as such;
//   - the file is saved into a DEDICATED sub-folder of the real Documents folder (removed afterwards), so an existing NAgex-Test.txt and every Notepad window the person already has open are never touched.
//
// Opt-in: set NAGEX_REAL_WINDOWS_E2E=1 on a Windows PC with an unlocked interactive desktop and the controller built (native/windows-desktop-controller/build.ps1). Otherwise the file is SKIPPED with
// that reason - never reported as passed.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright';
import { createDesktopPlanWiring } from '../src/device-agent/desktop-plan-wiring.js';
import { enrollThisDevice } from '../src/device-agent/device-enrollment.js';
import { LocalDeviceAgentRuntime } from '../src/device-agent/local-device-agent-runtime.js';
import { LocalDeviceCredentialStore, PlaintextLocalStorageFallback } from '../src/device-agent/local-device-credential.store.js';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';

declare const document: any;

const SENTENCE = 'NAgex Device Control Test';
const PROMPT = {
  ko: `메모장을 열고 "${SENTENCE}"를 입력한 다음 문서 폴더에 NAgex-Test.txt로 저장해줘.`,
  en: `Open Notepad, write "${SENTENCE}" and save it as NAgex-Test.txt in my Documents folder.`,
};
const NO_TECHNICAL_TEXT = /DESKTOP_|DEVICE_|APPROVAL_|APP_WINDOW|TARGET_FILE|mainDesktop\.|mainRoute\.|dplan_|cmd_[0-9a-f]{6}|apr_[0-9a-f]{6}|undefined|\[object|WRITE_TEXT_AND_SAVE|WINDOWS_UIA/;
const POWERSHELL = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'];

const SKIP: string | false = (() => {
  if (process.env.NAGEX_REAL_WINDOWS_E2E !== '1') return 'REAL_WINDOWS_E2E_NOT_REQUESTED: this run drives a real application on the interactive desktop; set NAGEX_REAL_WINDOWS_E2E=1 to run it';
  if (process.platform !== 'win32') return 'NOT_WINDOWS: a real Windows PC is required';
  return false;
})();

const realDocuments = (): string => execFileSync('powershell', [...POWERSHELL, "[Environment]::GetFolderPath('MyDocuments')"], { encoding: 'utf8' }).trim();

/** Notepad windows currently open, by handle and TITLE LENGTH only (a title can hold a person's text; it is never read) */
function notepadWindows(): Array<{ hwnd: number; titleLength: number }> {
  const script = "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes; $u=[System.Windows.Automation.AutomationElement]; $c=New-Object System.Windows.Automation.PropertyCondition($u::ClassNameProperty,'Notepad'); $u::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$c) | ForEach-Object { '{0},{1}' -f $_.Current.NativeWindowHandle, $_.Current.Name.Length }";
  const out = execFileSync('powershell', [...POWERSHELL, script], { encoding: 'utf8' }).trim();
  return out ? out.split(/\r?\n/).map((line) => { const [hwnd, len] = line.trim().split(','); return { hwnd: Number(hwnd), titleLength: Number(len) }; }) : [];
}

describe('REAL DEVICE through the web UI: natural-language request -> approval card -> real Notepad -> verified file -> card', { skip: SKIP }, () => {
  let h: CanvasAskHarness;
  let dedicated = '';
  const stoppers: Array<() => Promise<void>> = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  before(async () => {
    h = await startCanvasAskHarness({ scrubProviders: true });
    dedicated = path.join(realDocuments(), `NAgex-Desktop-UI-E2E-${Date.now()}`);
    fs.mkdirSync(dedicated);
  });
  after(async () => {
    for (const stop of stoppers) await stop().catch(() => undefined);
    await h?.close();
    if (dedicated && fs.existsSync(dedicated)) fs.rmSync(dedicated, { recursive: true, force: true });
  });

  // This PC, enrolled for real (key pair generated here, signed transport) with the REAL executor and the REAL native controller (no `controller` is passed: the default is the real one).
  async function enrolledRealPc(user: DisposableUser, name: string): Promise<{ capability: string[] }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-real-ui-'));
    const store = new LocalDeviceCredentialStore(path.join(dir, 'device-credential.enc'), new PlaintextLocalStorageFallback());
    const probe = createDesktopPlanWiring({ credentialStore: store, dataDir: dir, resolveRoot: () => dedicated, report: async () => false });
    assert.deepEqual(probe.capabilityInventory, ['desktop:UIA_INTERACTIVE:NOTEPAD'], 'this PC truthfully reports that it can drive Notepad (the native controller is built)');
    const enrolled = await enrollThisDevice({ serverBaseUrl: h.origin, sessionId: user.sessionId, credentialStore: store, agentVersion: 'real-ui-e2e', capabilityInventory: probe.capabilityInventory, deviceName: name, platform: 'win32' });
    assert.equal(enrolled.enrolled, true);
    let runtime!: LocalDeviceAgentRuntime;
    const live = createDesktopPlanWiring({
      credentialStore: store, dataDir: dir, resolveRoot: () => dedicated,
      report: async (commandId, executionId, stage, resultCode, evidence) => runtime.reportCommand(commandId, executionId, stage, resultCode, evidence),
    });
    runtime = new LocalDeviceAgentRuntime({ credentialStore: store, serverBaseUrl: h.origin, agentVersion: 'real-ui-e2e', capabilityInventory: live.capabilityInventory, heartbeatIntervalMs: 400, onPendingCommand: live.onPendingCommand });
    stoppers.push(async () => { await runtime.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
    await runtime.start();
    return { capability: live.capabilityInventory };
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
  const waitCard = (page: Page, state: string, timeout = 30000) => page.waitForFunction((s: string) => { const b = document.querySelectorAll('.main-dtask-block'); return b.length > 0 && b[b.length - 1].getAttribute('data-task-state') === s; }, state, { timeout });
  const shot = async (page: Page, name: string) => { const dir = process.env.NAGEX_E2E_SCREENSHOT_DIR; if (dir) { fs.mkdirSync(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name) }); } };

  it('ko: the request becomes one card; nothing happens before Approve; after Approve a REAL Notepad writes and saves; the card says done only after the PC read the file back; the file is on disk and identical', async () => {
    const { user, ctx, page } = await personAndPage('real_ui_ko', 'ko');
    await enrolledRealPc(user, os.hostname());
    const windowsBefore = notepadWindows();

    const t0 = Date.now();
    await ask(page, PROMPT.ko);
    await waitCard(page, 'APPROVAL');
    const tCard = Date.now();
    const shown = await card(page).innerText();
    assert.ok(shown.includes(os.hostname()), 'the PC is named');
    assert.ok(shown.includes(SENTENCE), 'the exact text is shown');
    assert.ok(shown.includes('NAgex-Test.txt'), 'the file is shown');
    await shot(page, 'real-ui-1-approval-card.png');
    await sleep(1500);
    assert.deepEqual(fs.readdirSync(dedicated), [], 'nothing is written before the person approves');
    assert.deepEqual(notepadWindows(), windowsBefore, 'no Notepad window is opened before the person approves');

    await card(page).locator('.main-btask-approve').click();            // the person's click, made here by browser automation
    const tApproved = Date.now();
    await waitCard(page, 'COMPLETED', 90000);
    const tDone = Date.now();
    const done = await card(page).innerText();
    await shot(page, 'real-ui-2-done-card.png');
    assert.ok(done.includes('NAgex-Test.txt') && done.includes('일치'), 'the card says the file was read back and matches');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), NO_TECHNICAL_TEXT);

    const file = path.join(dedicated, 'NAgex-Test.txt');
    assert.ok(fs.existsSync(file), 'the file really exists');
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.toString('utf8'), SENTENCE, 'the content is exactly the requested text');
    assert.deepEqual(notepadWindows(), windowsBefore, 'the windows that were open before are untouched and the one NAgex opened is closed');
    await card(page).locator('.main-btask-steps summary').click();
    const steps = await card(page).locator('.main-btask-steps li').allInnerTexts();
    assert.ok(steps.length >= 4, steps.join(' | '));
    console.log(JSON.stringify({
      event: 'real_ui_e2e_result', request: 'KO natural-language -> Main card -> Approve (automation click) -> real Notepad -> file', file: 'dedicated sub-folder of Documents (removed afterwards)',
      bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), contentMatches: true, notepadWindowsBefore: windowsBefore.length, notepadWindowsAfter: notepadWindows().length,
      msToCard: tCard - t0, msApproveToDone: tDone - tApproved, msTotal: tDone - t0, cardSteps: steps,
    }));
    await ctx.close();
  });

  it('en: Decline ends it at once - nothing is sent to the PC, no Notepad window is opened, nothing is written', async () => {
    const { user, ctx, page } = await personAndPage('real_ui_decline_en', 'en');
    await enrolledRealPc(user, os.hostname());
    const windowsBefore = notepadWindows();
    const filesBefore = fs.readdirSync(dedicated);
    await ask(page, PROMPT.en);
    await waitCard(page, 'APPROVAL');
    await card(page).locator('.main-btask-decline').click();
    await waitCard(page, 'DECLINED');
    await sleep(2500);
    assert.deepEqual(notepadWindows(), windowsBefore, 'no window was opened');
    assert.deepEqual(fs.readdirSync(dedicated), filesBefore, 'nothing was written');
    await ctx.close();
  });
});
