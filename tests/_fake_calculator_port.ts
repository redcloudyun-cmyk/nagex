// A SCRIPTED STAND-IN for the native Windows controller as the Calculator, used by tests that exercise everything AROUND it (the device executor, the server, the screen). It models the Calculator's keys
// by their automation ids (num0Button .. num9Button, plusButton, minusButton, multiplyButton, equalButton, clearButton) and its display ("Display is 1,234"), and can be told to misbehave. It is NOT evidence
// that a real application was driven: that is the opt-in tests on a real PC (desktop_task_real_ui.test.ts).
import type { DesktopAutomationPort } from '../src/device-agent/desktop-plan-executor.js';
import type { DesktopElementSelector, DesktopMode, DesktopOpenAppOptions, DesktopWorkerResult } from '../src/device-agent/windows-isolated-desktop-controller.js';
import { result } from './_fake_desktop_port.js';

const OPERATORS: Record<string, '+' | '-' | '*'> = { plusButton: '+', minusButton: '-', multiplyButton: '*' };

export class FakeCalculator implements DesktopAutomationPort {
  public calls: string[] = [];
  public available = true;
  public sessionIds = new Set<string>();
  public open: Partial<DesktopWorkerResult> = { status: 'OK', observedAfter: 'hwnd=888;preexistingSameClass=0', matchCount: 1 };
  public openAppArgs: { exe: string; options?: DesktopOpenAppOptions } | null = null;
  public pressed: string[] = [];
  // behaviour switches
  /** this key resolves to nothing (the window has no such control) */
  public missingKey: string | null = null;
  /** pressing this digit key makes the display show another digit */
  public misread: { key: string; shows: string } | null = null;
  /** the equals key shows this instead of the real result */
  public wrongResult: number | null = null;
  /** the display never says zero after clear */
  public stuckDisplay: string | null = null;
  public closeOk = true;
  // the calculator itself
  private display = '0';
  private accumulator: number | null = null;
  private pending: '+' | '-' | '*' | null = null;
  private startNew = true;

  isAvailable() { return this.available; }
  hasSession(id: string) { return this.sessionIds.has(id); }
  async init(id: string, mode?: DesktopMode) { this.calls.push(`init:${mode}`); this.sessionIds.add(id); return result(); }
  async openApp(_id: string, exe: string, _args: string, options?: DesktopOpenAppOptions) {
    this.calls.push('openApp'); this.openAppArgs = { exe, options };
    return result(this.open);
  }
  private shown(): string {
    const value = this.stuckDisplay ?? this.display;
    return `Display is ${Number(value).toLocaleString('en-US')}`;
  }
  async observe(_id: string, target: string, selector?: DesktopElementSelector) {
    const id = selector?.automationId ?? target;
    this.calls.push(`observe:${id}`);
    if (id === 'CalculatorResults') return result({ observedAfter: this.shown() });
    return result({ status: 'TARGET_AMBIGUOUS', matchCount: 0 });
  }
  async mutate(_id: string, pattern: string, _target: string, _value?: string, selector?: DesktopElementSelector) {
    const key = selector?.automationId ?? '';
    this.calls.push(`mutate:${pattern}:${key}`);
    if (pattern !== 'INVOKE') return result({ status: 'ERR', errorCode: 'UNEXPECTED_PATTERN' });
    if (key === this.missingKey) return result({ status: 'TARGET_AMBIGUOUS', matchCount: 0 });
    this.pressed.push(key);
    const digit = /^num(\d)Button$/.exec(key);
    if (key === 'clearButton') { this.display = '0'; this.accumulator = null; this.pending = null; this.startNew = true; return result({ status: 'SUCCEEDED_VERIFIED', verification: true }); }
    if (digit) {
      const entered = this.misread && this.misread.key === key ? this.misread.shows : digit[1];
      this.display = this.startNew || this.display === '0' ? entered : this.display + entered;
      this.startNew = false;
      return result({ status: 'SUCCEEDED_VERIFIED', verification: true });
    }
    if (OPERATORS[key]) { this.accumulator = Number(this.display); this.pending = OPERATORS[key]; this.startNew = true; return result({ status: 'SUCCEEDED_VERIFIED', verification: true }); }
    if (key === 'equalButton') {
      if (this.pending && this.accumulator !== null) {
        const right = Number(this.display);
        const value = this.pending === '+' ? this.accumulator + right : this.pending === '-' ? this.accumulator - right : this.accumulator * right;
        this.display = String(this.wrongResult ?? value);
        this.pending = null; this.startNew = true;
      }
      return result({ status: 'SUCCEEDED_VERIFIED', verification: true });
    }
    return result({ status: 'TARGET_AMBIGUOUS', matchCount: 0 });
  }
  async dialogSetFilename() { this.calls.push('dialog:setFilename'); return result({ status: 'ERR', errorCode: 'NOT_A_DOCUMENT_APP' }); }
  async dialogPress() { this.calls.push('dialog:press'); return result({ status: 'ERR', errorCode: 'NOT_A_DOCUMENT_APP' }); }
  async closeApp() { this.calls.push('closeApp'); return result(this.closeOk ? {} : { status: 'FAILED' }); }
  async closeDiscard() { this.calls.push('closeDiscard'); return result(); }
  async shutdown(id: string) { this.calls.push('shutdown'); this.sessionIds.delete(id); return result(); }
}
