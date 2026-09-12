import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { server } from '../src/server_web.js';

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  if (server.listening) {
    const addr = server.address() as AddressInfo | null;
    if (addr && addr.port) {
      await run(`http://127.0.0.1:${addr.port}`);
      return;
    }
  }
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}


// This repo has no jsdom/browser test harness (see tests/ambient_composer.test.ts's
// note on the same limitation for Calendar). What is verified here, statically
// against the real served app.js — mirroring ambient_composer.test.ts's own
// technique — is the shape of the actual wiring: which function calls which,
// in what order, and under what condition. The functional guarantees this
// wiring depends on (approval required/hash-verified/replay-protected
// execution, read-only tools never requiring approval) are exercised for
// real against the real backend in tests/gmail_live.test.ts.

function extractFunctionBody(source: string, signature: string, nextMarkerCandidates: string[]): string {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `expected to find "${signature}" in the served app.js`);
  let end = source.length;
  for (const marker of nextMarkerCandidates) {
    const idx = source.indexOf(marker, start + signature.length);
    if (idx > start && idx < end) end = idx;
  }
  return source.slice(start, end);
}

test('the app serves gmail-approval-view.js and gmail-intent-extraction.js, both no-cache', async () => {
  await withServer(async (origin) => {
    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /src="gmail-approval-view\.js\?v=/);
    assert.match(html, /src="gmail-intent-extraction\.js\?v=/);

    for (const file of ['gmail-approval-view.js', 'gmail-intent-extraction.js']) {
      const res = await fetch(`${origin}/${file}`);
      const body = await res.text();
      assert.equal(body.length > 0, true, `expected ${file} to be served with content`);
      assert.equal(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
    }
  });
});

test('resolvePlanIntoUi resolves a Gmail write step to the compose form only when APPROVAL_REQUIRED, and to a Connect action when UNAVAILABLE', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const body = extractFunctionBody(appJs, 'async function resolvePlanIntoUi(', ['\n  function renderConnectGoogleCalendarAction(']);

    assert.match(body, /GMAIL_WRITE_TOOL_IDS\.has\(s\.resolvedToolId\)/);
    assert.match(body, /renderConnectGmailAction\(actionsEl\)/);
    assert.match(body, /executionReadiness === 'BLOCKED'/);
    assert.match(body, /renderGmailComposeForm\(actionsEl, gmailStep\.resolvedToolId, extracted\)/);
    assert.match(body, /executionReadiness === 'APPROVAL_REQUIRED'/);

    // Read-only branch runs immediately (no approval gate), gated on
    // EXECUTION_READY specifically — never APPROVAL_REQUIRED/BLOCKED.
    assert.match(body, /GMAIL_READ_TOOL_IDS\.has\(s\.resolvedToolId\) && s\.executionReadiness === 'EXECUTION_READY'/);
    assert.match(body, /runGmailReadOnlyStep\(actionsEl, gmailReadStep\.resolvedToolId, originalPromptText, planId\)/);
  });
});

test('item 3/4: extraction never invents a value and never requests approval on render — only on explicit form submit', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const formBody = extractFunctionBody(appJs, 'function renderGmailComposeForm(', ['\n  function renderGmailApprovalCard(']);

    // The compose form's own rendering must never itself request an
    // approval — only its onsubmit handler may.
    const renderPart = formBody.slice(0, formBody.indexOf('form.onsubmit'));
    assert.doesNotMatch(renderPart, /requestGmailApproval\(/);

    // Fail closed on a missing/invalid recipient: the form must validate
    // `to` and refuse to call requestGmailApproval when it is empty or
    // contains anything that doesn't look like a real email address.
    assert.match(formBody, /if \(!to\.length \|\| !to\.every/);
    const returnBeforeRequest = formBody.indexOf('return;', formBody.indexOf('!to.length'));
    const requestCallIdx = formBody.indexOf('requestGmailApproval(toolId, payload)');
    assert.ok(returnBeforeRequest > 0 && requestCallIdx > returnBeforeRequest, 'expected the validation-failure return to appear before requestGmailApproval is ever called');

    // recipientNameHint is rendered as informational text only — the actual
    // <input id="gmail-to"> value prefill comes from `toValue`, which is
    // built strictly from extracted.to (real addresses), never from
    // recipientNameHint.
    assert.match(formBody, /recipientNameHint/);
    assert.match(formBody, /const toValue = extracted && extracted\.to\.length \? extracted\.to\.join/);
  });
});

test('item 5: send/reply/draft each execute against their own endpoint and use the exact canonicalPayload the approval API returned', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /\[GMAIL_SEND_EMAIL_TOOL_ID\]: '\/api\/v1\/tools\/gmail\/send-email'/);
    assert.match(appJs, /\[GMAIL_REPLY_TOOL_ID\]: '\/api\/v1\/tools\/gmail\/reply'/);
    assert.match(appJs, /\[GMAIL_CREATE_DRAFT_TOOL_ID\]: '\/api\/v1\/tools\/gmail\/create-draft'/);

    const body = extractFunctionBody(appJs, 'async function requestGmailApproval(', ['\n  function renderGmailSearchResults(']);
    // Approve before execute, and the executed payload is approval.canonicalPayload — never the locally-composed one.
    const approveIdx = body.indexOf("apiFetch(`/api/v1/approvals/${approval.approvalId}/approve`");
    const executeIdx = body.indexOf('GMAIL_EXECUTE_ENDPOINT[toolId]');
    assert.ok(approveIdx > 0 && executeIdx > approveIdx, 'expected approve to happen strictly before execute');
    assert.match(body, /body: JSON\.stringify\(\{ approvalId: approval\.approvalId, payload: approval\.canonicalPayload \}\)/);

    // Per-toolId action/status labels (Approve & Send / Approve & Reply / Approve & Create Draft).
    assert.match(appJs, /gmailComposeTitleKey/);
    assert.match(appJs, /gmailExecutingLabelKey/);
    assert.match(appJs, /gmailSucceededLabelKey/);
  });
});

test('item 6: read-only search/read_thread never call POST /api/v1/approvals', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const body = extractFunctionBody(appJs, 'async function runGmailReadOnlyStep(', ['\n  // The "▶ Run" button']);
    assert.doesNotMatch(body, /api\/v1\/approvals/);
    assert.match(body, /\/api\/v1\/tools\/gmail\/search/);
    assert.match(body, /\/api\/v1\/tools\/gmail\/read-thread/);
    // read_thread never fabricates a threadId — it only ever proceeds when
    // one is already known from a real prior result in this session.
    assert.match(body, /state\.lastGmailThread && state\.lastGmailThread\.threadId/);
  });
});

test('item 8: the exact required timeline labels are the ones actually logged for send and search', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    const approvalBody = extractFunctionBody(appJs, 'async function requestGmailApproval(', ['\n  function renderGmailSearchResults(']);
    assert.match(approvalBody, /addTimelineEntry\('Approval requested', `approval:\$\{approval\.approvalId\}:requested`, 'requestGmailApproval'\)/);
    assert.match(approvalBody, /addTimelineEntry\('Approved', `approval:\$\{approval\.approvalId\}:approved`, 'btnGmailApprove\.onclick'\)/);
    assert.match(approvalBody, /addTimelineEntry\('Execution started', `execution:\$\{approval\.approvalId\}:started`, 'btnGmailApprove\.onclick'\)/);
    // The succeeded label is looked up via i18n (t(gmailSucceededLabelKey(toolId))) — 'gmail.sent' resolves to "Email sent" in EN (see i18n_strings coverage).
    assert.match(approvalBody, /addTimelineEntry\(t\(gmailSucceededLabelKey\(toolId\)\), `execution:\$\{result\.executionId\}:succeeded`, 'btnGmailApprove\.onclick'\)/);

    const readBody = extractFunctionBody(appJs, 'async function runGmailReadOnlyStep(', ['\n  // The "▶ Run" button']);
    assert.match(readBody, /addTimelineEntry\('Execution started', `execution:\$\{planId\}:\$\{toolId\}:started`, 'runGmailReadOnlyStep'\)/);
    assert.match(readBody, /addTimelineEntry\('Search completed', `execution:\$\{planId\}:\$\{toolId\}:completed`, 'runGmailReadOnlyStep'\)/);

    // "Plan created" and "Plan resolved" already fire generically for every
    // plan (runAmbientTask / resolvePlanIntoUi), Gmail included — see
    // ambient_composer.test.ts / tests/plan_lifecycle_timeline.test.ts.
    assert.match(appJs, /addTimelineEntry\('Plan created', `plan:\$\{res\.requestId\}:created`, 'runAmbientTask'\)/);
    assert.match(appJs, /addTimelineEntry\('Plan resolved', `plan:\$\{planId\}:resolved`, 'resolvePlanIntoUi'\)/);
  });
});

test('item 9: Gmail-facing strings are i18n-driven (t(...)), not hardcoded English, in the new Gmail functions', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const composeFormBody = extractFunctionBody(appJs, 'function renderGmailComposeForm(', ['\n  function renderGmailApprovalCard(']);
    const approvalCardBody = extractFunctionBody(appJs, 'function renderGmailApprovalCard(', ['\n  function renderGmailSuccessCard(']);

    for (const key of ["t('gmail.to')", "t('gmail.cc')", "t('gmail.bcc')", "t('gmail.subject')", "t('gmail.body')", "t('gmail.account')", "t('gmail.previewAndRequestApproval')"]) {
      assert.ok(composeFormBody.includes(key), `expected ${key} in renderGmailComposeForm`);
    }
    assert.ok(approvalCardBody.includes("t('ambient.approvalRequired')"));
    assert.ok(approvalCardBody.includes("t('gmail.reject')"));
    // The approve button's label is per-toolId and i18n-driven (Approve &
    // Send / Reply / Create Draft) — never the view-model's own hardcoded
    // English string, so it participates in EN/KR switching like everything
    // else on this card.
    assert.match(approvalCardBody, /t\(gmailApproveButtonLabelKey\(approval\.toolId\)\)/);
    assert.doesNotMatch(approvalCardBody, /vmView\.approveActionLabel/);
  });
});
