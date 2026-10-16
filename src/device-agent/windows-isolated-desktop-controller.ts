// DC3-B2 Production — WindowsIsolatedDesktopController.
//
// The only place in NAgex Main that spawns and speaks to the native
// isolated-desktop execution helper (native/windows-desktop-controller/
// NagexDesktopController.exe). One native controller process per
// DesktopExecutionSession, communicating over that child process's own
// stdin/stdout (a private channel by construction — only this process,
// as the direct parent, can write to it). The controller in turn owns a
// dedicated Win32 desktop object and a Job-Object-owned UIA worker on it;
// see native/windows-desktop-controller/*.cs for the full mechanics,
// proven real on this host across DC3-B2-R1 through R3.
//
// This class never touches Win32 APIs directly and never uses SendInput —
// it only ever forwards the bounded action vocabulary (OPEN_APP/
// CLOSE_APP/OBSERVE/SET_VALUE/INVOKE/TOGGLE/SELECT/SCROLL/EXPAND/CANCEL/
// SHUTDOWN, plus the file-dialog primitives DIALOG_SET_FILENAME / DIALOG_PRESS
// and the failure clean-up CLOSE_DISCARD) and maps native responses onto
// NAgex's own truthful status vocabulary. The mode is ISOLATED (a hidden
// desktop) or INTERACTIVE (the user's desktop, for applications that cannot
// run hidden). It is not an authorization system: every call here is made
// only after DesktopControlService has already validated tenant/owner/
// device/session/policy/approval/allowlist — this class trusts its own
// caller within the process, exactly as the worker trusts this class.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTROLLER_EXE = path.join(REPO_ROOT, 'native', 'windows-desktop-controller', 'NagexDesktopController.exe');

export type DesktopMutationStatus =
  | 'OK'
  | 'SUCCEEDED_VERIFIED'
  | 'FAILED'
  | 'TARGET_AMBIGUOUS'
  | 'TARGET_CHANGED_SINCE_OBSERVATION'
  | 'CLOSE_UNSAFE'
  | 'CANCELLED'
  | 'ERR';

export type DesktopMode = 'ISOLATED' | 'INTERACTIVE';

/** One element of the application window, named by what it is. Exactly one match is required to act on it. */
export interface DesktopElementSelector {
  automationId?: string;
  name?: string;
  /** any of these accessible names: the same control under several display languages */
  names?: string[];
  className?: string;
  controlType?: 'Document' | 'MenuItem' | 'Button' | 'Edit' | 'Window' | 'Text' | 'Pane';
}

export interface DesktopOpenAppOptions {
  mode?: DesktopMode;
  /** INTERACTIVE: the window class the application's window must have */
  expectClass?: string;
  /** INTERACTIVE: a file name the owning process image must contain */
  expectImage?: string;
}

export interface DesktopWorkerResult {
  requestId: string | null;
  status: DesktopMutationStatus;
  observedBefore: string | null;
  observedAfter: string | null;
  verification: boolean;
  errorCode: string | null;
  matchCount: number;
}

interface PendingRequest {
  resolve: (result: DesktopWorkerResult) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

interface NativeSession {
  child: ChildProcessWithoutNullStreams;
  rl: readline.Interface;
  pending: PendingRequest | null;
  queue: Array<() => void>;
}

const REQUEST_TIMEOUT_MS = 20_000;

export class WindowsIsolatedDesktopController {
  private readonly sessions = new Map<string, NativeSession>();

  // Truthful availability — never assumed. device.desktop.execute must
  // report unavailable, not silently no-op, when this is false.
  public isAvailable(): boolean {
    if (process.platform !== 'win32') return false;
    try {
      return fs.existsSync(CONTROLLER_EXE);
    } catch {
      return false;
    }
  }

  public async init(executionSessionId: string, mode: DesktopMode = 'ISOLATED'): Promise<DesktopWorkerResult> {
    if (this.sessions.has(executionSessionId)) {
      throw new Error(`WindowsIsolatedDesktopController: session ${executionSessionId} already initialized`);
    }
    const child = spawn(CONTROLLER_EXE, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as ChildProcessWithoutNullStreams;
    const rl = readline.createInterface({ input: child.stdout });
    const session: NativeSession = { child, rl, pending: null, queue: [] };
    this.sessions.set(executionSessionId, session);

    rl.on('line', (line) => this.handleLine(session, line));
    child.on('exit', () => {
      if (session.pending) {
        session.pending.reject(new Error('native controller exited unexpectedly'));
        clearTimeout(session.pending.timeout);
        session.pending = null;
      }
    });

    return this.send(executionSessionId, { cmd: 'INIT', requestId: 'init', ...(mode === 'INTERACTIVE' ? { mode } : {}) });
  }

  public async openApp(executionSessionId: string, appExePath: string, appArgs: string, options: DesktopOpenAppOptions = {}): Promise<DesktopWorkerResult> {
    return this.send(executionSessionId, {
      cmd: 'OPEN_APP', requestId: this.newRequestId(), appExePath, appArgs,
      ...(options.mode === 'INTERACTIVE' ? { mode: 'INTERACTIVE', expectClass: options.expectClass, expectImage: options.expectImage } : {}),
    });
  }

  /** `target` is an AutomationId; '@window' reads the title of the window this execution opened; a selector replaces the target */
  public async observe(executionSessionId: string, target: string, selector?: DesktopElementSelector): Promise<DesktopWorkerResult> {
    return this.send(executionSessionId, { cmd: 'OBSERVE', requestId: this.newRequestId(), target, ...(selector ? { selector } : {}) });
  }

  public async mutate(
    executionSessionId: string,
    pattern: 'SET_VALUE' | 'INVOKE' | 'TOGGLE' | 'SELECT' | 'SCROLL' | 'EXPAND',
    target: string,
    value?: string,
    selector?: DesktopElementSelector
  ): Promise<DesktopWorkerResult> {
    return this.send(executionSessionId, { cmd: 'MUTATE', requestId: this.newRequestId(), pattern, target, value, ...(selector ? { selector } : {}) });
  }

  /** The full path goes into the open file dialog's file-name box (entered and read back inside the native worker). */
  public async dialogSetFilename(executionSessionId: string, absolutePath: string): Promise<DesktopWorkerResult> {
    return this.send(executionSessionId, { cmd: 'DIALOG', requestId: this.newRequestId(), dialogAction: 'SET_FILENAME', value: absolutePath });
  }

  /** SAVE / CANCEL press the dialog's own buttons; NO answers its "replace the file?" prompt. */
  public async dialogPress(executionSessionId: string, which: 'SAVE' | 'CANCEL' | 'NO'): Promise<DesktopWorkerResult> {
    return this.send(executionSessionId, { cmd: 'DIALOG', requestId: this.newRequestId(), dialogAction: 'PRESS', value: which });
  }

  /** Failure clean-up of the window this execution opened: close it and answer "do not save" to the application's question. */
  public async closeDiscard(executionSessionId: string): Promise<DesktopWorkerResult> {
    return this.send(executionSessionId, { cmd: 'CLOSE_DISCARD', requestId: this.newRequestId() });
  }

  public async closeApp(executionSessionId: string): Promise<DesktopWorkerResult> {
    return this.send(executionSessionId, { cmd: 'CLOSE_APP', requestId: this.newRequestId() });
  }

  public async cancel(executionSessionId: string): Promise<DesktopWorkerResult> {
    return this.send(executionSessionId, { cmd: 'CANCEL', requestId: this.newRequestId() });
  }

  // Graceful shutdown first, always — this never force-kills the native
  // controller/worker/target. The worker's own Job Object
  // (KILL_ON_JOB_CLOSE) is the only emergency path, and it triggers
  // purely as a consequence of the worker process's own handle closing —
  // never invoked directly from here.
  public async shutdown(executionSessionId: string): Promise<DesktopWorkerResult> {
    const result = await this.send(executionSessionId, { cmd: 'SHUTDOWN', requestId: this.newRequestId() });
    const session = this.sessions.get(executionSessionId);
    if (session) {
      session.rl.close();
      this.sessions.delete(executionSessionId);
    }
    return result;
  }

  public hasSession(executionSessionId: string): boolean {
    return this.sessions.has(executionSessionId);
  }

  private newRequestId(): string {
    return 'req_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  private handleLine(session: NativeSession, line: string): void {
    if (!session.pending) return; // unsolicited/stray line — dropped, never queued as a phantom response
    let parsed: DesktopWorkerResult;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = { requestId: null, status: 'ERR', observedBefore: null, observedAfter: null, verification: false, errorCode: 'RESPONSE_PARSE_ERROR', matchCount: -1 };
    }
    const pending = session.pending;
    session.pending = null;
    clearTimeout(pending.timeout);
    pending.resolve(this.normalize(parsed));
    this.drainQueue(session);
  }

  private drainQueue(session: NativeSession): void {
    const next = session.queue.shift();
    if (next) next();
  }

  private normalize(raw: Partial<DesktopWorkerResult>): DesktopWorkerResult {
    return {
      requestId: raw.requestId ?? null,
      status: (raw.status as DesktopMutationStatus) ?? 'ERR',
      observedBefore: raw.observedBefore ?? null,
      observedAfter: raw.observedAfter ?? null,
      verification: Boolean(raw.verification),
      errorCode: raw.errorCode ?? null,
      matchCount: typeof raw.matchCount === 'number' ? raw.matchCount : -1,
    };
  }

  // Requests to the same session are serialized (the native controller
  // itself processes its stdin one line at a time, synchronously) —
  // never sent concurrently, avoiding any need for response
  // multiplexing on top of a protocol that is not itself multiplexed.
  private send(executionSessionId: string, command: Record<string, unknown>): Promise<DesktopWorkerResult> {
    const session = this.sessions.get(executionSessionId);
    if (!session) {
      return Promise.reject(new Error(`WindowsIsolatedDesktopController: no session ${executionSessionId}`));
    }
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const timeout = setTimeout(() => {
          session.pending = null;
          reject(new Error('native controller request timed out'));
          this.drainQueue(session);
        }, REQUEST_TIMEOUT_MS);
        session.pending = { resolve, reject, timeout };
        session.child.stdin.write(JSON.stringify(command) + '\n');
      };
      if (session.pending) {
        session.queue.push(attempt);
      } else {
        attempt();
      }
    });
  }
}
