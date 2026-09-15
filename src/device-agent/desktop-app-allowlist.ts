// DC3-B2 Production — Desktop application allowlist.
//
// The model (and any request payload derived from it) must never carry a
// trusted executable path — only a canonical appId. Resolution from
// appId to a real, local executable happens here, entirely server-side,
// never influenced by request content beyond the appId string itself.
// An unrecognized appId is APP_NOT_ALLOWED, never a best-effort guess.
//
// Alpha scope is deliberately small (Section 19): only the dedicated
// NAgex UIA test harness is allowlisted at launch. Additional
// applications are added here only after being proven safe during
// implementation — never opened up generically.
import fs from 'node:fs';
import path from 'node:path';

export type DesktopAppResolution = { status: 'RESOLVED'; appId: string; executablePath: string } | { status: 'APP_NOT_ALLOWED'; appId: string };

// dist/src/device-agent -> repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  NAGEX_TEST_HARNESS: path.join(REPO_ROOT, 'tools', 'uia-test-harness', 'NagexUiaTestHarnessWpf.exe'),
});

export class DesktopAppAllowlist {
  public resolve(appId: string): DesktopAppResolution {
    const executablePath = ALLOWLIST[appId];
    if (!executablePath) {
      return { status: 'APP_NOT_ALLOWED', appId };
    }
    return { status: 'RESOLVED', appId, executablePath };
  }

  // Existence is checked lazily at resolve-time call sites (not baked
  // into resolve() itself) so unit tests can exercise allowlist/deny
  // logic without requiring the real compiled .exe to be present on
  // disk — see DesktopControlService, which checks this before OPEN_APP.
  public executableExists(executablePath: string): boolean {
    try {
      return fs.existsSync(executablePath);
    } catch {
      return false;
    }
  }
}
