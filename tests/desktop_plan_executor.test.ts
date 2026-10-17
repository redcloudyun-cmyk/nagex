// Windows desktop control, device side: what the executor on the PC does with a delivered DESKTOP_EXECUTE_PLAN - and, as important, what it refuses to do.
//
// HONEST SCOPE: the native controller is replaced here by a scripted FAKE PORT. This file proves the executor's decisions (identity, version, expiry, replay, its own application and folder rules,
// what it verifies, what it reports, how it cleans up) - it does NOT prove that a real application was driven. That is a separate, opt-in run on a real Windows PC
// (desktop_windows_notepad_real.test.ts) whose result is reported on its own. A fake runtime does not satisfy real E2E acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DevicePendingCommand } from '../src/device-agent/device-agent-protocol.js';
import { DESKTOP_PLAN_COMMAND_VERSION, desktopTextSha256 } from '../src/device-agent/desktop-plan.types.js';
import {
  DesktopCommandReplayGuard, DesktopPlanExecutor, evaluateTargetPath, volatileFolders,
  type DesktopAutomationPort, type DesktopPlanReport,
} from '../src/device-agent/desktop-plan-executor.js';
import { createDesktopPlanWiring } from '../src/device-agent/desktop-plan-wiring.js';
import { LocalDeviceCredentialStore, PlaintextLocalStorageFallback } from '../src/device-agent/local-device-credential.store.js';
import { FakeDesktop } from './_fake_desktop_port.js';

const TEXT = 'NAgex Desktop Agent 실기기 제어 검증 — 2026-10-16';
const ID = { deviceId: 'dev_pc', tenantId: 'ten', ownerId: 'usr' };
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-desktop-exec-'));

function rig(options: { patch?: Record<string, unknown>; identity?: typeof ID; fake?: FakeDesktop; roots?: { volatile?: string[]; volatileIsParent?: boolean; resolve?: () => string | null } } = {}) {
  const dir = tmp();
  const docs = path.join(dir, 'Documents');
  fs.mkdirSync(docs);
  const fake = options.fake ?? new FakeDesktop();
  const reports: DesktopPlanReport[] = [];
  const replayFile = path.join(dir, 'seen.json');
  const make = () => new DesktopPlanExecutor({
    controller: fake,
    identity: options.identity ?? ID,
    replayGuard: new DesktopCommandReplayGuard(replayFile),
    resolveRoot: options.roots?.resolve ?? (() => docs),
    volatileRoots: options.roots?.volatile ?? (options.roots?.volatileIsParent ? [dir] : []),
    report: async (_command, report) => { reports.push(report); },
    sleep: async () => undefined,
  });
  const executor = make();
  const command = (patch: Record<string, unknown> = {}, over: Partial<DevicePendingCommand> = {}): DevicePendingCommand => {
    const id = crypto.randomUUID().slice(0, 8);
    return {
      commandId: `cmd_${id}`, commandType: 'DESKTOP_EXECUTE_PLAN', ...ID, executionSessionId: null, queuedAt: new Date().toISOString(),
      data: {
        commandVersion: DESKTOP_PLAN_COMMAND_VERSION, planId: `plan_${id}`, executionId: `dplan_exec_${id}`, operation: 'WRITE_TEXT_AND_SAVE', appId: 'NOTEPAD', route: 'WINDOWS_UIA_INTERACTIVE',
        text: TEXT, textSha256: desktopTextSha256(TEXT), rootAlias: 'DOCUMENTS', fileName: 'NAgex-Test.txt', overwrite: false, approvalRef: 'apr_1', deviceId: ID.deviceId, principalId: ID.ownerId, tenantId: ID.tenantId,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), ...patch,
      },
      ...over,
    };
  };
  return { dir, docs, fake, reports, executor, make, command, replayFile };
}

test('the plan carried out end to end (fake port): the window is found by handle, the text is entered and read back, the file name is entered, the file is read back from disk and matches - then, and only then, COMPLETED', async () => {
  const r = rig();
  const final = await r.executor.handle(r.command());
  assert.equal(final.stage, 'COMPLETED');
  assert.equal(final.resultCode, 'DESKTOP_SAVED_VERIFIED');
  assert.equal(final.evidence.fileMatchesApprovedText, true);
  assert.equal(final.evidence.windowTitleNamesTheFile, true);
  assert.equal(final.evidence.otherWindowsOfTheApplicationUntouched, 1);
  assert.equal(fs.readFileSync(path.join(fs.realpathSync(r.docs), 'NAgex-Test.txt'), 'utf8'), TEXT);
  // the device chose HOW: its own executable, interactive mode, window identity - none of it came from the command
  assert.equal(path.basename(r.fake.openAppArgs!.exe).toLowerCase(), 'notepad.exe');
  assert.deepEqual(r.fake.openAppArgs!.options, { mode: 'INTERACTIVE', expectClass: 'Notepad', expectImage: 'notepad.exe' });
  assert.deepEqual(r.fake.calls, ['init:INTERACTIVE', 'openApp', 'observe:RichEditD2DPT', 'mutate:SET_VALUE', 'mutate:EXPAND', 'mutate:INVOKE', 'invoke:다른 이름으로 저장|Save as', 'dialog:setFilename', 'dialog:press:SAVE', 'observe:@window', 'closeApp', 'shutdown']);
  assert.ok(!r.fake.calls.includes('closeDiscard'), 'a saved document is not discarded');
  // progress, then the one final report
  assert.deepEqual(r.reports.map((x) => `${x.stage}:${x.resultCode}`), ['EXECUTING:STARTED', 'COMPLETED:DESKTOP_SAVED_VERIFIED']);
  // what is reported never carries the document text nor a folder path
  const reported = JSON.stringify(r.reports);
  assert.ok(!reported.includes(TEXT) && !reported.includes(r.docs) && !reported.includes(os.homedir()), 'no document text, no folder path in the evidence');
});

test('a device that is not enrolled has no executor and advertises nothing it cannot do; one without the native controller advertises nothing', () => {
  const dir = tmp();
  const store = new LocalDeviceCredentialStore(path.join(dir, 'cred.enc'), new PlaintextLocalStorageFallback());
  const fake = new FakeDesktop();
  const unenrolled = createDesktopPlanWiring({ credentialStore: store, dataDir: dir, controller: fake, report: async () => true });
  assert.equal(unenrolled.executor, null);
  assert.equal(unenrolled.onPendingCommand, undefined, 'nobody to act for: a delivered command has nowhere to go');
  assert.deepEqual(unenrolled.capabilityInventory, ['desktop:UIA_INTERACTIVE:NOTEPAD', 'desktop:UIA_INTERACTIVE:CALCULATOR'], 'it reports every application whose executor is present');
  fake.available = false;
  assert.deepEqual(createDesktopPlanWiring({ credentialStore: store, dataDir: dir, controller: fake, report: async () => true }).capabilityInventory, [], 'no controller, no claim');
  store.save({ ...ID, privateKeyPem: 'pem', agentVersion: 't' });
  assert.ok(createDesktopPlanWiring({ credentialStore: store, dataDir: dir, controller: fake, report: async () => true }).executor);
});

test('a command for another device, user or tenant is refused before anything is touched', async () => {
  for (const over of [{ deviceId: 'dev_other' }, { tenantId: 'ten_other' }, { ownerId: 'usr_other' }]) {
    const r = rig();
    const final = await r.executor.handle(r.command({}, over));
    assert.equal(final.resultCode, 'IDENTITY_MISMATCH', JSON.stringify(over));
    assert.deepEqual(r.fake.calls, [], 'the controller was never started');
  }
  // the plan inside may not name someone else either
  const r = rig();
  assert.equal((await r.executor.handle(r.command({ principalId: 'usr_other' }))).resultCode, 'IDENTITY_MISMATCH');
  assert.deepEqual(r.fake.calls, []);
});

test('an expired plan, an unknown version, a tampered text, and a malformed plan are refused untouched', async () => {
  const r = rig();
  assert.equal((await r.executor.handle(r.command({ expiresAt: new Date(Date.now() - 1000).toISOString() }))).resultCode, 'COMMAND_EXPIRED');
  assert.equal((await r.executor.handle(r.command({ commandVersion: 2 }))).resultCode, 'COMMAND_VERSION_UNSUPPORTED');
  assert.equal((await r.executor.handle(r.command({ text: TEXT + ' (edited in transit)' }))).resultCode, 'COMMAND_TEXT_HASH_MISMATCH');
  assert.equal((await r.executor.handle(r.command({ operation: 'RUN_PROGRAM' }))).resultCode, 'COMMAND_SHAPE_INVALID');
  assert.equal((await r.executor.handle(r.command({ overwrite: true }))).resultCode, 'COMMAND_SHAPE_INVALID');
  assert.equal((await r.executor.handle(r.command({}, { commandType: 'APP_LINK_OPEN' }))).resultCode, 'COMMAND_SHAPE_INVALID');
  assert.deepEqual(r.fake.calls, []);
});

test('an application or file name the device does not allow is refused even if the server (wrongly) sent it', async () => {
  const r = rig();
  assert.equal((await r.executor.handle(r.command({ appId: 'POWERSHELL' }))).resultCode, 'DESKTOP_APP_NOT_ALLOWED');
  for (const fileName of ['..\\evil.txt', 'C:\\Windows\\evil.txt', 'sub/a.txt', 'a.bat', 'CON.txt']) {
    assert.equal((await r.executor.handle(r.command({ fileName }))).resultCode, 'DESKTOP_FILE_NAME_INVALID', fileName);
  }
  assert.equal((await r.executor.handle(r.command({ rootAlias: 'SYSTEM32' }))).resultCode, 'DESKTOP_FOLDER_NOT_ALLOWED');
  assert.deepEqual(r.fake.calls, []);
});

test('the device\'s own folder policy: an unknown or missing folder, a folder under AppData/Temp, and a file that already exists are refused before the application is started', async () => {
  const none = rig({ roots: { resolve: () => null } });
  assert.equal((await none.executor.handle(none.command())).resultCode, 'PATH_NOT_ALLOWED');
  const missing = rig({ roots: { resolve: () => path.join(os.homedir(), 'no-such-folder-' + crypto.randomUUID()) } });
  assert.equal((await missing.executor.handle(missing.command())).resultCode, 'PATH_NOT_ALLOWED');
  const relative = rig({ roots: { resolve: () => 'Documents' } });
  assert.equal((await relative.executor.handle(relative.command())).resultCode, 'PATH_NOT_ALLOWED');

  // a folder under a "volatile" root (where a packaged application's writes are redirected out of sight)
  const underTemp = rig({ roots: { volatileIsParent: true } });
  assert.equal((await underTemp.executor.handle(underTemp.command())).resultCode, 'PATH_NOT_ALLOWED');
  // and the real default list really contains this user's temp and application-data folders
  const real = volatileFolders().map((x) => x.toLowerCase());
  assert.ok(real.includes(os.tmpdir().toLowerCase()));
  assert.equal(evaluateTargetPath('DOCUMENTS', 'a.txt', () => os.tmpdir()).ok, false, 'the temp folder is never a place to save a document');

  // nothing is ever replaced
  const exists = rig();
  fs.writeFileSync(path.join(exists.docs, 'NAgex-Test.txt'), 'the person\'s own file', 'utf8');
  const refused = await exists.executor.handle(exists.command());
  assert.equal(refused.resultCode, 'TARGET_FILE_EXISTS');
  assert.equal(fs.readFileSync(path.join(exists.docs, 'NAgex-Test.txt'), 'utf8'), 'the person\'s own file');
  for (const x of [none, missing, relative, underTemp, exists]) assert.deepEqual(x.fake.calls, [], 'the application was never started');
});

test('a command is taken on at most once: the same command and the same plan are refused the second time - also by a restarted device', async () => {
  const r = rig();
  const command = r.command();
  assert.equal((await r.executor.handle(command)).stage, 'COMPLETED');
  const callsAfterFirst = r.fake.calls.length;
  assert.equal((await r.executor.handle(command)).resultCode, 'COMMAND_REPLAY');
  assert.equal((await r.executor.handle(r.command({ planId: String(command.data.planId) }))).resultCode, 'COMMAND_REPLAY', 'a new command id for the same plan is the same plan');
  const restarted = r.make();
  assert.equal((await restarted.handle(command)).resultCode, 'COMMAND_REPLAY', 'the memory survives a restart');
  assert.equal(r.fake.calls.length, callsAfterFirst, 'nothing was touched again');
  // a command that failed half-way is also not retried behind the person\'s back
  const flaky = rig();
  flaky.fake.typed = { status: 'FAILED' };
  const failing = flaky.command();
  assert.equal((await flaky.executor.handle(failing)).resultCode, 'TEXT_ENTRY_NOT_VERIFIED');
  assert.equal((await flaky.executor.handle(failing)).resultCode, 'COMMAND_REPLAY');
});

test('the native controller missing is reported as such, and nothing is claimed', async () => {
  const r = rig();
  r.fake.available = false;
  const final = await r.executor.handle(r.command());
  assert.equal(final.stage, 'FAILED');
  assert.equal(final.resultCode, 'CONTROLLER_UNAVAILABLE');
  assert.deepEqual(r.fake.calls, []);
});

test('an unexpected window: when the application\'s window cannot be told apart from others (or does not appear) nothing is typed, and a started controller is shut down', async () => {
  const ambiguous = rig();
  ambiguous.fake.open = { status: 'TARGET_AMBIGUOUS', errorCode: 'MULTIPLE_NEW_WINDOWS', matchCount: 2 };
  const a = await ambiguous.executor.handle(ambiguous.command());
  assert.equal(a.resultCode, 'UNEXPECTED_WINDOW');
  assert.equal(a.evidence.newWindows, 2);
  assert.ok(!ambiguous.fake.calls.some((c) => c.startsWith('mutate') || c.startsWith('dialog')), 'nothing was typed or pressed');
  assert.ok(!ambiguous.fake.calls.includes('closeDiscard'), 'a window that was never bound is not touched, not even to close it');
  assert.equal(ambiguous.fake.calls.at(-1), 'shutdown');

  const absent = rig();
  absent.fake.open = { status: 'FAILED', errorCode: 'APP_WINDOW_NOT_FOUND_WITHIN_TIMEOUT' };
  assert.equal((await absent.executor.handle(absent.command())).resultCode, 'APP_WINDOW_NOT_FOUND');
});

test('a document that is not blank is never written over (and the executor discards only the window it opened)', async () => {
  const r = rig();
  r.fake.editorValue = 'something already here';
  const final = await r.executor.handle(r.command());
  assert.equal(final.resultCode, 'DOCUMENT_NOT_EMPTY');
  assert.ok(!r.fake.calls.includes('mutate:SET_VALUE'));
  assert.ok(r.fake.calls.includes('closeDiscard'), 'its own window is closed without saving');
});

test('every failure after the window opened cleans up after itself: text not entered, menu or Save-as item not found (an unsupported language), the file name refused', async () => {
  const cases: Array<[string, (f: FakeDesktop) => void, string]> = [
    ['text not entered as given', (f) => { f.typed = { status: 'FAILED', errorCode: null }; }, 'TEXT_ENTRY_NOT_VERIFIED'],
    ['menu not found', (f) => { f.menu = { status: 'TARGET_AMBIGUOUS', matchCount: 0 }; }, 'MENU_NOT_FOUND'],
    ['Save as not found in this language', (f) => { f.saveAsMatches = { status: 'TARGET_AMBIGUOUS', matchCount: 0 }; }, 'SAVE_AS_NOT_FOUND'],
    ['file name refused', (f) => { f.filename = { status: 'FAILED', errorCode: 'FILENAME_READBACK_MISMATCH' }; }, 'FILENAME_ENTRY_FAILED'],
    ['the file dialog never appears', (f) => { f.dialogNotFoundTimes = 999; }, 'FILE_DIALOG_NOT_FOUND'],
  ];
  for (const [label, arrange, code] of cases) {
    const r = rig();
    arrange(r.fake);
    const final = await r.executor.handle(r.command());
    assert.equal(final.stage, 'FAILED', label);
    assert.equal(final.resultCode, code, label);
    assert.ok(r.fake.calls.includes('closeDiscard'), `${label}: its own unsaved window is discarded`);
    assert.equal(r.fake.calls.at(-1), 'shutdown', `${label}: the controller is shut down`);
    assert.equal(fs.readdirSync(r.docs).length, 0, `${label}: no file was written`);
    assert.ok(!r.reports.some((x) => x.stage === 'COMPLETED'), `${label}: never reported as done`);
  }
});

test('the save dialog may appear a moment late: the executor asks again, a bounded number of times', async () => {
  const r = rig();
  r.fake.dialogNotFoundTimes = 3;
  const final = await r.executor.handle(r.command());
  assert.equal(final.stage, 'COMPLETED');
  assert.equal(r.fake.calls.filter((c) => c === 'dialog:setFilename').length, 4);
});

test('a "replace the file?" prompt is answered No and the plan is abandoned - nothing is replaced', async () => {
  const r = rig();
  r.fake.confirmPrompt = true;
  const final = await r.executor.handle(r.command());
  assert.equal(final.resultCode, 'CONFIRM_PROMPT_OPEN');
  assert.deepEqual(r.fake.calls.filter((c) => c.startsWith('dialog:press')), ['dialog:press:SAVE', 'dialog:press:NO', 'dialog:press:CANCEL']);
  assert.ok(r.fake.calls.includes('closeDiscard'));
});

test('verification mismatch: a save that "worked" but left different content, no file, or an empty file is a FAILURE, with the facts - not a success', async () => {
  const different = rig();
  different.fake.onSave = (target) => fs.writeFileSync(target, 'not what was approved', 'utf8');
  const a = await different.executor.handle(different.command());
  assert.equal(a.stage, 'FAILED');
  assert.equal(a.resultCode, 'FILE_VERIFICATION_MISMATCH');
  assert.equal(a.evidence.fileMatchesApprovedText, false);
  assert.ok(!different.fake.calls.includes('closeDiscard'), 'the saved file is not "un-saved"');

  const missing = rig();
  missing.fake.onSave = () => undefined;
  const b = await missing.executor.handle(missing.command());
  assert.equal(b.resultCode, 'FILE_VERIFICATION_MISMATCH');
  assert.ok((b.evidence.steps as string[]).includes('FILE:NOT_ON_DISK'));

  const empty = rig();
  empty.fake.onSave = (target) => fs.writeFileSync(target, '');
  assert.equal((await empty.executor.handle(empty.command())).resultCode, 'FILE_VERIFICATION_MISMATCH');

  // a UTF-8 byte-order mark is not a difference; a changed character is
  const bom = rig();
  bom.fake.onSave = (target, text) => fs.writeFileSync(target, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
  assert.equal((await bom.executor.handle(bom.command())).stage, 'COMPLETED');
});

test('one plan at a time: a second command that arrives while one is running is refused as busy (and does not disturb the first)', async () => {
  const r = rig();
  let release!: () => void;
  r.fake.slow = new Promise<void>((resolve) => { release = resolve; });
  const first = r.executor.handle(r.command());
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await r.executor.handle(r.command());
  assert.equal(second.resultCode, 'AGENT_BUSY');
  release();
  assert.equal((await first).stage, 'COMPLETED');
});

test('a report that cannot be delivered does not crash the executor or change what happened', async () => {
  const r = rig();
  const executor = new DesktopPlanExecutor({
    controller: r.fake, identity: ID, replayGuard: new DesktopCommandReplayGuard(path.join(r.dir, 'other.json')), resolveRoot: () => r.docs, volatileRoots: [],
    report: async () => { throw new Error('server unreachable'); }, sleep: async () => undefined,
  });
  assert.equal((await executor.handle(r.command())).stage, 'COMPLETED');
});
