// R10.2-E — Canonical test entry point guard.
//
// The ONLY certified way to run this suite is `npm test`, which runs
// `tsc && node --require ./dist/tests/_setup.js --test dist/tests/*.test.js`.
// _setup.js redirects ~20 NAGEX_*_DIR environment variables to a fresh
// os.tmpdir() location before any test file (or server_web.ts, which
// constructs file-backed singletons at module load) runs. Without it,
// stores default to /var/lib/nagex (or a real user data dir), so a bare
// `node --test dist/tests/some.test.js` — run once during R10.2-D's
// development to investigate a suspected flake — was found to silently
// accumulate real, cross-invocation state in a real-looking directory,
// producing a false "this test is flaky" signal that was actually
// setup-bypass contamination, not a real defect. That is why bare
// `node --test` output must never be cited as certification evidence
// (see AGENTS.md / CLAUDE.md's "Required Checks Before Completion").
//
// This file is the automated version of that rule: since Node's test
// runner spawns one process per matched file (verified empirically — each
// file sees a distinct process.pid), _setup.js runs fresh in every test
// file's process when `--require` is honored, and never runs at all when
// it is not. If a NAGEX_*_DIR variable is unset or does not point inside
// os.tmpdir(), this test fails immediately and explains why, rather than
// letting some other, unrelated test fail confusingly downstream from
// silently writing into a real directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const REQUIRED_ISOLATION_VARS = [
  'NAGEX_APPROVALS_DIR',
  'NAGEX_EXECUTIONS_DIR',
  'NAGEX_SESSIONS_DIR',
  'NAGEX_TASKS_DIR',
  'NAGEX_TASK_RUNS_DIR',
  'NAGEX_MEMORIES_DIR',
  'NAGEX_CONVERSATIONS_DIR',
  'NAGEX_MODULE_STATE_DIR',
  'NAGEX_WORKFLOW_DEFINITIONS_DIR',
  'NAGEX_ENTERPRISE_IDENTITY_DIR',
  'NAGEX_SSO_FLOW_DIR',
  'NAGEX_IDENTITY_DIR',
  'NAGEX_IDENTITY_TOKENS_DIR',
  'NAGEX_IDENTITY_AUDIT_DIR',
  'NAGEX_ORGANIZATION_DIR',
] as const;

test('SETUP-CANARY: this process was started with --require ./dist/tests/_setup.js (the only certified test entry point)', () => {
  const tmpRoot = path.resolve(os.tmpdir());
  const missing: string[] = [];
  const outsideTmp: string[] = [];

  for (const name of REQUIRED_ISOLATION_VARS) {
    const value = process.env[name];
    if (!value) {
      missing.push(name);
      continue;
    }
    if (!path.resolve(value).startsWith(tmpRoot)) {
      outsideTmp.push(`${name}=${value}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `These isolation env vars are unset, meaning _setup.js never ran. ` +
    `This process was almost certainly started with a bare 'node --test ...' instead of ` +
    `'npm test' (which runs 'node --require ./dist/tests/_setup.js --test ...'). ` +
    `Bare node --test results must never be used as certification evidence — ` +
    `re-run with 'npm test'. Missing: ${missing.join(', ')}`,
  );
  assert.deepEqual(
    outsideTmp,
    [],
    `These isolation env vars are set but do NOT point inside the OS temp directory, ` +
    `meaning something overrode _setup.js's redirection after the fact: ${outsideTmp.join(', ')}`,
  );
});
