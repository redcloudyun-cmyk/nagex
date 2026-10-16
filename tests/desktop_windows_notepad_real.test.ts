// REAL WINDOWS END-TO-END (opt-in): "open Notepad, write this sentence, save it as NAgex-Test.txt in my Documents folder" - on THIS PC, through the whole chain:
//
//   a real NAgex server (in-process, real HTTP, isolated stores, disposable people)
//   -> this PC is ENROLLED as the signed-in person's device (key pair generated here, real signed transport)
//   -> the person ASKS, the approval is APPROVED through the normal approvals API, the plan is DISPATCHED
//   -> the real Local Device Agent runtime receives it on a heartbeat and the real executor runs it through the REAL native controller
//   -> a real Notepad window is opened on the real desktop, the text is entered, Save As is completed, the file is READ BACK from disk and compared
//   -> the device reports, the server shows the evidence
//
// It moves a real application on the interactive desktop of the PC it runs on, so it never runs by default:
//   - NAGEX_REAL_WINDOWS_E2E=1                 to run it at all (otherwise the whole file is SKIPPED with the reason, never "passed")
//   - NAGEX_REAL_E2E_USE_DOCUMENTS=1           to save NAgex-Test.txt directly in the real Documents folder (the file is then LEFT there: it is the requested result);
//                                              by default a dedicated sub-folder of Documents is used and removed afterwards
// Not part of it: the Electron shell (the same runtime, executor and enrollment modules are run in plain Node), and any application other than Notepad.
// The windows that were already open (including the user's own Notepad windows) are listed before and after by handle and title length only - never their text - and must be unchanged.
import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enrollThisDevice } from '../src/device-agent/device-enrollment.js';
import { createDesktopPlanWiring } from '../src/device-agent/desktop-plan-wiring.js';
import { LocalDeviceAgentRuntime, type LocalDeviceAgentConnectionState } from '../src/device-agent/local-device-agent-runtime.js';
import { LocalDeviceCredentialStore, PlaintextLocalStorageFallback } from '../src/device-agent/local-device-credential.store.js';
import { WindowsIsolatedDesktopController } from '../src/device-agent/windows-isolated-desktop-controller.js';
import { startCanvasAskHarness, type CanvasAskHarness, type DisposableUser } from './_canvas_ask_harness.js';

const SENTENCE = 'NAgex Desktop Agent 실기기 제어 검증 — 2026-10-16';
const SKIP: string | false = (() => {
  if (process.platform !== 'win32') return 'REAL_WINDOWS_UNAVAILABLE: this is not a Windows PC';
  if (process.env.NAGEX_REAL_WINDOWS_E2E !== '1') return 'REAL_WINDOWS_E2E_NOT_REQUESTED: this run drives a real application on the interactive desktop; set NAGEX_REAL_WINDOWS_E2E=1 to run it';
  if (!new WindowsIsolatedDesktopController().isAvailable()) return 'REAL_WINDOWS_UNAVAILABLE: the native controller is not built (native/windows-desktop-controller/build.ps1)';
  return false;
})();

const POWERSHELL = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command'];
const realDocuments = (): string => execFileSync('powershell', [...POWERSHELL, "[Environment]::GetFolderPath('MyDocuments')"], { encoding: 'utf8' }).trim();

/** Notepad windows currently open, by handle and TITLE LENGTH only (a title can hold a person's text; it is never read) */
function notepadWindows(): Array<{ hwnd: number; titleLength: number }> {
  const script = "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes; $u=[System.Windows.Automation.AutomationElement]; $c=New-Object System.Windows.Automation.PropertyCondition($u::ClassNameProperty,'Notepad'); foreach($w in $u::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$c)){ $w.Current.NativeWindowHandle.ToString() + ',' + $w.Current.Name.Length.ToString() }";
  const out = execFileSync('powershell', [...POWERSHELL, script], { encoding: 'utf8' }).trim();
  return out ? out.split(/\r?\n/).map((line) => { const [hwnd, len] = line.trim().split(','); return { hwnd: Number(hwnd), titleLength: Number(len) }; }) : [];
}

describe('REAL WINDOWS: enroll this PC and have NAgex write and save a document in Notepad, with approval, verified on disk', { skip: SKIP }, () => {
  let h: CanvasAskHarness;
  let owner: DisposableUser;
  let stranger: DisposableUser;
  let runtime: LocalDeviceAgentRuntime | null = null;
  let state: LocalDeviceAgentConnectionState = 'UNENROLLED';
  let dataDir = '';
  let documentsRoot = '';
  let dedicated = '';
  let store: LocalDeviceCredentialStore;
  let deviceId = '';
  const useRealDocuments = process.env.NAGEX_REAL_E2E_USE_DOCUMENTS === '1';
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const api = async (method: string, url: string, who: DisposableUser | null, body?: unknown): Promise<{ status: number; json: any }> => {
    const response = await fetch(`${h.origin}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who.sessionId}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  const errorCode = (r: { json: any }): string | undefined => r.json?.error?.code ?? r.json?.code;
  const waitFor = async <T,>(read: () => Promise<T | null | false>, what: string, timeoutMs = 120_000): Promise<T> => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) { const value = await read(); if (value) return value as T; await sleep(400); }
    throw new Error(`timed out waiting for ${what}`);
  };
  const waitForFinal = (commandId: string, who: DisposableUser) => waitFor(async () => {
    const r = await api('GET', `/api/v1/device-agent/desktop-plans/${commandId}`, who);
    return r.status === 200 && (r.json.stage === 'COMPLETED' || r.json.stage === 'FAILED') ? r.json : null;
  }, `the device to finish command ${commandId}`);

  before(async () => {
    h = await startCanvasAskHarness({ scrubProviders: true });
    owner = h.user('pc_owner');
    stranger = h.user('pc_stranger');
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-real-windows-'));
    store = new LocalDeviceCredentialStore(path.join(dataDir, 'device-credential.enc'), new PlaintextLocalStorageFallback());
    documentsRoot = realDocuments();
    dedicated = path.join(documentsRoot, `NAgex-Desktop-E2E-${Date.now()}`);
    if (!useRealDocuments) fs.mkdirSync(dedicated);
  });

  after(async () => {
    await runtime?.stop();
    await h?.close();
    if (!useRealDocuments && dedicated && fs.existsSync(dedicated)) fs.rmSync(dedicated, { recursive: true, force: true });
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const target = (): string => path.join(useRealDocuments ? documentsRoot : dedicated, 'NAgex-Test.txt');
  const planBody = () => ({ deviceId, appId: 'NOTEPAD', text: SENTENCE, rootAlias: 'DOCUMENTS', fileName: 'NAgex-Test.txt' });

  it('NOT ENROLLED: nothing can be asked of a PC that is not a registered device', async () => {
    const r = await api('POST', '/api/v1/device-agent/desktop-plans', owner, { deviceId: 'dev_this_pc_not_enrolled_yet', text: SENTENCE, fileName: 'NAgex-Test.txt' });
    assert.equal(r.status, 404);
    assert.equal(errorCode(r), 'DEVICE_NOT_FOUND');
    assert.equal(store.load(), null, 'no credential exists yet');
  });

  it('ENROLLMENT: this PC becomes a device of the signed-in person (key pair generated here), and its real Local Device Agent connects with that credential', async () => {
    const wiring = createDesktopPlanWiring({ credentialStore: store, dataDir, resolveRoot: () => (useRealDocuments ? documentsRoot : dedicated), report: async () => false });
    assert.deepEqual(wiring.capabilityInventory, ['desktop:UIA_INTERACTIVE:NOTEPAD'], 'this PC truthfully reports what it can drive');
    const enrolled = await enrollThisDevice({ serverBaseUrl: h.origin, sessionId: owner.sessionId, credentialStore: store, agentVersion: 'real-e2e', capabilityInventory: wiring.capabilityInventory });
    assert.equal(enrolled.enrolled, true);
    if (!enrolled.enrolled) return;
    deviceId = enrolled.deviceId;
    assert.equal(enrolled.ownerId, owner.userId);
    assert.equal(enrolled.tenantId, owner.tenantId);

    const listed = await api('GET', '/api/v1/device-agent/devices', owner);
    const mine = (listed.json.devices as Array<{ deviceId: string; trustState: string; capabilities: string[] }>).find((d) => d.deviceId === deviceId);
    assert.equal(mine?.trustState, 'ACTIVE');
    assert.ok(mine?.capabilities.includes('desktop:UIA_INTERACTIVE:NOTEPAD'));
    assert.equal((await api('GET', '/api/v1/device-agent/devices', stranger)).json.devices.length, 0, 'another person sees no device');

    // the real agent runtime and the real executor, exactly as the desktop app wires them
    const live = createDesktopPlanWiring({
      credentialStore: store, dataDir, resolveRoot: () => (useRealDocuments ? documentsRoot : dedicated),
      report: async (commandId, executionId, stage, resultCode, evidence) => (runtime ? runtime.reportCommand(commandId, executionId, stage, resultCode, evidence) : false),
    });
    runtime = new LocalDeviceAgentRuntime({
      credentialStore: store, serverBaseUrl: h.origin, agentVersion: 'real-e2e', capabilityInventory: live.capabilityInventory, heartbeatIntervalMs: 500,
      onStateChange: (s) => { state = s; }, onPendingCommand: live.onPendingCommand,
    });
    await runtime.start();
    await waitFor(async () => state === 'AUTHENTICATED', 'the agent to authenticate');
  });

  it('NEGATIVES that touch nothing: another person\'s device, a path outside the folder, an application that is not allowed, an approval that was declined, a dispatch before approval', async () => {
    const asStranger = await api('POST', '/api/v1/device-agent/desktop-plans', stranger, planBody());
    assert.equal(asStranger.status, 404, 'a stranger cannot ask for work on this PC');
    assert.equal((await api('POST', '/api/v1/device-agent/desktop-plans', owner, { ...planBody(), fileName: '..\\..\\Windows\\evil.txt' })).status, 400);
    assert.equal((await api('POST', '/api/v1/device-agent/desktop-plans', owner, { ...planBody(), fileName: 'C:\\Windows\\evil.txt' })).status, 400);
    assert.equal((await api('POST', '/api/v1/device-agent/desktop-plans', owner, { ...planBody(), appId: 'POWERSHELL' })).status, 400);
    assert.equal((await api('POST', '/api/v1/device-agent/desktop-plans', owner, { ...planBody(), rootAlias: 'SYSTEM' })).status, 400);

    const declined = await api('POST', '/api/v1/device-agent/desktop-plans', owner, planBody());
    assert.equal(declined.status, 201);
    const early = await api('POST', '/api/v1/device-agent/desktop-plans/dispatch', owner, { approvalId: declined.json.approvalId });
    assert.ok(early.status >= 400, 'not approved yet: refused');
    assert.equal((await api('POST', `/api/v1/approvals/${declined.json.approvalId}/reject`, owner, {})).status, 200);
    const after = await api('POST', '/api/v1/device-agent/desktop-plans/dispatch', owner, { approvalId: declined.json.approvalId });
    assert.ok(after.status >= 400, 'declined: refused');
    await sleep(1500);
    assert.equal(fs.existsSync(target()), false, 'nothing was written');
  });

  it('THE SCENARIO: ask -> approve -> dispatch -> real Notepad window -> text entered -> Save As -> file read back and verified; the windows that were open before are untouched', async () => {
    const windowsBefore = notepadWindows();
    assert.equal(fs.existsSync(target()), false, 'the target does not exist yet (the device never replaces a file)');
    const startedAt = Date.now();

    const asked = await api('POST', '/api/v1/device-agent/desktop-plans', owner, planBody());
    assert.equal(asked.status, 201);
    assert.equal(asked.json.summary.onYourScreen, true);
    const approvalId = asked.json.approvalId as string;
    assert.equal((await api('POST', `/api/v1/approvals/${approvalId}/approve`, owner, {})).status, 200);

    const dispatched = await api('POST', '/api/v1/device-agent/desktop-plans/dispatch', owner, { approvalId });
    assert.equal(dispatched.status, 202);
    const commandId = dispatched.json.commandId as string;
    assert.equal((await api('GET', `/api/v1/device-agent/desktop-plans/${commandId}`, stranger)).status, 404, 'a stranger cannot follow this plan');

    const final = await waitForFinal(commandId, owner);
    assert.equal(final.stage, 'COMPLETED', JSON.stringify(final));
    assert.equal(final.resultCode, 'DESKTOP_SAVED_VERIFIED');
    assert.equal(final.evidence.fileMatchesApprovedText, true);

    // the file, on the real disk, byte for byte
    const content = fs.readFileSync(target());
    const body = content.length >= 3 && content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf ? content.subarray(3) : content;
    assert.equal(body.toString('utf8'), SENTENCE);
    assert.equal(final.evidence.fileSha256, crypto.createHash('sha256').update(content).digest('hex'), 'the device and this test hashed the same bytes');

    // the windows that were already open are the same windows with the same title lengths; the one the plan opened is gone
    const windowsAfter = notepadWindows();
    assert.deepEqual(windowsAfter, windowsBefore, 'every Notepad window that was open before is still open and unchanged; none was left behind');

    // an approval is used once; the device never takes the same plan twice
    const replay = await api('POST', '/api/v1/device-agent/desktop-plans/dispatch', owner, { approvalId });
    assert.ok(replay.status >= 400, 'the used approval cannot be dispatched again');
    assert.equal(errorCode(replay), 'APPROVAL_ALREADY_CONSUMED');

    console.log(JSON.stringify({
      event: 'real_windows_e2e_result', commandId, stage: final.stage, resultCode: final.resultCode, seconds: Math.round((Date.now() - startedAt) / 1000),
      steps: final.evidence.steps, fileSizeBytes: final.evidence.fileSizeBytes, fileSha256: final.evidence.fileSha256, windowTitleNamesTheFile: final.evidence.windowTitleNamesTheFile,
      notepadWindowsBefore: windowsBefore.length, notepadWindowsAfter: windowsAfter.length, savedInRealDocuments: useRealDocuments,
    }));
  });

  it('THE DEVICE\'S OWN RULE: asking again for the same file is refused by the PC itself (a file is never replaced), no window is opened, and the saved file is unchanged', async () => {
    const windowsBefore = notepadWindows();
    const savedBefore = fs.readFileSync(target());
    const asked = await api('POST', '/api/v1/device-agent/desktop-plans', owner, planBody());
    const approvalId = asked.json.approvalId as string;
    await api('POST', `/api/v1/approvals/${approvalId}/approve`, owner, {});
    const dispatched = await api('POST', '/api/v1/device-agent/desktop-plans/dispatch', owner, { approvalId });
    assert.equal(dispatched.status, 202);
    const final = await waitForFinal(dispatched.json.commandId, owner);
    assert.equal(final.stage, 'FAILED');
    assert.equal(final.resultCode, 'TARGET_FILE_EXISTS');
    assert.deepEqual(fs.readFileSync(target()), savedBefore, 'the existing file is untouched');
    assert.deepEqual(notepadWindows(), windowsBefore, 'no window was opened or closed');
  });
});
