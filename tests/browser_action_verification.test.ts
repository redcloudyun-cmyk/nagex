// An Agent must not assume a click worked because browser automation returned without an error. This file pins the separation of
//   tool call succeeded / page state changed / intended task completed / outcome uncertain,
// the recognition of an Agent that repeats itself without progress, and the bounded recovery from a target that is gone - all without ever weakening approval.
// Pure logic first, then the real Chromium runtime and the real Agent loop (DeviceControlService) over deterministic local pages with a SCRIPTED model: only NAgex's behaviour is under test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  humanVerificationRequired, verifyClick, verifyFieldWrite, verifyNavigation,
  type PageObservation, type TargetObservation,
} from '../src/modules/browser/action-verification.js';
import { ActionLoopGuard, actionSignature, snapshotStateKey, summarizeCompletion, type StepEvidence } from '../src/device-control/action-loop-guard.js';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { PlaywrightBrowserRuntime } from '../src/modules/browser/browser.runtime.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { ExecutionStore } from '../src/governance/execution.store.js';
import { AuditLogger, type AuditEventRecord } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { DeviceControlService } from '../src/device-control/device-control.service.js';
import { DeviceExecutionSessionStore } from '../src/device-control/device-execution-session.store.js';
import type { ProposedDeviceAction } from '../src/device-control/device-action.types.js';
import type { ProposeNextActionInput, VisualExecutionModelPort } from '../src/device-control/visual-execution-model.port.js';

process.env.NAGEX_ALLOW_LOCAL_TEST_URLS = '1';

// ---------------------------------------------------------------------------------------------------- pure evaluation

const obs = (over: Partial<PageObservation> = {}): PageObservation => ({ url: 'http://x/form', title: 'Form', signature: '10:100:1', messages: [], invalidFields: 0, validationMessages: [], dialogOpen: false, text: 'Form', ...over });
const tgt = (over: Partial<TargetObservation> = {}): TargetObservation => ({ connected: true, visible: true, enabled: true, tag: 'button', ...over });
const click = (over: Partial<Parameters<typeof verifyClick>[0]> = {}) => verifyClick({ before: obs(), after: obs(), targetBefore: tgt(), targetAfter: tgt(), sideEffectPossible: false, ...over });

describe('what a click is judged on (pure)', () => {
  it('nothing changed -> NOT_VERIFIED; only the content changed -> NOT_VERIFIED (a changed DOM is not business success); only the address changed -> NOT_VERIFIED', () => {
    assert.deepEqual([click().outcome, click().basis], ['NOT_VERIFIED', ['NO_OBSERVABLE_CHANGE']]);
    const dom = click({ after: obs({ signature: '11:120:2', text: 'Form more' }) });
    assert.deepEqual([dom.outcome, dom.basis], ['NOT_VERIFIED', ['DOM_CHANGED_ONLY']]);
    const url = click({ after: obs({ url: 'http://x/other' }) });
    assert.deepEqual([url.outcome, url.basis], ['NOT_VERIFIED', ['URL_CHANGED']]);
  });

  it('strong evidence verifies: a success message that was not there, the control\'s own state flipping, arriving at the link\'s destination', () => {
    const msg = click({ after: obs({ signature: '11:120:2', messages: [{ kind: 'SUCCESS', text: 'Saved successfully' }] }) });
    assert.deepEqual([msg.outcome, msg.basis, msg.messages], ['VERIFIED', ['SUCCESS_MESSAGE'], ['Saved successfully']]);
    const toggled = click({ targetBefore: tgt({ expanded: false }), targetAfter: tgt({ expanded: true }) });
    assert.deepEqual([toggled.outcome, toggled.basis], ['VERIFIED', ['TARGET_STATE_CHANGED']]);
    const link = click({ before: obs({ url: 'http://x/' }), after: obs({ url: 'http://x/details#top', title: 'Details' }), targetBefore: tgt({ tag: 'a', href: 'http://x/details' }), targetAfter: null });
    assert.deepEqual([link.outcome, link.basis], ['VERIFIED', ['NAVIGATED_TO_LINK_TARGET']]);
  });

  it('a message that was already on the page does not count; an error or a refused submit is a failure, even next to a success-looking word', () => {
    const known = [{ kind: 'SUCCESS' as const, text: 'Saved successfully' }];
    assert.equal(click({ before: obs({ messages: known }), after: obs({ messages: known }) }).outcome, 'NOT_VERIFIED');
    const err = click({ after: obs({ signature: '11:1:2', messages: [{ kind: 'ERROR', text: 'Error: the server rejected this name' }] }) });
    assert.deepEqual([err.outcome, err.basis], ['FAILED', ['ERROR_MESSAGE']]);
    const refused = click({ before: obs({ invalidFields: 1 }), after: obs({ invalidFields: 1, validationMessages: ['Please fill out this field.'] }) });
    assert.deepEqual([refused.outcome, refused.basis], ['FAILED', ['VALIDATION_ERROR']]);
    const worse = click({ after: obs({ invalidFields: 2, signature: '10:100:9' }) });
    assert.equal(worse.outcome, 'FAILED');
    // an invalid field that is merely sitting on a page that changed for another reason is not blamed
    assert.notEqual(click({ before: obs({ invalidFields: 1 }), after: obs({ invalidFields: 1, signature: '12:130:3' }), targetBefore: tgt({ tag: 'a' }) }).outcome, 'FAILED');
  });

  it('an explicit expectation decides: all conditions must hold; unmet is NOT_VERIFIED, or FAILED when the page shows an error', () => {
    const after = obs({ url: 'http://x/done', text: 'Order received' });
    assert.equal(click({ after, expectation: { urlIncludes: '/done', textIncludes: 'Order received' } }).outcome, 'VERIFIED');
    assert.deepEqual([click({ after, expectation: { urlIncludes: '/done', textIncludes: 'Thanks' } }).outcome, click({ after, expectation: { urlIncludes: '/nope' } }).basis], ['NOT_VERIFIED', ['EXPECTATION_NOT_MET']]);
    assert.equal(click({ after: obs({ messages: [{ kind: 'ERROR', text: 'Payment failed' }], signature: 'e' }), expectation: { textIncludes: 'Order received' } }).outcome, 'FAILED');
    assert.equal(click({ targetAfter: null, expectation: { targetGone: true } }).outcome, 'VERIFIED');
    assert.equal(click({ expectation: { targetGone: true } }).outcome, 'NOT_VERIFIED');
  });

  it('an approved consequential action stays uncertain unless the page proves it, and then says it will not be repeated automatically', () => {
    const unknown = click({ sideEffectPossible: true });
    assert.deepEqual([unknown.outcome, unknown.retrySafe, unknown.sideEffectPossible], ['NOT_VERIFIED', false, true]);
    assert.match(unknown.summary, /will not be repeated automatically/);
    const proven = click({ sideEffectPossible: true, after: obs({ signature: 'x', messages: [{ kind: 'SUCCESS', text: 'Order placed' }] }) });
    assert.equal(proven.outcome, 'VERIFIED');
    assert.equal(click().retrySafe, true, 'a read-only click can be repeated');
    assert.equal(click({ before: null }).basis[0], 'NO_OBSERVATION');
  });

  it('field writes are verified by reading them back; a navigation by arriving where it was sent; a verification wall asks the person', () => {
    assert.equal(verifyFieldWrite({ found: true, matches: true, length: 5, password: false }).outcome, 'VERIFIED');
    assert.deepEqual([verifyFieldWrite({ found: true, matches: false, length: 3, password: false }).outcome, verifyFieldWrite(null).outcome], ['FAILED', 'NOT_VERIFIED']);
    assert.equal(verifyNavigation('http://x/a', 'http://x/b').outcome, 'VERIFIED');
    assert.equal(verifyNavigation('http://x/a', 'http://elsewhere/b').outcome, 'NOT_VERIFIED');
    const wall = humanVerificationRequired('http://x/captcha');
    assert.deepEqual([wall.outcome, wall.basis], ['USER_ACTION_REQUIRED', ['HUMAN_VERIFICATION_REQUIRED']]);
  });
});

describe('repeated action detection and the completion verdict (pure)', () => {
  const step = (over: Partial<StepEvidence> = {}): StepEvidence => ({ action: 'CLICK', signature: 'CLICK|#more|', stateKey: 's1', outcome: 'NOT_VERIFIED', basis: ['NO_OBSERVABLE_CHANGE'], mutating: true, ...over });

  it('the same action on the same page state, three times without progress, is a loop', () => {
    const guard = new ActionLoopGuard();
    assert.equal(guard.record(step()).loop, false);
    assert.equal(guard.record(step()).loop, false);
    const third = guard.record(step());
    assert.deepEqual([third.loop, third.repeats], [true, 3]);
  });

  it('pagination and other legitimate repeats are not loops: the page was different each time', () => {
    const guard = new ActionLoopGuard();
    for (let page = 1; page <= 10; page++) assert.equal(guard.record(step({ signature: 'CLICK|#next|', stateKey: `page${page}`, basis: ['DOM_CHANGED_ONLY'] })).loop, false);
  });

  it('alternating between two actions that leave the page as it was is a loop too; a verified step breaks it', () => {
    const guard = new ActionLoopGuard();
    const a = step({ signature: 'CLICK|#a|' });
    const b = step({ signature: 'CLICK|#b|' });
    const verdicts = [a, b, a, b, a].map((s) => guard.record(s).loop);
    assert.deepEqual(verdicts, [false, false, false, false, true]);
    const progressing = new ActionLoopGuard();
    assert.equal([step(), step({ outcome: 'VERIFIED', basis: ['SUCCESS_MESSAGE'] }), step()].map((s) => progressing.record(s).loop).some(Boolean), false);
  });

  it('the signature carries the action, the target and the value; the state key changes with the page', () => {
    assert.notEqual(actionSignature({ action: 'TYPE', target: { selector: '#n' }, value: 'a' }), actionSignature({ action: 'TYPE', target: { selector: '#n' }, value: 'b' }));
    const snap = { url: 'http://x/', title: 't', text: 'hello', links: [], buttons: [], inputs: [] };
    assert.equal(snapshotStateKey(snap), snapshotStateKey({ ...snap }));
    assert.notEqual(snapshotStateKey(snap), snapshotStateKey({ ...snap, text: 'hello again' }));
  });

  it('the model\'s STOP is a claim: only the last action that could change something decides', () => {
    assert.deepEqual(summarizeCompletion([]).outcome, 'NOT_VERIFIED');
    assert.equal(summarizeCompletion([step({ action: 'OBSERVE', mutating: false })]).outcome, 'NOT_VERIFIED');
    assert.equal(summarizeCompletion([step({ outcome: 'FAILED', basis: ['ERROR_MESSAGE'] })]).outcome, 'FAILED');
    assert.equal(summarizeCompletion([step({ outcome: 'FAILED', basis: ['VALIDATION_ERROR'] }), step({ outcome: 'VERIFIED', basis: ['SUCCESS_MESSAGE'] })]).outcome, 'VERIFIED', 'a later verified action supersedes an earlier failure');
    const v = summarizeCompletion([step({ outcome: 'VERIFIED', basis: ['FIELD_VALUE_MATCHED'] }), step()]);
    assert.deepEqual([v.outcome, v.verifiedActions, v.unverifiedActions], ['NOT_VERIFIED', 1, 1]);
  });
});

// ---------------------------------------------------------------------------------------------------- real browser

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
const MSG = '<div id="msg"></div>';
const PAGES: Record<string, string> = {
  '/form-ok': page('Form', `<input id="name" placeholder="Name"><button id="apply" type="button" onclick="msg.textContent='Saved successfully';msg.setAttribute('role','status')">Apply</button>${MSG}`),
  '/form-invalid': page('Form', `<input id="name" required placeholder="Name"><button id="apply" type="button" onclick="if(!document.getElementById('name').reportValidity())return;msg.textContent='Saved successfully';msg.setAttribute('role','status')">Apply</button>${MSG}`),
  '/form-error': page('Form', `<input id="name" placeholder="Name"><button id="apply" type="button" onclick="msg.textContent='Error: the server rejected this name';msg.setAttribute('role','alert')">Apply</button>${MSG}`),
  '/nav': page('Home', '<a id="go" href="/details">Open details</a>'),
  '/details': page('Details', '<h1>Details</h1>'),
  '/nochange': page('Static', '<button id="r" type="button">Refresh list</button>'),
  '/loop': page('Loop', '<button id="more" type="button">Load more</button>'),
  '/pagination': page('Pages', '<button id="next" type="button" onclick="n.textContent=Number(n.textContent)+1">Next</button> Page <span id="n">1</span>'),
  '/stale': page('Stale', `<button id="b" type="button" onclick="msg.textContent='Continued'">Continue</button>${MSG}`),
  '/approval': page('Shop', `<button id="buy" type="button" onclick="fetch('/order',{method:'POST'});msg.textContent='Ordered';msg.setAttribute('role','status')">Buy now</button>${MSG}`),
  '/unknown': page('Shop', `<button id="place" type="button" onclick="fetch('/order',{method:'POST'})">Place order</button>${MSG}`),
  '/toggle': page('Toggle', '<button id="t" type="button" aria-expanded="false" onclick="this.setAttribute(\'aria-expanded\', this.getAttribute(\'aria-expanded\')===\'false\')">Details</button>'),
  '/rewrite': page('Rewrite', '<input id="f" placeholder="Code" oninput="this.value=this.value.toUpperCase()"><input id="pw" type="password" placeholder="Password"><select id="s"><option value="a">A</option><option value="b">B</option></select>'),
  '/captcha': page('Security Check', '<h1>Verify you are human</h1><p>Please solve this captcha.</p>'),
  '/captcha-link': page('Home', '<a id="go" href="/captcha">Continue</a>'),
};
let orders = 0;
let server: http.Server;
let base = '';
let runtime: PlaywrightBrowserRuntime;
let counter = 0;
let tmp = '';
const audits: AuditEventRecord[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://x').pathname;
    if (pathname === '/order') { orders++; res.end('ok'); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const body = PAGES[pathname];
    if (!body) { res.statusCode = 404; res.end('not found'); return; }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-verify-'));
  runtime = new PlaywrightBrowserRuntime(false, path.join(tmp, 'profiles'));
});

after(async () => {
  await runtime.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function rig() {
  const sessions = new BrowserSessionStore({ dir: fs.mkdtempSync(path.join(tmp, 'sessions-')) });
  const audit = new AuditLogger();
  audit.logEvent = (event: AuditEventRecord) => { audits.push(event); return event; };
  const executions = new ExecutionStore({ dir: fs.mkdtempSync(path.join(tmp, 'exec-')) });
  const service = new BrowserToolService(runtime, sessions, new ActionApprovalStore(), audit, new MemoryEngine(), executions);
  return { service, executions };
}

async function open(pagePath: string) {
  const { service, executions } = rig();
  const input = { tenantId: 'ten_av', ownerId: 'usr_av', requestId: `req_av_${++counter}` };
  const session = await service.open(input);
  const scoped = { ...input, browserSessionId: session.browserSessionId };
  await service.navigate({ ...scoped, url: base + pagePath });
  return { service, executions, scoped, close: () => service.close(scoped) };
}

describe('the browser tools report what the page showed', () => {
  it('a form submit that succeeds is VERIFIED by its success message; one the browser refuses is FAILED; a server error banner is FAILED; a click that does nothing is NOT_VERIFIED', async () => {
    const run = async (pagePath: string, selector: string, typeFirst = false) => {
      const p = await open(pagePath);
      try {
        if (typeFirst) await p.service.type({ ...p.scoped, selector: '#name', text: 'Alice' });
        const r = await p.service.click({ ...p.scoped, selector });
        assert.equal(r.status, 'EXECUTED');
        return (r as any).verification;
      } finally { await p.close(); }
    };
    const ok = await run('/form-ok', '#apply', true);
    assert.deepEqual([ok.outcome, ok.basis], ['VERIFIED', ['SUCCESS_MESSAGE']]);
    const invalid = await run('/form-invalid', '#apply');
    assert.deepEqual([invalid.outcome, invalid.basis], ['FAILED', ['VALIDATION_ERROR']]);
    const rejected = await run('/form-error', '#apply');
    assert.deepEqual([rejected.outcome, rejected.basis], ['FAILED', ['ERROR_MESSAGE']]);
    assert.match(rejected.messages[0], /rejected this name/);
    const nothing = await run('/nochange', '#r');
    assert.deepEqual([nothing.outcome, nothing.basis, nothing.retrySafe], ['NOT_VERIFIED', ['NO_OBSERVABLE_CHANGE'], true]);
  });

  it('navigation: a link click that arrives at its destination is VERIFIED; the navigate tool reports the page it loaded; a toggle that flips is VERIFIED', async () => {
    const link = await open('/nav');
    try {
      const r = await link.service.click({ ...link.scoped, selector: '#go' });
      assert.deepEqual([(r as any).verification.outcome, (r as any).verification.basis], ['VERIFIED', ['NAVIGATED_TO_LINK_TARGET']]);
    } finally { await link.close(); }
    const toggle = await open('/toggle');
    try {
      const r = await toggle.service.click({ ...toggle.scoped, selector: '#t' });
      assert.deepEqual([(r as any).verification.outcome, (r as any).verification.basis], ['VERIFIED', ['TARGET_STATE_CHANGED']]);
    } finally { await toggle.close(); }
    const { service } = rig();
    const input = { tenantId: 'ten_av', ownerId: 'usr_av', requestId: 'req_av_nav' };
    const session = await service.open(input);
    const nav = await service.navigate({ ...input, browserSessionId: session.browserSessionId, url: base + '/nav' });
    assert.deepEqual([nav.verification?.outcome, nav.verification?.basis], ['VERIFIED', ['NAVIGATION_COMPLETED']]);
    await service.close({ ...input, browserSessionId: session.browserSessionId });
  });

  it('an explicit expectation is checked against the page', async () => {
    const p = await open('/form-ok');
    try {
      const r = await p.service.click({ ...p.scoped, selector: '#apply', expect: { textIncludes: 'Saved successfully' } });
      assert.deepEqual([(r as any).verification.outcome, (r as any).verification.basis], ['VERIFIED', ['EXPECTATION_MET']]);
    } finally { await p.close(); }
    const q = await open('/nochange');
    try {
      const r = await q.service.click({ ...q.scoped, selector: '#r', expect: { textIncludes: 'Saved successfully' } });
      assert.deepEqual([(r as any).verification.outcome, (r as any).verification.basis], ['NOT_VERIFIED', ['EXPECTATION_NOT_MET']]);
    } finally { await q.close(); }
  });

  it('typing is verified by reading the field back (inside the page); a page that rewrites the value is caught; a password stays private', async () => {
    const p = await open('/rewrite');
    try {
      const upper = await p.service.type({ ...p.scoped, selector: '#f', text: 'ABC' });
      assert.equal(upper.verification.outcome, 'VERIFIED');
      const lower = await p.service.type({ ...p.scoped, selector: '#f', text: 'abc' }); // the page upper-cases it
      assert.deepEqual([lower.verification.outcome, lower.verification.basis], ['FAILED', ['FIELD_VALUE_MISMATCH']]);
      const secret = await p.service.type({ ...p.scoped, selector: '#pw', text: 'hunter2-secret' });
      assert.equal(secret.verification.outcome, 'VERIFIED');
      assert.doesNotMatch(JSON.stringify(secret), /hunter2-secret/);
      assert.doesNotMatch(JSON.stringify(audits.filter((a) => a.action.includes('tool.execution'))), /hunter2-secret/);
      const sel = await p.service.select({ ...p.scoped, selector: '#s', value: 'b' });
      assert.equal(sel.verification.outcome, 'VERIFIED');
    } finally { await p.close(); }
  });

  it('a verification wall still stops the session for the person (no bypass)', async () => {
    const p = await open('/captcha-link');
    try {
      await assert.rejects(() => p.service.click({ ...p.scoped, selector: '#go' }), (e: any) => e.code === 'BROWSER_HUMAN_VERIFICATION_REQUIRED');
    } finally { await p.close(); }
  });

  it('an approved consequential click runs once; its result is judged on evidence; the execution record and the audit trail carry the verdict', async () => {
    const ordersBefore = orders;
    const p = await open('/unknown');
    try {
      const asked = await p.service.click({ ...p.scoped, selector: '#place' });
      assert.equal(asked.status, 'APPROVAL_REQUIRED');
      assert.equal(orders, ordersBefore, 'nothing happens before approval');
      const approvalId = (asked as any).approval.approvalId;
      p.service.approve(approvalId, 'ten_av', 'usr_av', 'req_av_approve');
      const done = await p.service.executeApprovedClick({ approvalId, browserSessionId: p.scoped.browserSessionId, selector: '#place', tenantId: 'ten_av', ownerId: 'usr_av', requestId: 'req_av_exec' });
      assert.equal(done.status, 'EXECUTED');
      assert.deepEqual([done.verification?.outcome, done.verification?.retrySafe, done.verification?.sideEffectPossible], ['NOT_VERIFIED', false, true]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(orders, ordersBefore + 1);
      const record = p.executions.list().find((e) => e.approvalId === approvalId)!;
      assert.deepEqual([record.status, record.verificationOutcome], ['SUCCEEDED', 'NOT_VERIFIED']);
      assert.ok(audits.some((a) => a.action === 'tool.execution.succeeded' && (a.details as any)?.verificationOutcome === 'NOT_VERIFIED' && (a.details as any)?.consequential === true));
      await assert.rejects(() => p.service.executeApprovedClick({ approvalId, browserSessionId: p.scoped.browserSessionId, selector: '#place', tenantId: 'ten_av', ownerId: 'usr_av', requestId: 'req_av_exec2' }), 'the approval is consumed once');
      assert.equal(orders, ordersBefore + 1, 'no duplicate side effect');
    } finally { await p.close(); }
  });
});

// ---------------------------------------------------------------------------------------------------- the Agent loop

class Scripted implements VisualExecutionModelPort {
  public proposals = 0;
  public readonly seen: ProposeNextActionInput[] = [];
  constructor(private readonly pagePath: string, private readonly policy: (n: number, ctx: ProposeNextActionInput) => ProposedDeviceAction | undefined) {}
  public async proposeNextAction(ctx: ProposeNextActionInput): Promise<ProposedDeviceAction> {
    this.seen.push(ctx);
    const n = this.proposals++;
    if (n === 0) return { action: 'NAVIGATE', value: base + this.pagePath };
    const next = this.policy(n - 1, ctx);
    if (!next) throw new Error('script exhausted');
    return next;
  }
}
const A = (action: ProposedDeviceAction['action'], selector?: string, extra: Partial<ProposedDeviceAction> = {}): ProposedDeviceAction => ({ action, ...(selector ? { target: { selector } } : {}), ...extra });

async function runAgent(pagePath: string, policy: (n: number, ctx: ProposeNextActionInput) => ProposedDeviceAction | undefined, options: { approve?: boolean; maxSteps?: number } = {}) {
  const { service: browser } = rig();
  const deviceSessions = new DeviceExecutionSessionStore({ dir: fs.mkdtempSync(path.join(tmp, 'device-')) });
  const model = new Scripted(pagePath, policy);
  const agent = new DeviceControlService(deviceSessions, browser, model);
  const ident = { tenantId: 'ten_av', ownerId: 'usr_av' };
  let outcome = await agent.startSession({ ...ident, requestId: `req_agent_${++counter}`, goal: 'test', allowedDomains: ['127.0.0.1'], maxSteps: options.maxSteps ?? 20, maxDurationMs: 120_000 });
  let approvals = 0;
  while (outcome.kind === 'WAITING_APPROVAL' && options.approve) {
    browser.approve(outcome.approval.approvalId, ident.tenantId, ident.ownerId, 'req_agent_approve');
    approvals++;
    outcome = await agent.resumeSession({ ...ident, requestId: `req_agent_resume_${++counter}`, deviceExecutionSessionId: outcome.deviceExecutionSessionId, approvalId: outcome.approval.approvalId });
  }
  const record = 'deviceExecutionSessionId' in outcome ? deviceSessions.getOwned(outcome.deviceExecutionSessionId, ident.tenantId, ident.ownerId) : null;
  return { outcome, model, approvals, steps: record?.stepCount ?? null };
}
const completion = (o: Awaited<ReturnType<typeof runAgent>>['outcome']) => (o.kind === 'COMPLETED' ? (o.result as any).completion : null);

describe('the Agent loop: no false success, no endless loop, bounded recovery, approval untouched', () => {
  it('a task that really succeeded is COMPLETED and VERIFIED', async () => {
    const r = await runAgent('/form-ok', (n) => [A('TYPE', '#name', { value: 'Alice' }), A('CLICK', '#apply'), A('STOP', undefined, { expectedResult: 'saved' })][n]);
    assert.equal(r.outcome.kind, 'COMPLETED');
    assert.deepEqual([completion(r.outcome).outcome, completion(r.outcome).basis, completion(r.outcome).modelClaim], ['VERIFIED', ['SUCCESS_MESSAGE'], 'saved']);
  });

  it('the model says "done" but the page shows a validation error or a server error: the session FAILS and says why - never COMPLETED', async () => {
    for (const [pagePath, reason] of [['/form-invalid', 'VALIDATION_ERROR'], ['/form-error', 'ERROR_MESSAGE']] as const) {
      const r = await runAgent(pagePath, (n) => [A('CLICK', '#apply'), A('STOP', undefined, { expectedResult: 'submitted' })][n]);
      assert.equal(r.outcome.kind, 'TERMINATED', pagePath);
      assert.equal((r.outcome as any).terminationReason, `DEVICE_STOP_CONTRADICTED_BY_EVIDENCE:${reason}`);
    }
  });

  it('the model says "done" after a click that changed nothing: COMPLETED is not claimed as success - the verdict is NOT_VERIFIED', async () => {
    const r = await runAgent('/nochange', (n) => [A('CLICK', '#r'), A('STOP', undefined, { expectedResult: 'list refreshed' })][n]);
    assert.equal(r.outcome.kind, 'COMPLETED');
    assert.deepEqual([completion(r.outcome).outcome, completion(r.outcome).basis], ['NOT_VERIFIED', ['NO_OBSERVABLE_CHANGE']]);
    const onlyLooked = await runAgent('/nochange', (n) => [A('OBSERVE'), A('STOP', undefined, { expectedResult: 'looked' })][n]);
    assert.deepEqual([completion(onlyLooked.outcome).outcome, completion(onlyLooked.outcome).basis], ['NOT_VERIFIED', ['NO_ACTION_TAKEN']]);
  });

  it('the same useless click proposed again and again is stopped on the third try with a readable reason (not after the whole step budget), and the model is warned first', async () => {
    const r = await runAgent('/loop', () => A('CLICK', '#more'));
    assert.equal(r.outcome.kind, 'TERMINATED');
    assert.equal((r.outcome as any).terminationReason, 'DEVICE_REPEATED_ACTION_LOOP:CLICK:#more');
    assert.equal(r.steps, 4, 'navigate + three identical clicks');
    const warned = r.model.seen[r.model.seen.length - 1].priorActions.map((p) => p.outcome).join('\n');
    assert.match(warned, /already tried on this same page without progress/);
  });

  it('legitimate repeats are not stopped: ten "Next" clicks, each on a different page state', async () => {
    const r = await runAgent('/pagination', (n) => (n < 10 ? A('CLICK', '#next') : A('STOP', undefined, { expectedResult: 'page 11' })), { maxSteps: 20 });
    assert.equal(r.outcome.kind, 'COMPLETED');
    assert.equal(r.steps, 11);
  });

  it('a stale target is handed back to the model, which re-reads the page and chooses again; three failures in a row end the session with the real reason', async () => {
    const r = await runAgent('/stale', (n, ctx) => {
      if (n === 0) return A('CLICK', '#gone');
      if (n === 1) { const b = (ctx.structuredSnapshot.buttons || []).find((x) => /continue/i.test(x.text)); return A('CLICK', `#${b?.id ?? 'b'}`); }
      return A('STOP', undefined, { expectedResult: 'continued' });
    });
    assert.equal(r.outcome.kind, 'COMPLETED');
    const feedback = r.model.seen[2].priorActions[1].outcome; // proposal 0 = navigate, 1 = the stale click
    assert.match(r.model.seen[2].priorActions.map((p) => p.outcome).join('\n'), /FAILED: BROWSER_SELECTOR_NOT_FOUND[^\n]*Read the page again/);
    assert.ok(feedback);
    const exhausted = await runAgent('/stale', (n) => A('CLICK', `#gone${n}`));
    assert.equal(exhausted.outcome.kind, 'TERMINATED');
    assert.equal((exhausted.outcome as any).terminationReason, 'DEVICE_RECOVERY_EXHAUSTED:BROWSER_SELECTOR_NOT_FOUND');
    assert.equal(exhausted.steps, 4, 'navigate + three failed clicks, then stop');
  });

  it('recovery never bypasses approval: a consequential click proposed after a failure still waits for a human, and runs once only when approved', async () => {
    const ordersBefore = orders;
    const script = (n: number) => [A('CLICK', '#gone'), A('CLICK', '#buy'), A('STOP', undefined, { expectedResult: 'ordered' })][n];
    const waiting = await runAgent('/approval', script, { approve: false });
    assert.equal(waiting.outcome.kind, 'WAITING_APPROVAL');
    assert.equal(orders, ordersBefore, 'nothing was ordered while waiting');
    const approved = await runAgent('/approval', script, { approve: true });
    assert.equal(approved.approvals, 1);
    assert.equal(approved.outcome.kind, 'COMPLETED');
    assert.deepEqual([completion(approved.outcome).outcome, completion(approved.outcome).basis], ['VERIFIED', ['SUCCESS_MESSAGE']]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(orders, ordersBefore + 1, 'exactly one order');
  });

  it('an approved consequential click whose result cannot be seen is COMPLETED but NOT_VERIFIED, and a model that wants to click again needs a fresh approval', async () => {
    const ordersBefore = orders;
    const r = await runAgent('/unknown', (n) => [A('CLICK', '#place'), A('STOP', undefined, { expectedResult: 'order placed' })][n], { approve: true });
    assert.equal(r.outcome.kind, 'COMPLETED');
    assert.deepEqual([completion(r.outcome).outcome, completion(r.outcome).basis], ['NOT_VERIFIED', ['NO_OBSERVABLE_CHANGE']]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(orders, ordersBefore + 1);
    const again = await runAgent('/unknown', (n) => [A('CLICK', '#place'), A('CLICK', '#place')][n], { approve: false });
    assert.equal(again.outcome.kind, 'WAITING_APPROVAL', 'the first click asks');
  });

  it('the budgets are unchanged: a step budget still ends a session that only looks around', async () => {
    const r = await runAgent('/nochange', () => A('OBSERVE'), { maxSteps: 3 });
    assert.equal((r.outcome as any).terminationReason, 'DEVICE_MAX_STEPS_EXCEEDED');
  });
});
