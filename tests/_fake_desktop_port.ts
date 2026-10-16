// A SCRIPTED STAND-IN for the native Windows controller, used by tests that exercise everything AROUND it (the device executor, the server, the screen). Every call is recorded and behaviour is
// switched per test. It is NOT evidence that a real application was driven: that is desktop_windows_notepad_real.test.ts (opt-in, real PC).
import fs from 'node:fs';
import path from 'node:path';
import type { DesktopAutomationPort } from '../src/device-agent/desktop-plan-executor.js';
import type { DesktopElementSelector, DesktopMode, DesktopOpenAppOptions, DesktopWorkerResult } from '../src/device-agent/windows-isolated-desktop-controller.js';

export const result = (patch: Partial<DesktopWorkerResult> = {}): DesktopWorkerResult => ({ requestId: null, status: 'OK', observedBefore: null, observedAfter: null, verification: false, errorCode: null, matchCount: 1, ...patch });

// A scripted stand-in for the native controller. Every call is recorded; behaviour is switched per test.
export class FakeDesktop implements DesktopAutomationPort {
  public calls: string[] = [];
  public available = true;
  public open: Partial<DesktopWorkerResult> = { status: 'OK', observedAfter: 'hwnd=777;preexistingSameClass=1', matchCount: 1 };
  public editorValue = '';
  public typed: Partial<DesktopWorkerResult> | null = null;
  public menu: Partial<DesktopWorkerResult> | null = null;
  public saveAsMatches: Partial<DesktopWorkerResult> | null = null;
  public dialogNotFoundTimes = 0;
  public filename: Partial<DesktopWorkerResult> | null = null;
  public confirmPrompt = false;
  public savedPath = '';
  public openAppArgs: { exe: string; options?: DesktopOpenAppOptions } | null = null;
  public sessionIds = new Set<string>();
  public onSave: (target: string, text: string) => void = (target, text) => fs.writeFileSync(target, text, 'utf8');
  public slow: Promise<void> | null = null;

  isAvailable() { return this.available; }
  hasSession(id: string) { return this.sessionIds.has(id); }
  async init(id: string, mode?: DesktopMode) { this.calls.push(`init:${mode}`); this.sessionIds.add(id); return result(); }
  async openApp(_id: string, exe: string, _args: string, options?: DesktopOpenAppOptions) {
    this.calls.push('openApp'); this.openAppArgs = { exe, options };
    if (this.slow) await this.slow;
    return result(this.open);
  }
  async observe(_id: string, target: string, selector?: DesktopElementSelector) {
    if (target === '@window') { this.calls.push('observe:@window'); return result({ observedAfter: this.savedPath ? `${path.basename(this.savedPath)} - Notepad` : 'Untitled - Notepad' }); }
    this.calls.push(`observe:${selector?.className ?? target}`); return result({ observedAfter: this.editorValue });
  }
  async mutate(_id: string, pattern: string, _target: string, value?: string, selector?: DesktopElementSelector) {
    this.calls.push(`mutate:${pattern}`);
    if (pattern === 'SET_VALUE') { this.editorValue = value ?? ''; return result(this.typed ?? { status: 'SUCCEEDED_VERIFIED', verification: true, observedAfter: value }); }
    if (pattern === 'EXPAND') return result(this.menu ?? { status: 'SUCCEEDED_VERIFIED', verification: true });
    if (pattern === 'INVOKE') { this.calls.push(`invoke:${(selector?.names ?? []).join('|')}`); return result(this.saveAsMatches ?? { status: 'SUCCEEDED_VERIFIED', verification: true }); }
    return result({ status: 'ERR', errorCode: 'UNEXPECTED_PATTERN' });
  }
  async dialogSetFilename(_id: string, absolutePath: string) {
    this.calls.push('dialog:setFilename');
    if (this.dialogNotFoundTimes > 0) { this.dialogNotFoundTimes -= 1; return result({ status: 'FAILED', errorCode: 'FILE_DIALOG_NOT_FOUND', matchCount: 0 }); }
    this.savedPath = absolutePath;
    return result(this.filename ?? { status: 'SUCCEEDED_VERIFIED', verification: true });
  }
  async dialogPress(_id: string, which: 'SAVE' | 'CANCEL' | 'NO') {
    this.calls.push(`dialog:press:${which}`);
    if (which !== 'SAVE') return result({ status: 'SUCCEEDED_VERIFIED', verification: true });
    if (this.confirmPrompt) return result({ status: 'FAILED', errorCode: 'CONFIRM_PROMPT_OPEN' });
    this.onSave(this.savedPath, this.editorValue);
    return result({ status: 'SUCCEEDED_VERIFIED', verification: true, observedAfter: 'DIALOG_CLOSED' });
  }
  async closeApp() { this.calls.push('closeApp'); return result(); }
  async closeDiscard() { this.calls.push('closeDiscard'); return result(); }
  async shutdown(id: string) { this.calls.push('shutdown'); this.sessionIds.delete(id); return result(); }
}
