// Phase 07 — Architecture Enforcement.
//
// A global, source-level scanner that fails automatically if any file in
// src/** violates one of the module/contract/task boundaries established by
// Phases 03-06. This does not replace the existing specialized boundary
// tests (module_contracts, browser_module_boundary, google_modules_boundary,
// task_orchestration_boundary) — those remain the deep, behavior-aware
// coverage for their specific subsystems. This file is the coarse tripwire
// that catches a NEW violation anywhere in the tree, including in files
// none of those specialized tests know to look at.
//
// Design: every rule is a pure function over an in-memory list of
// {relPath, content} records, so the exact same rule logic can be run
// against (a) the real src/ tree (proving the current codebase is clean)
// and (b) small synthetic fixtures (proving each rule actually detects a
// representative violation, not just passing vacuously). No subprocess
// spawning, no network, no filesystem writes — read-only, in-process,
// single tree walk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ─── Source loading + import extraction ────────────────────────────────────

interface SourceFile {
  relPath: string; // posix-normalized, relative to repo root, e.g. "src/tasks/task.runner.ts"
  content: string; // original (with comments) — used for line-number lookup
  stripped: string; // comment-stripped — used for pattern matching
}

interface ParsedImport {
  specifier: string;
  isTypeOnly: boolean;
  line: number; // 1-indexed, matches the original file
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

function stripLineComments(source: string): string {
  // Matches the comment-stripping technique already established in
  // module_contracts.test.ts / browser_module_boundary.test.ts /
  // google_modules_boundary.test.ts / task_orchestration_boundary.test.ts —
  // reused rather than reinvented, per this repo's own precedent.
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*/, ''))
    .join('\n');
}

function loadSourceTree(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const relPath = toPosix(path.relative(process.cwd(), full));
        const content = fs.readFileSync(full, 'utf8');
        files.push({ relPath, content, stripped: stripLineComments(content) });
      }
    }
  };
  walk(root);
  return files;
}

// Recognizes `import ... from '...'`, `import type ... from '...'`,
// `export ... from '...'`, `export type ... from '...'`, bare side-effect
// `import '...'`, and dynamic `import('...')`. Operates on comment-stripped
// content so a banned term inside a doc comment can never produce a false
// positive (this repo has real examples: the port files' own "Mirrors
// modules/x/y.ts's shape" comments).
function extractImports(stripped: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const lineOf = (index: number): number => stripped.slice(0, index).split('\n').length;

  const fromRe = /(^|\n)[ \t]*(import|export)\s+(type\s+)?[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(stripped))) {
    // m.index points at the leading `^`/`\n` the first capture group
    // consumed, not at the "import"/"export" keyword itself — add back
    // that group's length so the reported line matches where the keyword
    // actually starts, not the end of the previous line.
    imports.push({ specifier: m[4], isTypeOnly: Boolean(m[3]), line: lineOf(m.index + m[1].length) });
  }

  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(stripped))) {
    imports.push({ specifier: m[1], isTypeOnly: false, line: lineOf(m.index) });
  }

  const bareRe = /(^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g;
  while ((m = bareRe.exec(stripped))) {
    imports.push({ specifier: m[1], isTypeOnly: false, line: lineOf(m.index + m[1].length) });
  }

  return imports;
}

// Resolves a relative import specifier against the importing file's own
// directory into a posix, extension-stripped, src-relative path — e.g.
// ("src/tasks/task.runner.ts", "../modules/browser/index.js") ->
// "src/modules/browser/index".
function resolveSpecifier(importerRelPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null; // bare package specifier — not a repo-internal path
  const dir = path.posix.dirname(importerRelPath);
  const resolved = path.posix.normalize(path.posix.join(dir, specifier));
  return resolved.replace(/\.js$/, '');
}

interface Violation {
  rule: string;
  file: string;
  line: number;
  importPath: string;
  expected: string;
}

function formatViolation(v: Violation): string {
  return `${v.rule} — ${v.file}:${v.line} imports "${v.importPath}"\nExpected: ${v.expected}`;
}

// ─── Rule implementations (each: SourceFile[] -> Violation[]) ─────────────

function discoverModuleNames(files: SourceFile[]): string[] {
  const names = new Set<string>();
  for (const f of files) {
    const m = /^src\/modules\/([^/]+)\//.exec(f.relPath);
    if (m) names.add(m[1]);
  }
  return [...names];
}

// ARCH-001 — Contracts Purity. src/contracts/**.ts may only import: stable
// domain/governance types, common errors/types, other contracts, and
// TYPE-ONLY imports from a module's own index.ts (the module's declared
// public surface — e.g. browser.port.ts's `import type { BrowserSessionRecord,
// ... } from '../modules/browser/index.js'`, a deliberate Phase 04 pattern,
// not a concrete-implementation coupling since it is erased at compile time).
// Never: a module's internal file, integrations/**, server_web.ts,
// create-nagex-application.ts, playwright, oauth/token-store, or a VALUE
// import from a module's index.
function ruleContractsPurity(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith('src/contracts/')) continue;
    for (const imp of extractImports(f.stripped)) {
      if (/playwright/i.test(imp.specifier)) {
        violations.push({ rule: 'ARCH-001', file: f.relPath, line: imp.line, importPath: imp.specifier, expected: 'contracts must never import Playwright' });
        continue;
      }
      if (/oauth|token\.store|token\.crypto/i.test(imp.specifier)) {
        violations.push({ rule: 'ARCH-001', file: f.relPath, line: imp.line, importPath: imp.specifier, expected: 'contracts must never import OAuth/token-store internals' });
        continue;
      }
      const resolved = resolveSpecifier(f.relPath, imp.specifier);
      if (!resolved) continue;
      if (resolved.startsWith('src/integrations/')) {
        violations.push({ rule: 'ARCH-001', file: f.relPath, line: imp.line, importPath: imp.specifier, expected: 'contracts must never import from src/integrations/' });
      } else if (resolved === 'src/server_web' || resolved === 'src/app/create-nagex-application') {
        violations.push({ rule: 'ARCH-001', file: f.relPath, line: imp.line, importPath: imp.specifier, expected: 'contracts must never import server_web.ts or the Composition Root' });
      } else if (/^src\/modules\/[^/]+\//.test(resolved)) {
        const isOwnIndex = /^src\/modules\/[^/]+\/index$/.test(resolved);
        if (!isOwnIndex) {
          violations.push({ rule: 'ARCH-001', file: f.relPath, line: imp.line, importPath: imp.specifier, expected: 'contracts must never deep-import a module internal file — only "modules/<name>/index.js"' });
        } else if (!imp.isTypeOnly) {
          violations.push({ rule: 'ARCH-001', file: f.relPath, line: imp.line, importPath: imp.specifier, expected: 'contracts may only take a `import type` from a module index, never a value import' });
        }
      }
    }
  }
  return violations;
}

// ARCH-006 — Module Deep Import Ban (general, module-name-agnostic). Any
// file outside src/modules/<name>/ must not import src/modules/<name>/
// <internal file>; only src/modules/<name>/index(.js) may be imported.
// Files inside src/modules/<name>/ may freely import each other.
function ruleModuleDeepImportBan(files: SourceFile[], moduleNames: string[]): Violation[] {
  const violations: Violation[] = [];
  for (const f of files) {
    for (const name of moduleNames) {
      if (f.relPath.startsWith(`src/modules/${name}/`)) continue; // the module's own internals may reference each other
      for (const imp of extractImports(f.stripped)) {
        const resolved = resolveSpecifier(f.relPath, imp.specifier);
        if (!resolved) continue;
        if (resolved.startsWith(`src/modules/${name}/`) && resolved !== `src/modules/${name}/index`) {
          violations.push({
            rule: 'ARCH-006',
            file: f.relPath,
            line: imp.line,
            importPath: imp.specifier,
            expected: `only "src/modules/${name}/index.js" or "src/contracts/${name}.port.ts" may be imported from outside the module`,
          });
        }
      }
    }
  }
  return violations;
}

// ARCH-005 — Task External Capability Boundary. src/tasks/** must never
// import ANYTHING from src/modules/{browser,gmail,calendar}/** (not even
// the public index — stricter than ARCH-006) or src/integrations/google/**,
// or Playwright. External capability access must flow exclusively through
// CapabilityExecutorPort (src/contracts/capability.port.ts) — the current
// ConditionalWatchTaskRunner pattern is canonical.
function ruleTaskCapabilityBoundary(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith('src/tasks/')) continue;
    for (const imp of extractImports(f.stripped)) {
      if (/playwright/i.test(imp.specifier)) {
        violations.push({ rule: 'ARCH-005', file: f.relPath, line: imp.line, importPath: imp.specifier, expected: 'Task code must never import Playwright — use CapabilityExecutorPort' });
        continue;
      }
      const resolved = resolveSpecifier(f.relPath, imp.specifier);
      if (!resolved) continue;
      if (/^src\/modules\/(browser|gmail|calendar)\//.test(resolved) || resolved.startsWith('src/integrations/google/')) {
        violations.push({ rule: 'ARCH-005', file: f.relPath, line: imp.line, importPath: imp.specifier, expected: 'Task code must reach Browser/Gmail/Calendar only through CapabilityExecutorPort, never a module import' });
      }
    }
  }
  return violations;
}

// ARCH-007 — server_web.ts Infrastructure Boundary. server_web.ts must
// never import Playwright directly or deep-import a module internal file
// (Gmail/Calendar client internals included). Allowed: module public
// indexes, contracts, the Composition Root/application object, and the
// shared Google OAuth route infrastructure (oauth.client/token.store) this
// architecture's routes genuinely need.
function ruleServerWebBoundary(files: SourceFile[], moduleNames: string[]): Violation[] {
  const violations: Violation[] = [];
  const serverWeb = files.find((f) => f.relPath === 'src/server_web.ts');
  if (!serverWeb) return violations;
  for (const imp of extractImports(serverWeb.stripped)) {
    if (/playwright/i.test(imp.specifier)) {
      violations.push({ rule: 'ARCH-007', file: serverWeb.relPath, line: imp.line, importPath: imp.specifier, expected: 'server_web.ts must never import Playwright directly' });
      continue;
    }
    const resolved = resolveSpecifier(serverWeb.relPath, imp.specifier);
    if (!resolved) continue;
    for (const name of moduleNames) {
      if (resolved.startsWith(`src/modules/${name}/`) && resolved !== `src/modules/${name}/index`) {
        violations.push({ rule: 'ARCH-007', file: serverWeb.relPath, line: imp.line, importPath: imp.specifier, expected: `server_web.ts must import ${name} only through src/modules/${name}/index.js` });
      }
    }
  }
  return violations;
}

// ARCH-008 — Composition Root Ownership. Every class that is a field type
// on NagexApplication (the full application graph) may only be constructed
// (`new ClassName(`) inside src/app/create-nagex-application.ts, with two
// evidence-based, named exceptions: browserRuntime (a pre-existing,
// Phase-01-documented module-owned singleton) and server_web.ts's one
// ephemeral, request-scoped TaskScheduler/CompositeTaskRunner pair (used
// only to support injecting an alternate model in a test, never a
// persistent singleton). The ExecutionStore-as-default-parameter pattern in
// the three service files is a structural exception (a default parameter
// value, not a module-level singleton), matched by pattern rather than file
// allowlist so it stays valid if those files move again.
const APPLICATION_GRAPH_CLASSES = [
  'PolicyDecisionPoint', 'DurableRuntimeEngine', 'AuditLogger', 'BillingLedgerEngine', 'CreditEngine',
  'MemoryEngine', 'AiService', 'PlanResolver', 'PersistentActionApprovalStore', 'ExecutionStore',
  'GoogleCalendarService', 'GmailService', 'BrowserToolService', 'CapabilityBroker', 'SessionStore',
  'ConversationStore', 'ConversationContextService', 'TaskStore', 'TaskRunStore', 'CompositeTaskRunner',
  'TaskScheduler', 'TelegramIdentityStore', 'TelegramBotClient', 'TelegramService', 'SlackIdentityStore',
  'SlackClient', 'SlackService', 'DesktopRuntimeEngine', 'NotificationStore', 'NotificationEngine',
  'KnowledgeEngine', 'CandidateStore', 'ActivityStore', 'CandidateActionResolver', 'QuickCaptureService',
  'InputRouter', 'LifecycleManager',
  // Phase 09 — P02/P03 added these 5 real NagexApplication fields without
  // ever adding them here; Composition-Root-only construction was silently
  // unenforced for the whole Task continuation/durable-runtime subsystem.
  'ExecutingTaskRunner', 'TaskContinuationStore', 'TaskContinuationCoordinator',
  'DurableTaskRunStateStore', 'DurableTaskRuntime',
];

const COMPOSITION_ROOT_PATH = 'src/app/create-nagex-application.ts';
const ARCH_008_FILE_ALLOWLIST = new Set<string>([
  'src/modules/browser/browser.runtime.ts', // pre-existing module-owned browserRuntime singleton (Phase 01)
  'src/server_web.ts', // ephemeral TaskScheduler/CompositeTaskRunner for alt-model test injection only
]);

function ruleCompositionRootOwnership(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const f of files) {
    if (f.relPath === COMPOSITION_ROOT_PATH) continue;
    if (ARCH_008_FILE_ALLOWLIST.has(f.relPath)) continue;
    for (const cls of APPLICATION_GRAPH_CLASSES) {
      // `= new ExecutionStore()` as a constructor default parameter value is
      // a structural exception — the directive itself names it (Section 17).
      const defaultParamRe = new RegExp(`ExecutionStore\\s*=\\s*new\\s+ExecutionStore\\s*\\(`, 'g');
      const ctorRe = new RegExp(`\\bnew\\s+${cls}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = ctorRe.exec(f.stripped))) {
        if (cls === 'ExecutionStore' && defaultParamRe.test(f.stripped)) continue;
        const line = f.stripped.slice(0, m.index).split('\n').length;
        violations.push({ rule: 'ARCH-008', file: f.relPath, line, importPath: `new ${cls}(`, expected: `production construction of ${cls} belongs only in ${COMPOSITION_ROOT_PATH}` });
      }
    }
  }
  return violations;
}

// ARCH-009 — Lifecycle Ownership. The specific shutdown calls that own the
// process-lifetime resources LifecycleManager tracks (browserRuntime,
// the scheduler interval, the HTTP server) may only appear in
// src/server_web.ts, the sole production entrypoint that registers them.
function ruleLifecycleOwnership(files: SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  const patterns: Array<{ re: RegExp; label: string }> = [
    { re: /browserRuntime\.shutdown\s*\(/g, label: 'browserRuntime.shutdown(' },
    { re: /clearInterval\s*\(\s*schedulerIntervalHandle\s*\)/g, label: 'clearInterval(schedulerIntervalHandle)' },
    { re: /serverInstance\.close\s*\(/g, label: 'serverInstance.close(' },
  ];
  for (const f of files) {
    if (f.relPath === 'src/server_web.ts') continue;
    for (const { re, label } of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(f.stripped))) {
        const line = f.stripped.slice(0, m.index).split('\n').length;
        violations.push({ rule: 'ARCH-009', file: f.relPath, line, importPath: label, expected: 'lifecycle-owned resource shutdown belongs only in src/server_web.ts\'s LifecycleManager registration' });
      }
    }
  }
  return violations;
}

// ─── Load the real tree once (shared by all positive tests) ───────────────

const SRC_ROOT = 'src';
const REAL_FILES = loadSourceTree(SRC_ROOT);
const REAL_MODULE_NAMES = discoverModuleNames(REAL_FILES);

// ─── Positive tests: the real, current codebase must be clean ─────────────

test('ARCH-001: no file under src/contracts/ violates contracts purity', () => {
  const violations = ruleContractsPurity(REAL_FILES);
  assert.deepEqual(violations, [], violations.map(formatViolation).join('\n\n'));
});

test('ARCH-002/003/004/006: no file outside a module\'s own directory deep-imports that module\'s internal files', () => {
  assert.ok(REAL_MODULE_NAMES.length >= 3, `expected to discover at least the browser/gmail/calendar modules, found: ${REAL_MODULE_NAMES.join(', ')}`);
  const violations = ruleModuleDeepImportBan(REAL_FILES, REAL_MODULE_NAMES);
  assert.deepEqual(violations, [], violations.map(formatViolation).join('\n\n'));
});

test('ARCH-005: no file under src/tasks/ imports Browser/Gmail/Calendar or Playwright directly', () => {
  const violations = ruleTaskCapabilityBoundary(REAL_FILES);
  assert.deepEqual(violations, [], violations.map(formatViolation).join('\n\n'));
});

test('ARCH-007: server_web.ts never imports Playwright or a module internal file directly', () => {
  const violations = ruleServerWebBoundary(REAL_FILES, REAL_MODULE_NAMES);
  assert.deepEqual(violations, [], violations.map(formatViolation).join('\n\n'));
});

test('ARCH-008: every application-graph class is constructed only in the Composition Root (plus the 2 named, evidence-based exceptions)', () => {
  const violations = ruleCompositionRootOwnership(REAL_FILES);
  assert.deepEqual(violations, [], violations.map(formatViolation).join('\n\n'));
});

test('ARCH-009: lifecycle-owned resource shutdown calls appear only in server_web.ts', () => {
  const violations = ruleLifecycleOwnership(REAL_FILES);
  assert.deepEqual(violations, [], violations.map(formatViolation).join('\n\n'));
});

test('performance: scanning the full src/ tree for every rule completes well under 2 seconds', () => {
  const before = Date.now();
  ruleContractsPurity(REAL_FILES);
  ruleModuleDeepImportBan(REAL_FILES, REAL_MODULE_NAMES);
  ruleTaskCapabilityBoundary(REAL_FILES);
  ruleServerWebBoundary(REAL_FILES, REAL_MODULE_NAMES);
  ruleCompositionRootOwnership(REAL_FILES);
  ruleLifecycleOwnership(REAL_FILES);
  const elapsedMs = Date.now() - before;
  assert.ok(elapsedMs < 2000, `full-tree scan across all 6 rules took ${elapsedMs}ms — expected under 2000ms`);
});

// ─── Negative tests: synthetic fixtures proving each rule actually fires ──
//
// Each fixture is a small in-memory {relPath, content} — never written to
// disk — deliberately shaped to violate exactly one rule, so a rule that
// silently stopped checking anything (e.g. a regex typo) would be caught
// here even though the real tree stayed clean.

function fixture(relPath: string, content: string): SourceFile {
  return { relPath, content, stripped: stripLineComments(content) };
}

test('negative: ARCH-001 fires on a contract deep-importing a module internal file', () => {
  const files = [fixture('src/contracts/fake.port.ts', `import { BrowserToolService } from '../modules/browser/browser.service.js';\n`)];
  const violations = ruleContractsPurity(files);
  assert.equal(violations.length, 1, 'a contract deep-importing a module internal file must be flagged');
  assert.equal(violations[0].rule, 'ARCH-001');
});

test('negative: ARCH-001 fires on a contract importing Playwright', () => {
  const files = [fixture('src/contracts/fake.port.ts', `import type { Page } from 'playwright';\n`)];
  const violations = ruleContractsPurity(files);
  assert.equal(violations.length, 1);
});

test('negative: ARCH-001 fires on a contract taking a VALUE (not type-only) import from a module index', () => {
  const files = [fixture('src/contracts/fake.port.ts', `import { BrowserToolService } from '../modules/browser/index.js';\n`)];
  const violations = ruleContractsPurity(files);
  assert.equal(violations.length, 1, 'a value import from a module index must still be flagged — only `import type` is allowed');
});

test('negative: ARCH-001 does NOT fire on a type-only import from a module index (the real, authorized browser.port.ts pattern)', () => {
  const files = [fixture('src/contracts/fake.port.ts', `import type { BrowserSessionRecord } from '../modules/browser/index.js';\n`)];
  const violations = ruleContractsPurity(files);
  assert.deepEqual(violations, []);
});

test('negative: ARCH-002/006 fires on a Workspace file deep-importing Browser internals', () => {
  const files = [
    fixture('src/modules/browser/browser.service.ts', 'export class BrowserToolService {}\n'),
    fixture('src/workspace/fake.ts', `import { BrowserToolService } from '../modules/browser/browser.service.js';\n`),
  ];
  const violations = ruleModuleDeepImportBan(files, ['browser']);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'ARCH-006');
});

test('negative: ARCH-002/006 does NOT fire on a Workspace file importing the module index', () => {
  const files = [fixture('src/workspace/fake.ts', `import { BrowserToolService } from '../modules/browser/index.js';\n`)];
  const violations = ruleModuleDeepImportBan(files, ['browser']);
  assert.deepEqual(violations, []);
});

test('negative: ARCH-005 fires on a Task file importing Browser concrete service directly', () => {
  const files = [fixture('src/tasks/runners/fake.runner.ts', `import { BrowserToolService } from '../../modules/browser/index.js';\n`)];
  const violations = ruleTaskCapabilityBoundary(files);
  assert.equal(violations.length, 1, 'Task code importing even the Browser module index (not just internals) must be flagged — stricter than the general module boundary');
});

test('negative: ARCH-005 fires on a Task file importing Playwright directly', () => {
  const files = [fixture('src/tasks/runners/fake.runner.ts', `import type { Page } from 'playwright';\n`)];
  const violations = ruleTaskCapabilityBoundary(files);
  assert.equal(violations.length, 1);
});

test('negative: ARCH-007 fires on server_web.ts deep-importing a Calendar internal file', () => {
  const files = [fixture('src/server_web.ts', `import { GoogleCalendarService } from './modules/calendar/google-calendar.service.js';\n`)];
  const violations = ruleServerWebBoundary(files, ['calendar']);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'ARCH-007');
});

test('negative: ARCH-008 fires on a production singleton constructed outside the Composition Root', () => {
  const files = [fixture('src/workspace/fake.ts', `const rogue = new MemoryEngine();\n`)];
  const violations = ruleCompositionRootOwnership(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'ARCH-008');
});

test('negative: ARCH-008 fires on a P02/P03 Task Runtime class (DurableTaskRunStateStore) constructed outside the Composition Root', () => {
  const files = [fixture('src/workspace/fake.ts', `const rogue = new DurableTaskRunStateStore();\n`)];
  const violations = ruleCompositionRootOwnership(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'ARCH-008');
});

test('negative: ARCH-008 does NOT fire on the ExecutionStore default-parameter exception', () => {
  const files = [fixture('src/modules/gmail/gmail.service.ts', `constructor(private readonly executions: ExecutionStore = new ExecutionStore()) {}\n`)];
  const violations = ruleCompositionRootOwnership(files);
  assert.deepEqual(violations, []);
});

test('negative: ARCH-009 fires on a lifecycle shutdown call outside server_web.ts', () => {
  const files = [fixture('src/workspace/fake.ts', `await browserRuntime.shutdown();\n`)];
  const violations = ruleLifecycleOwnership(files);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, 'ARCH-009');
});

test('violation message format includes file, line, violated rule, and expected boundary', () => {
  const files = [fixture('src/contracts/fake.port.ts', `\n\nimport { BrowserToolService } from '../modules/browser/browser.service.js';\n`)];
  const violations = ruleContractsPurity(files);
  assert.equal(violations.length, 1);
  const [v] = violations;
  assert.equal(v.rule, 'ARCH-001');
  assert.equal(v.file, 'src/contracts/fake.port.ts');
  assert.equal(v.line, 3);
  assert.ok(v.importPath.includes('modules/browser/browser.service.js'));
  assert.ok(v.expected.length > 0);
  const formatted = formatViolation(v);
  assert.match(formatted, /ARCH-001/);
  assert.match(formatted, /fake\.port\.ts:3/);
});
