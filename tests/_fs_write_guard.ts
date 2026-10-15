// Process-level tripwire for the test harness (P0 2026-10-15): in test mode, any filesystem MUTATION whose target resolves inside a live data location
// (/var/lib/nagex, the per-user fallback data dir, <cwd>/.nagex_data, or a root named in NAGEX_TEST_FORBIDDEN_ROOTS) throws BEFORE the operation reaches the OS.
//
// This is the backstop behind the data-root resolver: the resolver stops the stores we know; this guard stops a store (or a stray fs call) we did not think of, including future ones.
// It never touches reads, and it never refuses a path outside the forbidden roots (tests legitimately write fixtures, dist output and screenshots elsewhere).
import fs from 'node:fs';
import { forbiddenDataRoots, isTestDataMode, isUnder, TestIsolationError } from '../src/governance/data-root-isolation.js';
import path from 'node:path';

type AnyFn = (...args: any[]) => any;

// name -> indexes of the arguments that are paths the call may create / change / delete
const MUTATORS: Record<string, number[]> = {
  writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], rename: [0, 1], copyFile: [1], cp: [1], link: [1], symlink: [1],
  unlink: [0], rm: [0], rmdir: [0], truncate: [0], chmod: [0], chown: [0], lchown: [0], utimes: [0], lutimes: [0], open: [0],
};
const SYNC_AND_CB = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rename', 'copyFile', 'cp', 'link', 'symlink', 'unlink', 'rm', 'rmdir', 'truncate', 'chmod', 'chown', 'lchown', 'utimes', 'lutimes', 'open'];

function realLoose(p: string): string {
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

function targetText(arg: unknown): string | null {
  if (typeof arg === 'string') return arg;
  if (arg instanceof URL) return arg.protocol === 'file:' ? decodeURIComponent(arg.pathname.replace(/^\/([A-Za-z]:)/, '$1')) : null;
  if (Buffer.isBuffer(arg)) return arg.toString();
  return null; // file descriptors and other shapes cannot be judged here
}

function openWrites(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false; // default 'r'
  if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_TRUNC)) !== 0;
  return /[wa+]/.test(String(flags));
}

let installed = false;
// The forbidden set is resolved lazily per call (cwd and NAGEX_TEST_FORBIDDEN_ROOTS can legitimately differ per test) but its realpaths are cached by string.
const realCache = new Map<string, string>();
function forbiddenReal(root: string): string {
  let r = realCache.get(root);
  if (r === undefined) { r = realLoose(root); realCache.set(root, r); }
  return r;
}

export function assertNotLiveDataWrite(op: string, target: unknown): void {
  const text = targetText(target);
  if (!text) return;
  const resolved = path.resolve(text);
  const real = realLoose(resolved);
  for (const root of forbiddenDataRoots()) {
    if (isUnder(resolved, root) || isUnder(real, forbiddenReal(root))) {
      throw new TestIsolationError(`Test isolation tripwire: ${op} on a live data location (${root}) was blocked before it reached the filesystem.`);
    }
  }
}

export function installFsWriteGuard(): void {
  if (installed || !isTestDataMode()) return;
  installed = true;
  const targets: Array<Record<string, any>> = [fs as any, fs.promises as any];
  for (const target of targets) {
    const promises = target === (fs.promises as any);
    for (const name of SYNC_AND_CB) {
      const idx = MUTATORS[name];
      const variants = promises ? [name] : [name, `${name}Sync`];
      for (const v of variants) {
        const original = target[v] as AnyFn | undefined;
        if (typeof original !== 'function') continue;
        target[v] = function guarded(this: unknown, ...args: any[]) {
          try {
            if (name === 'open') {
              // open is a mutation only when it opens for writing
              if (openWrites(args[1])) assertNotLiveDataWrite(v, args[0]);
            } else {
              for (const i of idx) assertNotLiveDataWrite(v, args[i]);
            }
          } catch (error) {
            // promise-returning variants refuse by rejecting, like every other failure of theirs
            if (promises) return Promise.reject(error);
            throw error;
          }
          return original.apply(this, args);
        };
      }
    }
  }
  const originalStream = fs.createWriteStream as AnyFn;
  (fs as any).createWriteStream = function guardedStream(this: unknown, ...args: any[]) {
    assertNotLiveDataWrite('createWriteStream', args[0]);
    return originalStream.apply(this, args);
  };
}

installFsWriteGuard();
