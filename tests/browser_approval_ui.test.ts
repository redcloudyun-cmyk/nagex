import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { hashCanonicalPayload, type ActionApprovalRecord } from '../src/governance/action-approval.store.js';
import { BROWSER_CLICK_TOOL_ID } from '../src/modules/browser/browser.service.js';
import { server } from '../src/server_web.js';

// public/browser-approval-view.js is a dependency-free browser script (IIFE),
// loaded the same way tests/gmail_approval_ui.test.ts loads
// gmail-approval-view.js: run its real source in a vm sandbox so we exercise
// the actual logic, not a re-implementation of it.
function loadBrowserApprovalView(): {
  STATUS_LABEL: Record<string, string>;
  buildPayloadFields: (payload: unknown) => { targetText: string; selector: string; url: string; browserSessionId: string };
  isExpired: (expiresAt: string, nowMs?: number) => boolean;
  formatCountdown: (msRemaining: number) => string;
  buildCardViewModel: (approval: unknown, nowMs?: number) => {
    fields: ReturnType<ReturnType<typeof loadBrowserApprovalView>['buildPayloadFields']>;
    status: string;
    statusLabel: string;
    approveDisabled: boolean;
    rejectDisabled: boolean;
    countdownLabel: string | null;
  };
  buildSuccessViewModel: (payload: unknown, result: unknown) => { targetText: string; url: string; title: string; executionId: string };
  describeExecutionError: (code: string | undefined) => string | null;
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'browser-approval-view.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'browser-approval-view.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_BROWSER_APPROVAL_VIEW as ReturnType<typeof loadBrowserApprovalView>;
}

const view = loadBrowserApprovalView();

function validPayload(overrides: Record<string, unknown> = {}) {
  return { browserSessionId: 'brw_test_1', selector: '#delete-btn', targetText: 'Delete Account', url: 'https://example.com/account', ...overrides };
}

function approvalRecordFor(status: ActionApprovalRecord['status'], overrides: Partial<ActionApprovalRecord> = {}): ActionApprovalRecord {
  const payload = (overrides.canonicalPayload as Record<string, unknown> | undefined) ?? validPayload();
  return {
    approvalId: 'apr_test_browser_1',
    toolId: BROWSER_CLICK_TOOL_ID,
    tenantId: 'ten_test',
    principalId: 'usr_test',
    canonicalPayload: payload,
    payloadHash: hashCanonicalPayload(payload),
    status,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    approvedAt: null,
    rejectedAt: null,
    usedAt: null,
    executionId: null,
    ...overrides,
  };
}

test('approval card renders the exact frozen target — text, selector, url, session', () => {
  const fields = view.buildPayloadFields(validPayload());
  assert.equal(fields.targetText, 'Delete Account');
  assert.equal(fields.selector, '#delete-btn');
  assert.equal(fields.url, 'https://example.com/account');
  assert.equal(fields.browserSessionId, 'brw_test_1');
});

test('a pending, unexpired approval shows "Pending approval" with both buttons enabled', () => {
  const record = approvalRecordFor('PENDING');
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.status, 'PENDING');
  assert.equal(vmView.statusLabel, 'Pending approval');
  assert.equal(vmView.approveDisabled, false);
  assert.equal(vmView.rejectDisabled, false);
});

test('expired approval disables both actions', () => {
  const record = approvalRecordFor('PENDING', { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.status, 'EXPIRED');
  assert.equal(vmView.approveDisabled, true);
  assert.equal(vmView.rejectDisabled, true);
});

test('a consumed approval is never actionable again', () => {
  const record = approvalRecordFor('CONSUMED', { usedAt: new Date().toISOString(), executionId: 'exe_1' });
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.approveDisabled, true);
  assert.equal(vmView.rejectDisabled, true);
});

test('successful execution view model surfaces the real target text, resulting url/title, and executionId', () => {
  const successVm = view.buildSuccessViewModel(validPayload(), { executionId: 'exe_abc', url: 'https://example.com/account/deleted', title: 'Account Deleted' });
  assert.equal(successVm.targetText, 'Delete Account');
  assert.equal(successVm.url, 'https://example.com/account/deleted');
  assert.equal(successVm.title, 'Account Deleted');
  assert.equal(successVm.executionId, 'exe_abc');
});

test('error codes specific to browser actions map to clear messages', () => {
  assert.equal(view.describeExecutionError('BROWSER_SELECTOR_NOT_FOUND'), 'That element is no longer on the page.');
  assert.equal(view.describeExecutionError('BROWSER_HUMAN_VERIFICATION_REQUIRED'), 'This page requires human verification (CAPTCHA/MFA). NAgex will not attempt to bypass it.');
  assert.equal(view.describeExecutionError('APPROVAL_ALREADY_CONSUMED'), 'This approval has already been used.');
  assert.equal(view.describeExecutionError('UNKNOWN_CODE'), null);
});

test('the app serves browser-approval-view.js, no-cache', async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const origin = `http://127.0.0.1:${port}`;
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /src="browser-approval-view\.js\?v=/);
    const res = await fetch(`${origin}/browser-approval-view.js`);
    const body = await res.text();
    assert.equal(body.length > 0, true);
    assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
