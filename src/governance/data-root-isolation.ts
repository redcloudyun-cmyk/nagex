import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// P0 (2026-10-15): a test run on the service host wrote 368 records into the LIVE data root, because a store whose environment variable was unset resolved to /var/lib/nagex whenever that
// directory was writable, and the test setup only redirected the stores it knew by name (the same class of leak had been fixed one store at a time before: R16 identity, R24.6C1 vault,
// R24.8B plans). This module ends the whack-a-mole: in TEST MODE every persistent path must live under a private test root, and anything else is refused BEFORE the first write.
//
// Test mode is explicit and cannot be switched on by accident: it needs BOTH NAGEX_TEST_DATA_ROOT and NAGEX_TEST_DATA_ROOT_OWNER_PID (set only by tests/_setup.ts) naming a LIVE process, and it is
// refused outright in a process that says it is production (NODE_ENV=production). Production behaviour (no test root) is byte-for-byte what it always was.

export const PRODUCTION_DATA_ROOT = '/var/lib/nagex';

export class TestIsolationError extends Error {
  public readonly code = 'TEST_ISOLATION_VIOLATION';
  constructor(message: string) {
    super(message);
    this.name = 'TestIsolationError';
  }
}

// The owner pid must name a process that is still alive: variables left behind in a shell (or an env file) by a finished test run name a dead pid and therefore can never redirect a real
// server's storage into a stale temp directory.
function ownerIsAlive(pidText: string): boolean {
  const pid = Number(pidText);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
  }
}

export function isTestDataMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const root = env.NAGEX_TEST_DATA_ROOT;
  if (!root || !env.NAGEX_TEST_DATA_ROOT_OWNER_PID) return false;
  if (!ownerIsAlive(env.NAGEX_TEST_DATA_ROOT_OWNER_PID)) return false;
  if (env.NODE_ENV === 'production') throw new TestIsolationError('A test data root is set in a process that declares NODE_ENV=production; refusing to redirect production storage.');
  return true;
}

// realpath of the deepest EXISTING ancestor of `p`, with the not-yet-created remainder appended - so a symlink anywhere in the path (inside the root pointing out of it) is seen.
function realPathLoose(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(current, ...rest.reverse());
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

const caseFold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
export function isUnder(child: string, parent: string): boolean {
  const c = caseFold(path.resolve(child));
  const p = caseFold(path.resolve(parent));
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// Locations a test must NEVER write: the production data root, the per-user fallback data directory, the working-directory fallback of the reminder store, the desktop agent's home directory, and anything the caller adds
// through NAGEX_TEST_FORBIDDEN_ROOTS (path-delimiter separated; used to plant sentinel "production roots" in tests).
export function forbiddenDataRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.NAGEX_TEST_FORBIDDEN_ROOTS ?? '').split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  return [PRODUCTION_DATA_ROOT, path.join(os.homedir(), '.local', 'share', 'nagex'), path.join(process.cwd(), '.nagex_data'), path.join(os.homedir(), '.nagex'), ...extra];
}

// Where a test may keep data: the private test root, or the OS temp directory (the browser harnesses create their own temp roots there).
export function allowedTestRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [os.tmpdir()];
  if (env.NAGEX_TEST_DATA_ROOT) roots.push(env.NAGEX_TEST_DATA_ROOT);
  return roots;
}

// Returns the absolute path when it is safe for a test, otherwise throws - never creates anything.
export function assertIsolatedTestPath(target: string, env: NodeJS.ProcessEnv = process.env, what = 'a data path'): string {
  const resolved = path.resolve(target);
  const real = realPathLoose(resolved);
  for (const forbidden of forbiddenDataRoots(env)) {
    const forbiddenReal = realPathLoose(forbidden);
    if (isUnder(real, forbiddenReal) || isUnder(resolved, forbidden)) {
      throw new TestIsolationError(`Refusing ${what}: it resolves inside a live data location (${forbidden}). Tests must keep every store under their private test root.`);
    }
  }
  // judged on the REAL location, so a link inside an allowed root that leads out of it is refused too
  if (!allowedTestRoots(env).some((root) => isUnder(real, realPathLoose(root)))) {
    throw new TestIsolationError(`Refusing ${what}: it is outside the test data root and the OS temp directory (${resolved}${real !== resolved ? ` -> ${real}` : ''}).`);
  }
  return resolved;
}

// In test mode: the private location for a named store (or file), checked. Outside test mode: null (the caller keeps its production default).
export function testDataPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!isTestDataMode(env)) return null;
  return assertIsolatedTestPath(path.join(env.NAGEX_TEST_DATA_ROOT as string, name), env, `the store "${name}"`);
}
