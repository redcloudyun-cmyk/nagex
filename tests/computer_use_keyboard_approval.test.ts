// The keyboard must not be a way around the mouse's approval.
//
// Found while auditing the Browser Agent for Universal Computer Use: a KEYPRESS action went straight to the page. `Enter` in a text field submits its form; `Enter` or `Space` on a focused button presses it.
// So an Agent that was (rightly) stopped before clicking "Issue invoice" could type into a field and press Enter - and the invoice was issued without any approval. This file pins the fix, in real
// Chromium, against a page that records every submission it receives: pressing a key that would activate a consequential control needs the same approval as clicking that control, a control NAgex
// cannot name is not pressed at all, and harmless keys and harmless controls are unaffected.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import { PlaywrightBrowserRuntime } from '../src/modules/browser/browser.runtime.js';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { DeviceExecutionSessionStore } from '../src/device-control/device-execution-session.store.js';
import { DeviceControlService } from '../src/device-control/device-control.service.js';
import { FakeVisualExecutionModelAdapter } from '../src/device-control/fake-visual-execution-model.adapter.js';
import type { ProposedDeviceAction } from '../src/device-control/device-action.types.js';

const T = 'ten_kb';
const O = 'usr_kb';

const PAGE = `<!doctype html><html><head><title>Invoice</title></head><body>
<form id="invoice" action="/issue" method="post">
  <label>Amount <input id="amount" name="amount" type="text"></label>
  <label>Note <input id="note" name="note" type="text"></label>
  <button type="submit" id="issue">Issue invoice</button>
</form>
<form id="lonely" action="/lonely" method="post"><label>Search <input id="q" name="q" type="text"></label></form>
<form id="wizard" action="/step" method="post"><label>City <input id="city" name="city"></label><label>Zip <input id="zip" name="zip"></label></form>
<button type="button" id="help" onclick="document.title='help opened'">Open help</button>
<button type="button" id="pay" onclick="document.title='paid'">Pay now</button>
<a id="details" href="/details">Details</a>
<textarea id="memo"></textarea>
<input type="checkbox" id="agree" onchange="document.title='checked:'+this.checked">
</body></html>`;

let server: http.Server;
let base = '';
const hits: string[] = [];
let runtime: PlaywrightBrowserRuntime;
let service: BrowserToolService;
let approvals: ActionApprovalStore;
let deviceSessions: DeviceExecutionSessionStore;

before(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200);
    res.end(req.url === '/' ? PAGE : `<!doctype html><title>after ${req.url}</title><p>handled ${req.url}</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-kb-'));
  runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
  approvals = new ActionApprovalStore();
  service = new BrowserToolService(runtime, new BrowserSessionStore({ dir: path.join(dir, 'sessions') }), approvals, new AuditLogger(), new MemoryEngine({ dir: path.join(dir, 'memories') }));
  deviceSessions = new DeviceExecutionSessionStore({ dir: path.join(dir, 'device-sessions') });
});
after(async () => {
  await runtime.shutdown();
  await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
});

const submissions = () => hits.filter((h) => h.startsWith('POST /issue')).length;

async function freshPage() {
  const opened = await service.open({ tenantId: T, ownerId: O, requestId: 'req_open' });
  const ctx = { tenantId: T, ownerId: O, requestId: 'req', browserSessionId: opened.browserSessionId };
  await service.navigate({ ...ctx, url: `${base}/` });
  return ctx;
}

describe('Enter and Space are checked before they are pressed', () => {
  it('Enter in a field of a form with a submit button needs approval; nothing is submitted until it is granted, and it is granted once', async () => {
    const ctx = await freshPage();
    const before = submissions();
    await service.type({ ...ctx, selector: '#amount', text: '1000' });
    const result: any = await service.keypress({ ...ctx, key: 'Enter' });
    assert.equal(result.status, 'APPROVAL_REQUIRED', 'the keyboard is held to the same rule as the mouse');
    assert.equal(result.selector, '#issue');
    assert.equal(result.approval.canonicalPayload.targetText, 'Issue invoice');
    assert.equal(submissions(), before, 'NOTHING was submitted by the key');

    // the approval is the click on the control the key stood for
    approvals.approve(result.approval.approvalId, T, O, 'req_a');
    const executed = await service.executeApprovedClick({ approvalId: result.approval.approvalId, browserSessionId: ctx.browserSessionId, selector: result.selector, tenantId: T, ownerId: O, requestId: 'req_x' });
    assert.equal(executed.status, 'EXECUTED');
    assert.equal(submissions(), before + 1, 'exactly one submission, after approval');
    await assert.rejects(() => service.executeApprovedClick({ approvalId: result.approval.approvalId, browserSessionId: ctx.browserSessionId, selector: result.selector, tenantId: T, ownerId: O, requestId: 'req_y' }), (e: any) => e.code === 'APPROVAL_ALREADY_CONSUMED');
    assert.equal(submissions(), before + 1, 'no replay');
  });

  it('a rejected approval leaves the form unsubmitted', async () => {
    const ctx = await freshPage();
    const before = submissions();
    await service.type({ ...ctx, selector: '#note', text: 'x' });
    const result: any = await service.keypress({ ...ctx, key: 'Enter' });
    assert.equal(result.status, 'APPROVAL_REQUIRED');
    approvals.reject(result.approval.approvalId, T, O, 'req_r');
    await assert.rejects(() => service.executeApprovedClick({ approvalId: result.approval.approvalId, browserSessionId: ctx.browserSessionId, selector: result.selector, tenantId: T, ownerId: O, requestId: 'req_z' }), (e: any) => /APPROVAL_NOT_GRANTED|APPROVAL/.test(e.code));
    assert.equal(submissions(), before);
  });

  it('Enter or Space on a focused consequential button needs approval; on a harmless button it just presses it', async () => {
    const ctx = await freshPage();
    await service.click({ ...ctx, selector: '#help' }); // focus + press (harmless) - the title changes
    assert.equal((await runtime.snapshot(ctx.browserSessionId)).title, 'help opened');
    await runtime.type(ctx.browserSessionId, '#note', ''); // move focus away
    // focus the Pay button without pressing it
    await (runtime as any).requirePage(ctx.browserSessionId).focus('#pay');
    const held: any = await service.keypress({ ...ctx, key: 'Enter' });
    assert.equal(held.status, 'APPROVAL_REQUIRED');
    assert.equal(held.approval.canonicalPayload.targetText, 'Pay now');
    assert.notEqual((await runtime.snapshot(ctx.browserSessionId)).title, 'paid', 'the Pay button was not pressed');
    const space: any = await service.keypress({ ...ctx, key: ' ' });
    assert.equal(space.status, 'APPROVAL_REQUIRED', 'Space presses a focused button too');
    // a harmless button is pressed by the key
    await (runtime as any).requirePage(ctx.browserSessionId).focus('#help');
    await runtime.type(ctx.browserSessionId, '#note', '');
    await (runtime as any).requirePage(ctx.browserSessionId).focus('#help');
    const ok: any = await service.keypress({ ...ctx, key: 'Enter' });
    assert.equal(ok.status, 'EXECUTED');
  });

  it('Enter in a single-field form with no submit button is refused (there is no control to name); nothing is sent', async () => {
    const ctx = await freshPage();
    const before = hits.length;
    await service.type({ ...ctx, selector: '#q', text: 'x' });
    await assert.rejects(() => service.keypress({ ...ctx, key: 'Enter' }), (e: any) => e.code === 'BROWSER_KEYPRESS_ACTIVATION_UNKNOWN');
    assert.equal(hits.slice(before).filter((h) => h.includes('/lonely')).length, 0, 'the form was not submitted');
  });

  it('keys that activate nothing are unaffected: letters, Tab, arrows, Enter in a textarea, Space on a checkbox, Enter in a form field with several fields and no button', async () => {
    const ctx = await freshPage();
    await service.type({ ...ctx, selector: '#memo', text: 'a' });
    for (const key of ['Tab', 'ArrowDown', 'a', 'Enter']) assert.equal(((await service.keypress({ ...ctx, key })) as any).status, 'EXECUTED', `key ${key}`);
    await (runtime as any).requirePage(ctx.browserSessionId).focus('#agree');
    assert.equal(((await service.keypress({ ...ctx, key: ' ' })) as any).status, 'EXECUTED');
    assert.equal((await runtime.snapshot(ctx.browserSessionId)).title, 'checked:true', 'Space toggled the checkbox');
    // two text fields and no button: Enter does not submit the form in the browser either
    await service.type({ ...ctx, selector: '#city', text: 'Seoul' });
    const before = hits.length;
    assert.equal(((await service.keypress({ ...ctx, key: 'Enter' })) as any).status, 'EXECUTED');
    assert.equal(hits.slice(before).filter((h) => h.includes('/step')).length, 0, 'a form with two fields and no submit button is not submitted by Enter');
  });

  it('a runtime that cannot say what the key would activate does not press Enter or Space - but still presses harmless keys', async () => {
    const minimal = Object.create(runtime) as PlaywrightBrowserRuntime;
    (minimal as any).describeKeyActivation = undefined;
    const bare = new BrowserToolService(minimal, new BrowserSessionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-kb2-')) }), new ActionApprovalStore(), new AuditLogger(), new MemoryEngine({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-kb3-')) }));
    const opened = await bare.open({ tenantId: T, ownerId: O, requestId: 'r' });
    const ctx = { tenantId: T, ownerId: O, requestId: 'r', browserSessionId: opened.browserSessionId };
    await bare.navigate({ ...ctx, url: `${base}/` });
    await assert.rejects(() => bare.keypress({ ...ctx, key: 'Enter' }), (e: any) => e.code === 'BROWSER_KEYPRESS_ACTIVATION_UNKNOWN');
    assert.equal(((await bare.keypress({ ...ctx, key: 'Tab' })) as any).status, 'EXECUTED');
  });
});

describe('the Agent loop honours it', () => {
  const NAV = (url: string): ProposedDeviceAction => ({ action: 'NAVIGATE', value: url });
  const TYPE: ProposedDeviceAction = { action: 'TYPE', target: { selector: '#amount' }, value: '1000' };
  const ENTER: ProposedDeviceAction = { action: 'KEYPRESS', value: 'Enter' };
  const STOP: ProposedDeviceAction = { action: 'STOP', expectedResult: 'done' };

  it('type + Enter pauses the session for approval (nothing submitted); approving resumes by clicking the very control; rejecting submits nothing', async () => {
    const before = submissions();
    const model = new FakeVisualExecutionModelAdapter([NAV(`${base}/`), TYPE, ENTER, STOP]);
    const loop = new DeviceControlService(deviceSessions, service, model);
    const outcome = await loop.startSession({ tenantId: T, ownerId: O, requestId: 'req_loop', goal: 'issue the invoice', allowedDomains: ['127.0.0.1'], maxSteps: 10, maxDurationMs: 60_000 });
    assert.equal(outcome.kind, 'WAITING_APPROVAL', 'the loop stops at the approval boundary');
    assert.equal(submissions(), before, 'the key did not submit the form');
    if (outcome.kind !== 'WAITING_APPROVAL') return;
    const session = deviceSessions.getOwned(outcome.deviceExecutionSessionId, T, O)!;
    assert.equal(session.pendingAction?.action, 'CLICK', 'what resumes is a click on the control, never a free key press');
    assert.equal(session.pendingAction?.target?.selector, '#issue');

    approvals.approve(outcome.approval.approvalId, T, O, 'req_ap');
    const resumed = await loop.resumeSession({ tenantId: T, ownerId: O, requestId: 'req_res', deviceExecutionSessionId: outcome.deviceExecutionSessionId, approvalId: outcome.approval.approvalId });
    assert.equal(resumed.kind, 'COMPLETED');
    assert.equal(submissions(), before + 1, 'one submission, only after approval');
  });

  it('a refused key press is handed back to the model instead of ending the run', async () => {
    const model = new FakeVisualExecutionModelAdapter([NAV(`${base}/`), { action: 'TYPE', target: { selector: '#q' }, value: 'x' }, ENTER, STOP]);
    const loop = new DeviceControlService(deviceSessions, service, model);
    const outcome = await loop.startSession({ tenantId: T, ownerId: O, requestId: 'req_loop2', goal: 'search', allowedDomains: ['127.0.0.1'], maxSteps: 10, maxDurationMs: 60_000 });
    assert.equal(outcome.kind, 'COMPLETED', 'the model could continue (and here chose to stop)');
    const last = model.calls[model.calls.length - 1];
    const refused = last.priorActions.find((p) => p.action.action === 'KEYPRESS');
    assert.match(refused?.outcome || '', /FAILED/);
    assert.match(refused?.outcome || '', /BROWSER_KEYPRESS_ACTIVATION_UNKNOWN|could not be performed/);
  });
});
