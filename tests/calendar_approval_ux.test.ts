import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { server } from '../src/server_web.js';

async function withServer(run: (origin: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function extractFunctionBody(source: string, functionSignature: string): string {
  const start = source.indexOf(functionSignature);
  if (start < 0) return '';
  const next = source.indexOf('\n  function ', start + 1);
  const nextAsync = source.indexOf('\n  async function ', start + 1);
  const candidates = [next, nextAsync].filter((idx) => idx > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

// Real click/typing simulation would need a DOM/browser harness this repo
// does not have (see tests/ambient_modal_wiring.test.ts for the same note).
// What is verified here, statically, against the actually-served app.js: the
// resolution flow never creates an approval on its own, the compose form is
// always rendered for the calendar step, and the full set of timeline events
// (including the two new ones this fix adds) are wired in the right
// functions. tests/calendar_intent_extraction.test.ts and
// tests/calendar_payload_validation.test.ts cover the pure extraction/
// validation logic these functions call.

test('item 3/9: resolving a plan never creates a calendar approval on its own — only the compose form is rendered', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const body = extractFunctionBody(appJs, 'async function resolvePlanIntoUi(');
    assert.ok(body.length > 0, 'expected to find resolvePlanIntoUi in the served app.js');
    assert.ok(!/requestCalendarApproval\s*\(/.test(body), 'resolvePlanIntoUi must never call requestCalendarApproval directly');
    assert.match(body, /renderCalendarComposeForm\(/);
  });
});

test('item 1/2: the compose form prefills from the extracted intent, never from the plan step, and never defaults start to 10:00', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const body = extractFunctionBody(appJs, 'function renderCalendarComposeForm(');
    assert.ok(body.length > 0, 'expected to find renderCalendarComposeForm in the served app.js');

    // Title and start must come from the extracted intent (or be blank),
    // never from the plan step's own generic title/reasoning.
    assert.match(body, /extracted && extracted\.summary/);
    assert.doesNotMatch(body, /calendarStep\.title/);
    assert.doesNotMatch(body, /calendarStep\.reasoning/);

    // No hardcoded 10 AM / hour-10 default anywhere in the form.
    assert.doesNotMatch(appJs, /setHours\(10,\s*0,\s*0,\s*0\)/);
    assert.doesNotMatch(appJs, /defaultEventStartLocal/);

    // A duration that was not extracted is clearly marked as a suggestion,
    // never presented as if the user had stated it.
    assert.match(body, /durationIsSuggested/);
    assert.match(body, /suggested/i);
  });
});

test('item 8: the compose form validates the payload before allowing submission, and never re-derives it from the prompt at submit time', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    const body = extractFunctionBody(appJs, 'function renderCalendarComposeForm(');
    assert.match(body, /NAGEX_CALENDAR_VALIDATION/);
    assert.match(body, /validateCalendarComposeForm/);
    assert.match(body, /if \(!result\.valid\)/);
    assert.match(body, /return; \/\/ Preview & Request Approval never proceeds while invalid\./);

    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /src="calendar-payload-validation\.js\?v=/);
  });
});

test('item 6: the activity timeline is wired for the full expected order, including the two new stages', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();

    // Plan created / Plan resolved happen in the plan-generation/resolution
    // functions with the SAME plan identity (res.requestId / planId).
    const runTaskBody = extractFunctionBody(appJs, 'async function runAmbientTask(');
    assert.match(runTaskBody, /addTimelineEntry\('Plan created', res\.requestId\)/);

    const resolveBody = extractFunctionBody(appJs, 'async function resolvePlanIntoUi(');
    assert.match(resolveBody, /addTimelineEntry\('Plan resolved', planId\)/);
    // resolvePlanIntoUi must never log "Plan created" itself — only
    // runAmbientTask does, once, per generated plan.
    assert.doesNotMatch(resolveBody, /addTimelineEntry\('Plan created'/);

    assert.match(appJs, /addTimelineEntry\('Approval requested', approval\.approvalId\)/);
    assert.match(appJs, /addTimelineEntry\('Approved', approval\.approvalId\)/);
    assert.match(appJs, /addTimelineEntry\('Execution started', approval\.approvalId\)/);
    assert.match(appJs, /addTimelineEntry\('Calendar event created', approval\.approvalId\)/);

    // Approved must be logged before Execution started, which must be
    // logged before the create-event call.
    const approvedIdx = appJs.indexOf("addTimelineEntry('Approved', approval.approvalId)");
    const executionIdx = appJs.indexOf("addTimelineEntry('Execution started', approval.approvalId)");
    const createEventIdx = appJs.indexOf("apiFetch('/api/v1/tools/google-calendar/create-event'");
    assert.ok(approvedIdx > 0 && executionIdx > approvedIdx && createEventIdx > executionIdx, 'expected Approved -> Execution started -> create-event call, in that source order');
  });
});

test('item 5: plan identity (res.requestId) flows from generation into resolution unchanged, never re-minted', async () => {
  await withServer(async (origin) => {
    const appJs = await (await fetch(`${origin}/app.js`)).text();
    assert.match(appJs, /resolvePlanIntoUi\(res\.plan, promptText, res\.requestId\)/);
    assert.match(appJs, /async function resolvePlanIntoUi\(plan, originalPromptText, planId\)/);
  });
});
