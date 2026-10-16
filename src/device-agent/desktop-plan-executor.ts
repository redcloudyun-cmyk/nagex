// The device's executor for a desktop plan (DESKTOP_EXECUTE_PLAN, version 1). It is the Execution Route for "write a line of text into an allowlisted application's document and save it in an
// allowlisted folder": HOW this PC does it. The server told it WHAT, bound to an approval; this file never takes a program path, a folder or a step from the command.
//
// Before it touches anything it checks the command itself - the device's own identity, the schema version, the expiry, that this command was not run before - and then its OWN local rules (an
// application allowlist and a folder policy that live on the device and do not depend on what the server says). It then drives the native controller through a narrow port, looks at the result
// itself (it reads the saved file back and compares it with what was approved) and reports what it saw, truthfully: a window that opened is not a document that was saved.
//
// It never throws, never reports success it did not verify, never leaves a window it opened unsaved (it discards its own typed text and closes only the window it opened), and never puts the text of
// a person's document - or any list of their files - into what it reports.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DevicePendingCommand } from './device-agent-protocol.js';
import { desktopTextSha256, parseDesktopWriteAndSavePlan, type DesktopPlanAppId, type DesktopPlanRootAlias, type DesktopWriteAndSavePlanV1 } from './desktop-plan.types.js';
import type { DesktopElementSelector, DesktopMode, DesktopOpenAppOptions, DesktopWorkerResult } from './windows-isolated-desktop-controller.js';

/** the part of the native controller this executor may use - nothing else (no shell, no free-form input) */
export interface DesktopAutomationPort {
  isAvailable(): boolean;
  hasSession(executionSessionId: string): boolean;
  init(executionSessionId: string, mode?: DesktopMode): Promise<DesktopWorkerResult>;
  openApp(executionSessionId: string, appExePath: string, appArgs: string, options?: DesktopOpenAppOptions): Promise<DesktopWorkerResult>;
  observe(executionSessionId: string, target: string, selector?: DesktopElementSelector): Promise<DesktopWorkerResult>;
  mutate(executionSessionId: string, pattern: 'SET_VALUE' | 'INVOKE' | 'TOGGLE' | 'SELECT' | 'SCROLL' | 'EXPAND', target: string, value?: string, selector?: DesktopElementSelector): Promise<DesktopWorkerResult>;
  dialogSetFilename(executionSessionId: string, absolutePath: string): Promise<DesktopWorkerResult>;
  dialogPress(executionSessionId: string, which: 'SAVE' | 'CANCEL' | 'NO'): Promise<DesktopWorkerResult>;
  closeApp(executionSessionId: string): Promise<DesktopWorkerResult>;
  closeDiscard(executionSessionId: string): Promise<DesktopWorkerResult>;
  shutdown(executionSessionId: string): Promise<DesktopWorkerResult>;
}

export type DesktopPlanStage = 'EXECUTING' | 'COMPLETED' | 'FAILED';

export interface DesktopPlanReport {
  stage: DesktopPlanStage;
  /** DESKTOP_SAVED_VERIFIED on success; otherwise the reason (see DesktopPlanFailure) */
  resultCode: string;
  evidence: Record<string, unknown>;
}

export type DesktopPlanFailure =
  | 'COMMAND_VERSION_UNSUPPORTED' | 'COMMAND_SHAPE_INVALID' | 'COMMAND_TEXT_HASH_MISMATCH' | 'IDENTITY_MISMATCH' | 'COMMAND_EXPIRED' | 'COMMAND_REPLAY' | 'AGENT_BUSY'
  | 'APP_NOT_ALLOWED' | 'CONTROLLER_UNAVAILABLE' | 'PATH_NOT_ALLOWED' | 'TARGET_FILE_EXISTS' | 'CONTROLLER_START_FAILED' | 'APP_START_FAILED' | 'UNEXPECTED_WINDOW'
  | 'APP_WINDOW_NOT_FOUND' | 'DOCUMENT_NOT_EMPTY' | 'TEXT_ENTRY_NOT_VERIFIED' | 'MENU_NOT_FOUND' | 'SAVE_AS_NOT_FOUND' | 'FILE_DIALOG_NOT_FOUND' | 'FILENAME_ENTRY_FAILED'
  | 'CONFIRM_PROMPT_OPEN' | 'SAVE_NOT_COMPLETED' | 'FILE_VERIFICATION_MISMATCH' | 'EXECUTOR_ERROR';

// ---- the device's own application rules -------------------------------------------------------------------------------------------------------------------------------------------------------------

interface DesktopAppProfile {
  executable: () => string;
  /** the window class the application's window must have, and a file name its process image must contain: how the window is told from every other one */
  expectClass: string;
  expectImage: string;
  editor: DesktopElementSelector;
  fileMenu: DesktopElementSelector;
  /** "Save as" under each display language this profile has been checked with; any other language fails closed (nothing is guessed) */
  saveAsNames: string[];
}

// Notepad (Microsoft.WindowsNotepad 11.2607, the packaged application). Verified on a Korean-language Windows 11 PC; the English name is Notepad's own documented one and is unverified here.
// The editor and menu are found by what they are (a Document of class RichEditD2DPT; the File menu's stable automation id) - not by coordinates or position.
const PROFILES: Readonly<Record<DesktopPlanAppId, DesktopAppProfile>> = Object.freeze({
  NOTEPAD: {
    executable: () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'notepad.exe'),
    expectClass: 'Notepad',
    expectImage: 'notepad.exe',
    editor: { controlType: 'Document', className: 'RichEditD2DPT' },
    fileMenu: { controlType: 'MenuItem', automationId: 'File' },
    saveAsNames: ['다른 이름으로 저장', 'Save as'],
  },
});

// ---- the device's own folder rules ------------------------------------------------------------------------------------------------------------------------------------------------------------

export type RootResolver = (alias: DesktopPlanRootAlias) => string | null;

const lower = (value: string): string => value.toLowerCase();

function isInside(parent: string, child: string): boolean {
  const p = lower(path.resolve(parent)) + path.sep;
  return (lower(path.resolve(child)) + path.sep).startsWith(p);
}

/**
 * Where the file may go. The folder comes from the device (never from the command), must exist, and must not be under the per-user application-data folders: a packaged application's writes there
 * are redirected into its private store, where nothing else - including this check - can see them. The name is a plain name inside that folder, and the file must not exist yet (nothing is replaced).
 */
/** the per-user folders in which a packaged application's writes are redirected into its private store (and the temp folders): never a place to save a document the person will look for */
export function volatileFolders(): string[] {
  return [process.env.LOCALAPPDATA, process.env.APPDATA, process.env.TEMP, process.env.TMP, os.tmpdir()].filter((folder): folder is string => Boolean(folder));
}

export function evaluateTargetPath(
  rootAlias: DesktopPlanRootAlias,
  fileName: string,
  resolveRoot: RootResolver,
  volatileRoots: string[] = volatileFolders(),
): { ok: true; target: string } | { ok: false; code: 'PATH_NOT_ALLOWED' | 'TARGET_FILE_EXISTS' } {
  const configured = resolveRoot(rootAlias);
  if (!configured || !path.isAbsolute(configured)) return { ok: false, code: 'PATH_NOT_ALLOWED' };
  let root: string;
  try {
    if (!fs.statSync(configured).isDirectory()) return { ok: false, code: 'PATH_NOT_ALLOWED' };
    root = fs.realpathSync(configured);
  } catch { return { ok: false, code: 'PATH_NOT_ALLOWED' }; }
  for (const volatileRoot of volatileRoots) {
    let real = volatileRoot;
    try { real = fs.realpathSync(volatileRoot); } catch { /* keep as given */ }
    if (isInside(real, root)) return { ok: false, code: 'PATH_NOT_ALLOWED' };
  }
  const target = path.join(root, fileName);
  if (path.dirname(target) !== root || path.basename(target) !== fileName || fileName.includes('/') || fileName.includes('\\')) return { ok: false, code: 'PATH_NOT_ALLOWED' };
  if (fs.existsSync(target)) return { ok: false, code: 'TARGET_FILE_EXISTS' };
  return { ok: true, target };
}

// ---- a command is run at most once ------------------------------------------------------------------------------------------------------------------------------------------------------------

/** remembers which commands this device has taken on, across restarts (a delivered command is never run twice) */
export class DesktopCommandReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly filePath: string, private readonly maxEntries = 500, private readonly now: () => number = Date.now) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { ids?: Array<{ id: string; at: number }> };
      for (const entry of parsed.ids ?? []) if (typeof entry.id === 'string' && Number.isFinite(entry.at)) this.seen.set(entry.id, entry.at);
    } catch { /* first run, or unreadable: start empty */ }
  }

  public has(id: string): boolean {
    return this.seen.has(id);
  }

  public remember(id: string): void {
    this.seen.set(id, this.now());
    while (this.seen.size > this.maxEntries) this.seen.delete(this.seen.keys().next().value as string);
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ids: [...this.seen.entries()].map(([key, at]) => ({ id: key, at })) }), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch { /* the in-memory record still protects this run */ }
  }
}

// ---- the executor -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface DesktopPlanExecutorOptions {
  controller: DesktopAutomationPort;
  /** who this device is: a command for anyone else is refused */
  identity: { deviceId: string; tenantId: string; ownerId: string };
  replayGuard: DesktopCommandReplayGuard;
  resolveRoot?: RootResolver;
  /** folders a document may never be saved in (defaults to the application-data and temp folders of this user); injectable for tests */
  volatileRoots?: string[];
  /** progress and the final result go to the server through this; it must not throw (a failed report is logged by the caller) */
  report: (command: DevicePendingCommand, report: DesktopPlanReport) => Promise<void>;
  now?: () => number;
  /** reads the saved file; injectable for tests */
  readFile?: (target: string) => Buffer | null;
  sleep?: (ms: number) => Promise<void>;
}

const DIALOG_WAIT_ATTEMPTS = 10;
const DIALOG_WAIT_MS = 400;

export class DesktopPlanExecutor {
  private busy = false;
  private readonly resolveRoot: RootResolver;
  private readonly now: () => number;
  private readonly readFile: (target: string) => Buffer | null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DesktopPlanExecutorOptions) {
    // no folder is assumed: the device shell supplies it; without one every path is refused
    this.resolveRoot = options.resolveRoot ?? (() => null);
    this.now = options.now ?? Date.now;
    this.readFile = options.readFile ?? ((target) => { try { return fs.readFileSync(target); } catch { return null; } });
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** What this device can drive, for its capability inventory: only what is really present. */
  public capabilities(): string[] {
    return this.options.controller.isAvailable() ? ['desktop:UIA_INTERACTIVE:NOTEPAD'] : [];
  }

  /** Never throws. Resolves when the command has been carried out (or refused) and its final report has been handed over. */
  public async handle(command: DevicePendingCommand): Promise<DesktopPlanReport> {
    let final: DesktopPlanReport;
    try {
      final = await this.run(command);
    } catch {
      final = { stage: 'FAILED', resultCode: 'EXECUTOR_ERROR', evidence: { steps: ['EXECUTOR_ERROR'] } };
    }
    try { await this.options.report(command, final); } catch { /* the caller logs a failed report */ }
    return final;
  }

  private async run(command: DevicePendingCommand): Promise<DesktopPlanReport> {
    const fail = (resultCode: DesktopPlanFailure, steps: string[], extra: Record<string, unknown> = {}): DesktopPlanReport => ({ stage: 'FAILED', resultCode, evidence: { steps, ...extra } });
    const { identity } = this.options;

    if (command.commandType !== 'DESKTOP_EXECUTE_PLAN') return fail('COMMAND_SHAPE_INVALID', ['NOT_A_DESKTOP_PLAN']);
    if (command.deviceId !== identity.deviceId || command.tenantId !== identity.tenantId || command.ownerId !== identity.ownerId) return fail('IDENTITY_MISMATCH', ['COMMAND_FOR_ANOTHER_DEVICE_OR_USER']);
    const parsed = parseDesktopWriteAndSavePlan(command.data);
    if (!parsed.ok) return fail(parsed.code as DesktopPlanFailure, ['COMMAND_REJECTED']);
    const plan = parsed.plan;
    if (plan.deviceId !== identity.deviceId || plan.tenantId !== identity.tenantId || plan.principalId !== identity.ownerId) return fail('IDENTITY_MISMATCH', ['PLAN_FOR_ANOTHER_DEVICE_OR_USER']);
    if (Date.parse(plan.expiresAt) <= this.now()) return fail('COMMAND_EXPIRED', ['PLAN_EXPIRED']);
    if (this.options.replayGuard.has(command.commandId) || this.options.replayGuard.has(plan.planId)) return fail('COMMAND_REPLAY', ['ALREADY_TAKEN_ON']);
    if (this.busy) return fail('AGENT_BUSY', ['ANOTHER_PLAN_IS_RUNNING']);

    const profile = PROFILES[plan.appId];
    if (!profile) return fail('APP_NOT_ALLOWED', ['APP_NOT_ON_THIS_DEVICE_ALLOWLIST']);
    if (!this.options.controller.isAvailable()) return fail('CONTROLLER_UNAVAILABLE', ['NATIVE_CONTROLLER_NOT_PRESENT']);
    const targetCheck = evaluateTargetPath(plan.rootAlias, plan.fileName, this.resolveRoot, this.options.volatileRoots);
    if (!targetCheck.ok) return fail(targetCheck.code, [targetCheck.code]);

    // from here on this command counts as taken on: even if it fails half-way it is never run a second time
    this.options.replayGuard.remember(command.commandId);
    this.options.replayGuard.remember(plan.planId);
    this.busy = true;
    try {
      await this.options.report(command, { stage: 'EXECUTING', resultCode: 'STARTED', evidence: { steps: ['ACCEPTED'], appId: plan.appId, mode: 'INTERACTIVE' } }).catch(() => undefined);
      return await this.carryOut(plan, profile, targetCheck.target);
    } finally {
      this.busy = false;
    }
  }

  private async carryOut(plan: DesktopWriteAndSavePlanV1, profile: DesktopAppProfile, target: string): Promise<DesktopPlanReport> {
    const controller = this.options.controller;
    const session = `dplan_${plan.planId}`.slice(0, 120);
    const steps: string[] = ['ACCEPTED'];
    const facts: Record<string, unknown> = { appId: plan.appId, mode: 'INTERACTIVE', rootAlias: plan.rootAlias, fileName: plan.fileName, textSha256: plan.textSha256, textLength: plan.text.length };
    const failed = (resultCode: DesktopPlanFailure): DesktopPlanReport => ({ stage: 'FAILED', resultCode, evidence: { ...facts, steps } });
    let windowOpen = false;
    let saved = false;
    try {
      const init = await controller.init(session, 'INTERACTIVE').catch((e: Error): DesktopWorkerResult => errorResult(e));
      if (init.status !== 'OK') { steps.push(`CONTROLLER_INIT:${init.status}`); return failed('CONTROLLER_START_FAILED'); }
      steps.push('CONTROLLER_STARTED');

      const open = await controller.openApp(session, profile.executable(), '', { mode: 'INTERACTIVE', expectClass: profile.expectClass, expectImage: profile.expectImage }).catch((e: Error): DesktopWorkerResult => errorResult(e));
      if (open.status === 'TARGET_AMBIGUOUS') { steps.push('NEW_WINDOW:AMBIGUOUS'); facts.newWindows = open.matchCount; return failed('UNEXPECTED_WINDOW'); }
      if (open.status !== 'OK') { steps.push(`APP_OPEN:${open.status}`); facts.nativeCode = open.errorCode ?? ''; return failed(open.status === 'FAILED' ? 'APP_WINDOW_NOT_FOUND' : 'APP_START_FAILED'); }
      windowOpen = true;
      steps.push('APP_WINDOW_FOUND_BY_HANDLE');
      const preexisting = /preexistingSameClass=(\d+)/.exec(open.observedAfter ?? '');
      if (preexisting) facts.otherWindowsOfTheApplicationUntouched = Number(preexisting[1]);

      // a brand-new document only: whatever is in the editor already is not ours to write over
      const blank = await controller.observe(session, '', profile.editor).catch((e: Error): DesktopWorkerResult => errorResult(e));
      if (blank.status !== 'OK' || (blank.observedAfter ?? '') !== '') { steps.push(`EDITOR_CHECK:${blank.status}`); return failed('DOCUMENT_NOT_EMPTY'); }
      steps.push('DOCUMENT_IS_BLANK');

      const typed = await controller.mutate(session, 'SET_VALUE', '', plan.text, profile.editor).catch((e: Error): DesktopWorkerResult => errorResult(e));
      if (typed.status !== 'SUCCEEDED_VERIFIED') { steps.push(`TEXT_ENTRY:${typed.status}`); return failed('TEXT_ENTRY_NOT_VERIFIED'); }
      steps.push('TEXT_ENTERED_AND_READ_BACK');

      const expanded = await controller.mutate(session, 'EXPAND', '', undefined, profile.fileMenu).catch((e: Error): DesktopWorkerResult => errorResult(e));
      if (expanded.status !== 'SUCCEEDED_VERIFIED') { steps.push(`FILE_MENU:${expanded.status}`); return failed('MENU_NOT_FOUND'); }
      steps.push('FILE_MENU_OPENED');

      const saveAs = await controller.mutate(session, 'INVOKE', '', undefined, { controlType: 'MenuItem', names: profile.saveAsNames }).catch((e: Error): DesktopWorkerResult => errorResult(e));
      if (saveAs.status !== 'SUCCEEDED_VERIFIED') { steps.push(`SAVE_AS_ITEM:${saveAs.status}`); facts.saveAsMatches = saveAs.matchCount; return failed('SAVE_AS_NOT_FOUND'); }
      steps.push('SAVE_AS_OPENED');

      // the dialog opens a moment later: ask again, a bounded number of times
      let named: DesktopWorkerResult = { requestId: null, status: 'FAILED', observedBefore: null, observedAfter: null, verification: false, errorCode: 'FILE_DIALOG_NOT_FOUND', matchCount: 0 };
      for (let attempt = 0; attempt < DIALOG_WAIT_ATTEMPTS; attempt += 1) {
        named = await controller.dialogSetFilename(session, target).catch((e: Error): DesktopWorkerResult => errorResult(e));
        if (named.errorCode !== 'FILE_DIALOG_NOT_FOUND') break;
        await this.sleep(DIALOG_WAIT_MS);
      }
      if (named.errorCode === 'FILE_DIALOG_NOT_FOUND') { steps.push('FILE_DIALOG:NOT_FOUND'); return failed('FILE_DIALOG_NOT_FOUND'); }
      if (named.status !== 'SUCCEEDED_VERIFIED') { steps.push(`FILE_NAME_ENTRY:${named.status}`); await controller.dialogPress(session, 'CANCEL').catch(() => undefined); return failed('FILENAME_ENTRY_FAILED'); }
      steps.push('FILE_NAME_ENTERED_AND_READ_BACK');

      const pressed = await controller.dialogPress(session, 'SAVE').catch((e: Error): DesktopWorkerResult => errorResult(e));
      if (pressed.errorCode === 'CONFIRM_PROMPT_OPEN') {
        // the application asks whether to replace a file: nothing is replaced - the answer is no, and the work is abandoned
        steps.push('SAVE:CONFIRM_PROMPT');
        await controller.dialogPress(session, 'NO').catch(() => undefined);
        await controller.dialogPress(session, 'CANCEL').catch(() => undefined);
        return failed('CONFIRM_PROMPT_OPEN');
      }
      if (pressed.status !== 'SUCCEEDED_VERIFIED') { steps.push(`SAVE:${pressed.status}`); await controller.dialogPress(session, 'CANCEL').catch(() => undefined); return failed('SAVE_NOT_COMPLETED'); }
      steps.push('SAVE_PRESSED_DIALOG_CLOSED');

      // the window title names the file once it is saved (evidence only; the file itself decides)
      const title = await controller.observe(session, '@window').catch((e: Error): DesktopWorkerResult => errorResult(e));
      if (title.status === 'OK') facts.windowTitleNamesTheFile = (title.observedAfter ?? '').includes(plan.fileName);

      // the device reads the file back itself and compares it with what was approved
      const content = this.readFile(target);
      if (!content) { steps.push('FILE:NOT_ON_DISK'); return failed('FILE_VERIFICATION_MISMATCH'); }
      const body = stripBom(content).toString('utf8');
      facts.fileSizeBytes = content.length;
      facts.fileSha256 = crypto.createHash('sha256').update(content).digest('hex');
      facts.fileTextSha256 = desktopTextSha256(body);
      const matches = body === plan.text;
      facts.fileMatchesApprovedText = matches;
      if (!matches) { steps.push('FILE:CONTENT_DIFFERS'); saved = true; return failed('FILE_VERIFICATION_MISMATCH'); }
      saved = true;
      steps.push('FILE_READ_BACK_MATCHES_APPROVED_TEXT');

      const closed = await controller.closeApp(session).catch((e: Error): DesktopWorkerResult => errorResult(e));
      facts.windowClosed = closed.status === 'OK';
      steps.push(closed.status === 'OK' ? 'WINDOW_CLOSED' : `WINDOW_CLOSE:${closed.status}`);
      windowOpen = closed.status !== 'OK';
      return { stage: 'COMPLETED', resultCode: 'DESKTOP_SAVED_VERIFIED', evidence: { ...facts, steps } };
    } catch {
      steps.push('EXECUTOR_ERROR');
      return failed('EXECUTOR_ERROR');
    } finally {
      // leave nothing behind: a window opened for this plan that is not saved is discarded (it holds only what this plan typed); then the controller is shut down
      if (windowOpen && !saved) {
        const discarded = await controller.closeDiscard(session).catch((e: Error): DesktopWorkerResult => errorResult(e));
        steps.push(discarded.status === 'OK' ? 'OWN_WINDOW_DISCARDED' : `OWN_WINDOW_DISCARD:${discarded.status}`);
      }
      await controller.shutdown(session).catch(() => undefined);
    }
  }
}

function errorResult(error: Error): DesktopWorkerResult {
  return { requestId: null, status: 'ERR', observedBefore: null, observedAfter: null, verification: false, errorCode: error.message.slice(0, 80), matchCount: -1 };
}

function stripBom(buffer: Buffer): Buffer {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
}
