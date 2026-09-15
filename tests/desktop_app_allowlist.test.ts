// DC3-B2 Production — DesktopAppAllowlist. The model must never provide
// a trusted executable path; only a canonical appId, resolved locally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DesktopAppAllowlist } from '../src/device-agent/desktop-app-allowlist.js';

test('DESKTOP_ALLOWLISTED_APP_RESOLVES: a known appId resolves to a real local executable path', () => {
  const allowlist = new DesktopAppAllowlist();
  const result = allowlist.resolve('NAGEX_TEST_HARNESS');
  assert.equal(result.status, 'RESOLVED');
  if (result.status === 'RESOLVED') {
    assert.ok(result.executablePath.endsWith('.exe'));
    assert.ok(!result.executablePath.includes('..'), 'resolved path must not contain traversal segments');
  }
});

test('DESKTOP_UNKNOWN_APP_BLOCKED: an unrecognized appId is APP_NOT_ALLOWED, never a best-effort guess', () => {
  const allowlist = new DesktopAppAllowlist();
  const result = allowlist.resolve('SOME_RANDOM_APP');
  assert.equal(result.status, 'APP_NOT_ALLOWED');
});

test('DESKTOP_ARBITRARY_PATH_BLOCKED: a raw filesystem path is never itself treated as a valid appId', () => {
  const allowlist = new DesktopAppAllowlist();
  const result = allowlist.resolve('C:\\Windows\\System32\\cmd.exe');
  assert.equal(result.status, 'APP_NOT_ALLOWED');
});

test('empty/malformed appId values are rejected the same as any unknown one', () => {
  const allowlist = new DesktopAppAllowlist();
  for (const bad of ['', ' ', 'nagex_test_harness', 'NAGEX_TEST_HARNESS ']) {
    assert.equal(allowlist.resolve(bad).status, 'APP_NOT_ALLOWED', `expected "${bad}" to be blocked`);
  }
});
