import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { hashCanonicalPayload, type ActionApprovalRecord } from '../src/governance/action-approval.store.js';
import { GMAIL_SEND_EMAIL_TOOL_ID, GMAIL_REPLY_TOOL_ID, GMAIL_CREATE_DRAFT_TOOL_ID } from '../src/tools/gmail.service.js';

// public/gmail-approval-view.js is a dependency-free browser script (IIFE),
// loaded the same way tests/calendar_approval_ui.test.ts loads
// calendar-approval-view.js: run its real source in a vm sandbox so we
// exercise the actual logic the approval card would use to render, not a
// re-implementation of it.
function loadGmailApprovalView(): {
  STATUS_LABEL: Record<string, string>;
  buildPayloadFields: (payload: unknown) => {
    from: string;
    to: string[];
    cc: string[];
    bcc: string[];
    subject: string;
    body: string;
    attachments: Array<{ filename: string; mimeType: string; sizeBytes: number }>;
    threadId: string | null;
    replyToMessageId: string | null;
    isReply: boolean;
  };
  isExpired: (expiresAt: string, nowMs?: number) => boolean;
  formatCountdown: (msRemaining: number) => string;
  buildCardViewModel: (approval: unknown, nowMs?: number) => {
    fields: ReturnType<ReturnType<typeof loadGmailApprovalView>['buildPayloadFields']>;
    status: string;
    statusLabel: string;
    approveActionLabel: string;
    approveDisabled: boolean;
    rejectDisabled: boolean;
    countdownLabel: string | null;
  };
  buildSuccessViewModel: (toolId: string, payload: unknown, result: unknown) => {
    toolId: string;
    to: string[];
    subject: string;
    executionId: string;
    messageId: string;
    threadId: string | null;
    externalUrl: string;
  };
  describeExecutionError: (code: string | undefined) => string | null;
} {
  const source = fs.readFileSync(path.join(process.cwd(), 'public', 'gmail-approval-view.js'), 'utf8');
  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'gmail-approval-view.js' });
  return (sandbox.window as Record<string, unknown>).NAGEX_GMAIL_APPROVAL_VIEW as ReturnType<typeof loadGmailApprovalView>;
}

const view = loadGmailApprovalView();

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    from: 'me',
    to: ['client@example.com'],
    cc: [],
    bcc: [],
    subject: 'Quarterly Update',
    body: 'Here is the update we discussed.',
    attachments: [],
    threadId: null,
    replyToMessageId: null,
    ...overrides,
  };
}

function approvalRecordFor(toolId: string, status: ActionApprovalRecord['status'], overrides: Partial<ActionApprovalRecord> = {}): ActionApprovalRecord {
  const payload = (overrides.canonicalPayload as Record<string, unknown> | undefined) ?? validPayload();
  return {
    approvalId: 'apr_test_gmail_1',
    toolId,
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

// ── Pure view-model logic ────────────────────────────────────────────────

test('approval card renders the exact frozen payload fields, unmodified — recipients, subject, body, attachments', () => {
  const fields = view.buildPayloadFields(validPayload({ attachments: [{ filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }] }));
  assert.equal(fields.from, 'me');
  assert.deepEqual(fields.to, ['client@example.com']);
  assert.deepEqual(fields.cc, []);
  assert.deepEqual(fields.bcc, []);
  assert.equal(fields.subject, 'Quarterly Update');
  assert.equal(fields.body, 'Here is the update we discussed.');
  assert.deepEqual(fields.attachments, [{ filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }]);
  assert.equal(fields.isReply, false);
});

test('buildPayloadFields never mutates the payload it is given', () => {
  const payload = validPayload();
  const frozen = JSON.stringify(payload);
  view.buildPayloadFields(payload);
  assert.equal(JSON.stringify(payload), frozen);
});

test('a reply payload is flagged so the card can show thread context', () => {
  const fields = view.buildPayloadFields(validPayload({ threadId: 'thread_123', replyToMessageId: '<msg@mail.gmail.com>' }));
  assert.equal(fields.isReply, true);
  assert.equal(fields.threadId, 'thread_123');
});

test('a pending, unexpired send approval shows "Pending approval", both buttons enabled, and "Approve & Send"', () => {
  const record = approvalRecordFor(GMAIL_SEND_EMAIL_TOOL_ID, 'PENDING');
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.status, 'PENDING');
  assert.equal(vmView.statusLabel, 'Pending approval');
  assert.equal(vmView.approveActionLabel, 'Approve & Send');
  assert.equal(vmView.approveDisabled, false);
  assert.equal(vmView.rejectDisabled, false);
  assert.match(vmView.countdownLabel || '', /remaining/);
});

test('a reply approval action label reads "Approve & Send Reply"', () => {
  const record = approvalRecordFor(GMAIL_REPLY_TOOL_ID, 'PENDING');
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.approveActionLabel, 'Approve & Send Reply');
});

test('a create_draft approval action label reads "Approve & Save Draft" and its consumed label reads "Draft created"', () => {
  const pending = approvalRecordFor(GMAIL_CREATE_DRAFT_TOOL_ID, 'PENDING');
  assert.equal(view.buildCardViewModel(pending, Date.now()).approveActionLabel, 'Approve & Save Draft');
  const consumed = approvalRecordFor(GMAIL_CREATE_DRAFT_TOOL_ID, 'CONSUMED', { usedAt: new Date().toISOString(), executionId: 'exe_1' });
  assert.equal(view.buildCardViewModel(consumed, Date.now()).statusLabel, 'Draft created');
});

test('expired approval disables execution: Approve (and Reject) are disabled and status reads "Approval expired"', () => {
  const record = approvalRecordFor(GMAIL_SEND_EMAIL_TOOL_ID, 'PENDING', { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.status, 'EXPIRED');
  assert.equal(vmView.statusLabel, 'Approval expired');
  assert.equal(vmView.approveDisabled, true);
  assert.equal(vmView.rejectDisabled, true);
});

test('rejected approval disables execution: both buttons disabled, status reads "Rejected"', () => {
  const record = approvalRecordFor(GMAIL_SEND_EMAIL_TOOL_ID, 'REJECTED', { rejectedAt: new Date().toISOString() });
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.statusLabel, 'Rejected');
  assert.equal(vmView.approveDisabled, true);
  assert.equal(vmView.rejectDisabled, true);
});

test('a consumed send approval (already executed) is never actionable again, and reads "Email sent"', () => {
  const record = approvalRecordFor(GMAIL_SEND_EMAIL_TOOL_ID, 'CONSUMED', { usedAt: new Date().toISOString(), executionId: 'exe_1' });
  const vmView = view.buildCardViewModel(record, Date.now());
  assert.equal(vmView.statusLabel, 'Email sent');
  assert.equal(vmView.approveDisabled, true);
  assert.equal(vmView.rejectDisabled, true);
});

test('successful execution view model surfaces recipients, subject, executionId, messageId, threadId, and externalUrl', () => {
  const successVm = view.buildSuccessViewModel(GMAIL_SEND_EMAIL_TOOL_ID, validPayload(), {
    executionId: 'exe_abc123',
    externalId: 'gmail_msg_1',
    threadId: 'gmail_thread_1',
    externalUrl: 'https://mail.google.com/mail/u/0/#all/gmail_msg_1',
    status: 'SUCCEEDED',
  });
  assert.deepEqual(successVm.to, ['client@example.com']);
  assert.equal(successVm.subject, 'Quarterly Update');
  assert.equal(successVm.executionId, 'exe_abc123');
  assert.equal(successVm.messageId, 'gmail_msg_1');
  assert.equal(successVm.threadId, 'gmail_thread_1');
  assert.equal(successVm.externalUrl, 'https://mail.google.com/mail/u/0/#all/gmail_msg_1');
});

test('replay/conflict, expiry, tool-mismatch, and disconnected states each map to their required message', () => {
  assert.equal(view.describeExecutionError('APPROVAL_ALREADY_CONSUMED'), 'This approval has already been used.');
  assert.equal(view.describeExecutionError('APPROVAL_EXPIRED'), 'Approval expired');
  assert.equal(view.describeExecutionError('APPROVAL_PAYLOAD_MISMATCH'), 'The email details changed after approval. Please request approval again.');
  assert.equal(view.describeExecutionError('APPROVAL_TOOL_MISMATCH'), 'This approval does not match this action.');
  assert.equal(view.describeExecutionError('GMAIL_DISCONNECTED'), 'Gmail is not connected.');
});

test('an unrecognized error code falls back to null so the caller shows the server\'s own message', () => {
  assert.equal(view.describeExecutionError('SOME_UNKNOWN_CODE'), null);
});

// ── Ambient Assistant markup wiring ─────────────────────────────────────────

test('the app serves the Gmail approval-card view module with no-cache headers, and its tool names are present in both locales via the shared /api/v1/tools + nav i18n system', async () => {
  const { server } = await import('../src/server_web.js');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const origin = `http://127.0.0.1:${port}`;
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /src="gmail-approval-view\.js\?v=/);

    const viewJs = await (await fetch(`${origin}/gmail-approval-view.js`)).text();
    assert.equal(viewJs.length > 0, true);
    assert.equal((await fetch(`${origin}/gmail-approval-view.js`)).headers.get('cache-control'), 'no-store, no-cache, must-revalidate');

    // Gmail's tool names surface through the same generic, already-localized
    // Tools nav view every other tool uses (see i18n.js's nav.* keys) — no
    // Gmail-specific i18n keys exist yet because the approval card itself is
    // not wired into the ambient composer in this turn (documented as
    // Planned, not Implemented, in gmail-approval-view.js's header comment).
    const toolsResponse = await fetch(`${origin}/api/v1/tools`);
    const toolsBody = (await toolsResponse.json()) as { tools: Array<{ id: string; name: string }> };
    const toolIds = toolsBody.tools.map((t) => t.id);
    assert.ok(toolIds.includes(GMAIL_SEND_EMAIL_TOOL_ID));
    assert.ok(toolIds.includes(GMAIL_REPLY_TOOL_ID));
    assert.ok(toolIds.includes(GMAIL_CREATE_DRAFT_TOOL_ID));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
