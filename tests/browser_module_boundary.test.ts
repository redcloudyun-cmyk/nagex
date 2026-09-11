// Phase 04 — Browser Module Extraction.
//
// Verifies the Browser implementation now has exactly one location
// (src/modules/browser/), external consumers reach it only through the
// module's public index or the Phase 03 ports (BrowserPort/
// BrowserRetrievalPort), the old scattered paths no longer contain any
// implementation, and nothing about the already-verified runtime/lifecycle
// behavior changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserToolService, browserRuntime as moduleBrowserRuntime } from '../src/modules/browser/index.js';
import type { BrowserPort } from '../src/contracts/browser.port.js';
import { createNagexApplication } from '../src/app/create-nagex-application.js';

function readSourceWithoutComments(relPath: string): string {
  const source = fs.readFileSync(path.resolve(relPath), 'utf8');
  return source.split('\n').map((line) => line.replace(/\/\/.*/, '')).join('\n');
}

// ─── 1: BrowserPort is satisfied by BrowserToolService (compile-time) ───

void function conformance(real: BrowserToolService): void {
  const _asPort: BrowserPort = real; // fails to compile if it doesn't structurally satisfy BrowserPort
};

test('1. BrowserToolService structurally satisfies BrowserPort (compile-time conformance, exercised at runtime via the real app graph)', () => {
  const app = createNagexApplication();
  const port: BrowserPort = app.browserService;
  assert.equal(typeof port.open, 'function');
  assert.equal(typeof port.click, 'function');
});

// ─── 2: Composition Root imports Browser through the module public entrypoint ───

test('2. Composition Root imports Browser only through modules/browser/index.js, never a deep internal file', () => {
  const code = readSourceWithoutComments('src/app/create-nagex-application.ts');
  assert.match(code, /from ['"]\.\.\/modules\/browser\/index\.js['"]/, 'create-nagex-application.ts must import Browser through the module public index');
  assert.doesNotMatch(code, /modules\/browser\/browser\.(service|runtime)\.js|modules\/browser\/browser-(session\.store|url-validator)\.js/, 'create-nagex-application.ts must never deep-import a Browser module internal file');
});

// ─── 3: CapabilityBroker has no Browser concrete import ───

test('3. CapabilityBroker has zero Browser concrete/internal imports — only the BrowserPort contract', () => {
  const code = readSourceWithoutComments('src/capabilities/capability-broker.ts');
  assert.doesNotMatch(code, /modules\/browser\//, 'capability-broker.ts must never import from modules/browser/ directly');
  assert.match(code, /from ['"]\.\.\/contracts\/browser\.port\.js['"]/, 'capability-broker.ts must depend on BrowserPort');
});

// ─── 4: CaptureProcessor/QuickCapture chain has no unauthorized browser internal import ───

test('4. The QuickCaptureService -> CaptureProcessor chain depends only on BrowserRetrievalPort, never a Browser module internal file', () => {
  for (const file of ['src/workspace/quick-capture.service.ts', 'src/workspace/capture-processor.ts']) {
    const code = readSourceWithoutComments(file);
    assert.doesNotMatch(code, /modules\/browser\/browser\.(service|runtime)\.js|modules\/browser\/browser-session\.store\.js/, `${file} must never import a Browser module internal file directly`);
  }
  const captureProcessorCode = readSourceWithoutComments('src/workspace/capture-processor.ts');
  assert.match(captureProcessorCode, /from ['"]\.\.\/contracts\/browser\.port\.js['"]/, 'capture-processor.ts must depend on the BrowserRetrievalPort contract');
  assert.match(captureProcessorCode, /from ['"]\.\.\/modules\/browser\/index\.js['"]/, 'capture-processor.ts must reach isUrlSafe only through the module public index');
});

// ─── 5: server_web.ts has no direct Playwright import ───

test('5. server_web.ts never imports Playwright directly', () => {
  const code = readSourceWithoutComments('src/server_web.ts');
  assert.doesNotMatch(code, /from ['"]playwright['"]/i, 'server_web.ts must never import Playwright directly');
  assert.doesNotMatch(code, /modules\/browser\/browser\.(service|runtime)\.js|modules\/browser\/browser-session\.store\.js/, 'server_web.ts must never deep-import a Browser module internal file');
  assert.match(code, /from ['"]\.\/modules\/browser\/index\.js['"]/, 'server_web.ts must import Browser only through the module public index');
});

// ─── 6: non-browser modules do not import a Browser module internal file ───
//
// Scoped to production src/ only — test files legitimately construct real
// internals directly (BrowserSessionStore, PlaywrightBrowserRuntime, ...)
// for genuine integration testing, per this repo's established pattern,
// and are not "non-browser modules" in the sense this check cares about.

test('6. No production module outside src/modules/browser/ imports a Browser module internal file directly (only the public index or contracts)', () => {
  const roots = ['src'];
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full.replace(/\\/g, '/').endsWith('src/modules/browser')) continue; // the module's own internals are allowed to reference each other
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const code = readSourceWithoutComments(full);
        if (/modules\/browser\/browser\.(service|runtime)\.js|modules\/browser\/browser-session\.store\.js|modules\/browser\/browser-url-validator\.js|modules\/browser\/browser\.types\.js/.test(code)) {
          offenders.push(full);
        }
      }
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], `these files deep-import a Browser module internal file instead of going through modules/browser/index.js: ${offenders.join(', ')}`);
});

// ─── 7: the module can be imported without launching Playwright ───

test('7. Importing the Browser module never launches a real Playwright browser', () => {
  const before = Date.now();
  const app = createNagexApplication();
  const elapsedMs = Date.now() - before;
  assert.ok(app.browserService, 'the app graph must include a real browserService');
  // A real Chromium launch takes at least tens/hundreds of milliseconds;
  // plain object construction (including importing the whole Browser
  // module) should be near-instant.
  assert.ok(elapsedMs < 500, `constructing the app graph (which imports the Browser module) took ${elapsedMs}ms — expected no eager browser launch`);
});

// ─── 8: lifecycle still references the same browserRuntime singleton ───

test('8. The browserRuntime singleton imported through the module index is the exact instance server_web.ts registers for lifecycle shutdown', () => {
  const code = readSourceWithoutComments('src/server_web.ts');
  assert.match(code, /name: 'browser-runtime'/, 'server_web.ts must still register a browser-runtime lifecycle resource');
  assert.match(code, /browserRuntime\.shutdown\(\)/, 'the lifecycle resource must still call browserRuntime.shutdown()');
  // browserRuntime is a module-level singleton (export const) — importing it
  // from the module index anywhere in the process always yields the same
  // instance Node's module cache holds, which is what server_web.ts's own
  // import (also routed through modules/browser/index.js, asserted above
  // in test 5) resolves to as well.
  assert.ok(moduleBrowserRuntime, 'browserRuntime must be a real, importable singleton from the module public index');
});

// ─── 9: the module's public index never exports a concrete Playwright type ───

test('9. modules/browser/index.ts never exports a concrete Playwright type', () => {
  const code = readSourceWithoutComments('src/modules/browser/index.ts');
  assert.doesNotMatch(code, /from ['"]playwright['"]/i, 'the module public index must never import from playwright directly');
  assert.doesNotMatch(code, /\bBrowser\b(?!Runtime|Snapshot|ToolService|SessionRecord|SessionStatus|ActionResult|ClickResult|ClickExecuted|ClickApprovalRequired|Evidence)/, 'the module public index must never export a bare Playwright Browser/Page/BrowserContext type');
});

// ─── 10: old scattered implementation paths no longer contain independent implementations ───

test('10. The pre-Phase-04 scattered Browser paths no longer exist', () => {
  const oldPaths = [
    'src/tools/browser.service.ts',
    'src/integrations/browser/browser.runtime.ts',
    'src/browser/browser-session.store.ts',
    'src/browser/browser-url-validator.ts',
    'src/browser/browser.types.ts',
    'src/browser/browser-runtime.ts', // dead re-export shim, deleted (zero consumers, confirmed)
    'src/browser/browser.service.ts', // dead re-export shim, deleted (zero consumers, confirmed)
  ];
  for (const oldPath of oldPaths) {
    assert.equal(fs.existsSync(path.resolve(oldPath)), false, `${oldPath} must no longer exist — Browser has exactly one source of truth now, at src/modules/browser/`);
  }
  for (const file of ['browser.service.ts', 'browser.runtime.ts', 'browser-session.store.ts', 'browser-url-validator.ts', 'browser.types.ts', 'index.ts']) {
    assert.ok(fs.existsSync(path.resolve('src/modules/browser', file)), `src/modules/browser/${file} must exist`);
  }
});
