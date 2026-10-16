// DecisionPort / JEV advisory (Universal AI Device Control amendment): an OPTIONAL, REPLACEABLE, ADVISORY second opinion for the browser loop - and the proof that it can only ever ADD caution.
//
//   unit  : advice is validated whole (unknown / not-offered ids, out-of-range numbers, unknown enumerations, self-contradiction are rejected); what advice may change is a short, closed list of
//           tightenings; the advisor falls back to "no advice" on every failure and stops asking a provider that keeps failing; the JEV adapter speaks the System One shape the repository already
//           uses and sends nothing but enumerated facts.
//   E2E   : in REAL Chromium against the invoice back-office, with the real loop and a SIMULATED provider - advice cannot allow what the policy denies, a provider outage changes nothing, a handoff
//           stops before anything is touched, an escalation holds a benign click for approval, and nothing about the person's goal or the page ever reaches the provider.
//
// HONEST SCOPE: no live JEV call was made (no credential available). The four questions asked of JEV for this loop are NAgex's own; the request and answer SHAPE is the one the repository already uses
// for JEV System One. A live run is a separate, explicit step. Deterministic flows never need JEV: every other suite runs with the advisor absent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { ActionApprovalStore } from '../src/governance/action-approval.store.js';
import { AuditLogger } from '../src/governance/audit.logger.js';
import { MemoryEngine } from '../src/context/memory.engine.js';
import { BrowserSessionStore } from '../src/modules/browser/browser-session.store.js';
import { PlaywrightBrowserRuntime } from '../src/modules/browser/browser.runtime.js';
import { BrowserToolService } from '../src/modules/browser/browser.service.js';
import { DeviceControlService, type DeviceControlOutcome } from '../src/device-control/device-control.service.js';
import { DeviceExecutionSessionStore } from '../src/device-control/device-execution-session.store.js';
import { DecisionAdvisor, advisoryEffect, normalizeAdvice, type DecisionAdvice, type DecisionPort, type DecisionRequest } from '../src/device-control/decision-port.js';
import { JevDecisionPort, buildJevDecisionBody } from '../src/device-control/jev-decision.adapter.js';
import { startInvoiceApp, type InvoiceApp } from './_invoice_app.js';
import { InvoiceStandInPlanner } from './_invoice_planner.js';

const REQUEST: DecisionRequest = {
  stepNumber: 3, remainingSteps: 17, proposed: { action: 'CLICK', targetRole: 'button', formControl: false }, candidates: ['PROCEED', 'OBSERVE', 'WAIT', 'HANDOFF'],
  recent: [{ action: 'TYPE', outcome: 'VERIFIED' }, { action: 'CLICK', outcome: 'NOT_VERIFIED' }], repeats: 0, expectationsMet: 1, expectationsNotMet: 0,
};
const ADVICE = { recommendedActionId: 'PROCEED', actionConfidence: 0.9, riskProbability: 0.1, retryRecommendation: 'CONTINUE', completionAssessment: 'INCOMPLETE', decisionReasonCode: 'ROUTINE' };
const reasonOf = (raw: unknown, request: DecisionRequest = REQUEST): string => { const n = normalizeAdvice(raw, request); return n.ok ? 'OK' : n.reason; };

describe('advice is validated whole - anything off is rejected, never repaired or half-used', () => {
  it('accepts a well-formed answer and derives the escalation from the probability, not from the provider\'s say-so', () => {
    const ok = normalizeAdvice(ADVICE, REQUEST);
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.advice.riskEscalation, false);
    const risky = normalizeAdvice({ ...ADVICE, riskProbability: 0.7 }, REQUEST);
    assert.equal(risky.ok && risky.advice.riskEscalation, true);
    assert.equal(normalizeAdvice({ ...ADVICE, riskProbability: null }, REQUEST).ok, true, 'no risk estimate is allowed (and means no escalation)');
    // a provider cannot set the flag itself
    const forged = normalizeAdvice({ ...ADVICE, riskEscalation: true, approved: true, allow: true, override: 'ALLOW' }, REQUEST);
    assert.equal(forged.ok && forged.advice.riskEscalation, false);
    assert.ok(forged.ok && !('approved' in forged.advice) && !('allow' in forged.advice) && !('override' in forged.advice), 'unknown fields are dropped');
  });

  it('rejects: not an object, unknown action id, an id that was not offered, bad numbers, unknown enumerations, self-contradiction', () => {
    assert.equal(reasonOf(null), 'NOT_AN_OBJECT');
    assert.equal(reasonOf('PROCEED'), 'NOT_AN_OBJECT');
    assert.equal(reasonOf([ADVICE]), 'NOT_AN_OBJECT');
    assert.equal(reasonOf({ ...ADVICE, recommendedActionId: 'ISSUE_INVOICE' }), 'UNKNOWN_ACTION_ID');
    assert.equal(reasonOf({ ...ADVICE, recommendedActionId: 'rm -rf' }), 'UNKNOWN_ACTION_ID');
    assert.equal(reasonOf({ ...ADVICE, recommendedActionId: undefined }), 'UNKNOWN_ACTION_ID');
    assert.equal(reasonOf({ ...ADVICE, recommendedActionId: 'WAIT' }, { ...REQUEST, candidates: ['PROCEED', 'HANDOFF'] }), 'ACTION_NOT_OFFERED');
    for (const bad of [1.5, -0.1, Number.NaN, '0.9', null, undefined]) assert.equal(reasonOf({ ...ADVICE, actionConfidence: bad }), 'BAD_CONFIDENCE', String(bad));
    for (const bad of [2, -1, '0.5', Number.POSITIVE_INFINITY]) assert.equal(reasonOf({ ...ADVICE, riskProbability: bad }), 'BAD_RISK', String(bad));
    assert.equal(reasonOf({ ...ADVICE, retryRecommendation: 'FORCE' }), 'BAD_RETRY');
    assert.equal(reasonOf({ ...ADVICE, completionAssessment: 'DONE' }), 'BAD_COMPLETION');
    assert.equal(reasonOf({ ...ADVICE, decisionReasonCode: 'BECAUSE' }), 'BAD_REASON');
    assert.equal(reasonOf({ ...ADVICE, recommendedActionId: 'HANDOFF', retryRecommendation: 'CONTINUE' }), 'INCONSISTENT');
    assert.equal(reasonOf({ ...ADVICE, recommendedActionId: 'PROCEED', retryRecommendation: 'ABORT', actionConfidence: 0.95 }), 'INCONSISTENT');
  });
});

describe('what advice may change: only additions of caution', () => {
  const click = { action: 'CLICK' as const, target: { selector: '#go' } };
  const type = { action: 'TYPE' as const, target: { selector: '#f' }, value: 'x' };
  const adviceWith = (patch: Record<string, unknown>): DecisionAdvice => { const n = normalizeAdvice({ ...ADVICE, ...patch }, REQUEST); assert.ok(n.ok); return (n as { advice: DecisionAdvice }).advice; };

  it('"proceed", with any confidence and any completion claim, changes nothing - it cannot remove a check', () => {
    for (const confidence of [0, 0.5, 0.99, 1]) for (const completion of ['COMPLETE', 'INCOMPLETE', 'UNKNOWN']) {
      assert.deepEqual(advisoryEffect(adviceWith({ actionConfidence: confidence, completionAssessment: completion, riskProbability: 0 }), click), { forceApproval: false, handoff: false });
    }
    assert.deepEqual(advisoryEffect(null, click), { forceApproval: false, handoff: false });
  });

  it('a high risk estimate holds a CLICK for approval (and nothing else); a confident hand-over or abort hands the task to the person; a weak one does nothing', () => {
    assert.deepEqual(advisoryEffect(adviceWith({ riskProbability: 0.95 }), click), { forceApproval: true, handoff: false });
    assert.deepEqual(advisoryEffect(adviceWith({ riskProbability: 0.95 }), type), { forceApproval: false, handoff: false }, 'typing has no approval path to add');
    assert.deepEqual(advisoryEffect(adviceWith({ recommendedActionId: 'HANDOFF', retryRecommendation: 'TAKEOVER', actionConfidence: 0.9 }), click), { forceApproval: false, handoff: true });
    assert.deepEqual(advisoryEffect(adviceWith({ retryRecommendation: 'ABORT', recommendedActionId: 'OBSERVE', actionConfidence: 0.85 }), type), { forceApproval: false, handoff: true });
    assert.deepEqual(advisoryEffect(adviceWith({ recommendedActionId: 'HANDOFF', retryRecommendation: 'TAKEOVER', actionConfidence: 0.5 }), click), { forceApproval: false, handoff: false });
  });
});

describe('the advisor: disabled, slow, down, wrong - always "no advice"', () => {
  const portWith = (impl: () => Promise<unknown>, configured = true): DecisionPort & { calls: number } => {
    const port = { provider: 'sim', calls: 0, configured: () => configured, advise: async () => { port.calls += 1; return impl(); } };
    return port;
  };

  it('without a provider, or one without credentials, nothing is called', async () => {
    assert.deepEqual(await new DecisionAdvisor(null).consult('s', REQUEST), { status: 'DISABLED', advice: null });
    const unconfigured = portWith(async () => ADVICE, false);
    assert.equal((await new DecisionAdvisor(unconfigured).consult('s', REQUEST)).status, 'DISABLED');
    assert.equal(unconfigured.calls, 0);
    let fetched = 0;
    const jev = new JevDecisionPort({ fetchFn: (async () => { fetched += 1; return new Response('{}'); }) as never });
    assert.equal(jev.configured(), false);
    assert.equal((await new DecisionAdvisor(jev).consult('s', REQUEST)).status, 'DISABLED');
    assert.equal(fetched, 0, 'a provider with no key is never contacted');
  });

  it('a provider that is slow, throws, or answers nonsense gives no advice - and after two failures in a session it is not asked again', async () => {
    const slow = portWith(() => new Promise(() => undefined));
    const advisor = new DecisionAdvisor(slow, { timeoutMs: 60, maxConsecutiveFailures: 2 });
    assert.equal((await advisor.consult('a', REQUEST)).status, 'UNAVAILABLE');
    assert.equal((await advisor.consult('a', REQUEST)).status, 'UNAVAILABLE');
    assert.equal((await advisor.consult('a', REQUEST)).status, 'CIRCUIT_OPEN');
    assert.equal(slow.calls, 2, 'the third question was never sent');
    assert.equal((await advisor.consult('b', REQUEST)).status, 'UNAVAILABLE', 'another session starts fresh');
    advisor.forget('a');
    assert.equal((await advisor.consult('a', REQUEST)).status, 'UNAVAILABLE', 'forgotten sessions start fresh');

    const down = new DecisionAdvisor(portWith(async () => { throw new Error('ECONNRESET'); }));
    assert.equal((await down.consult('s', REQUEST)).status, 'UNAVAILABLE');
    const nonsense = new DecisionAdvisor(portWith(async () => ({ recommendedActionId: 'DESTROY' })));
    assert.deepEqual(await nonsense.consult('s', REQUEST), { status: 'INVALID', advice: null });
    const good = new DecisionAdvisor(portWith(async () => ADVICE));
    const ok = await good.consult('s', REQUEST);
    assert.equal(ok.status, 'OK');
    assert.equal(ok.advice?.recommendedActionId, 'PROCEED');
  });

  it('a success resets the count: occasional failures never open the circuit', async () => {
    let n = 0;
    const flaky = portWith(async () => { n += 1; if (n % 2 === 1) throw new Error('blip'); return ADVICE; });
    const advisor = new DecisionAdvisor(flaky, { timeoutMs: 500, maxConsecutiveFailures: 2 });
    for (let i = 0; i < 6; i += 1) assert.notEqual((await advisor.consult('s', REQUEST)).status, 'CIRCUIT_OPEN');
  });
});

describe('the JEV adapter: the System One shape, enumerated facts only', () => {
  const simulatedJev = (answers: Record<string, unknown>, seen: Array<{ url: string; auth: string; body: any }> = []): typeof fetch => (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), auth: String((init?.headers as Record<string, string>).Authorization), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ model: 'jev-latest', resolved_model: 'jev-sim', answers }), { status: 200 });
  }) as typeof fetch;

  it('asks exactly four questions of the two answer types the repository already uses (choice, noul), with the offered ids as the only choices, and nothing free-form', async () => {
    const seen: Array<{ url: string; auth: string; body: any }> = [];
    const port = new JevDecisionPort({ apiKey: 'k_test', fetchFn: simulatedJev({ action: { choice: 'PROCEED', confidence: 0.9 }, risk: { probability: 0.2 }, retry: { choice: 'CONTINUE' }, completion: { choice: 'INCOMPLETE' } }, seen) });
    const raw = await port.advise(REQUEST, new AbortController().signal);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://jevmodel.org/v1/systemone');
    assert.equal(seen[0].auth, 'Bearer k_test');
    assert.deepEqual(Object.keys(seen[0].body.questions).sort(), ['action', 'completion', 'retry', 'risk']);
    assert.deepEqual(Object.values(seen[0].body.questions).map((q: any) => q.type).sort(), ['choice', 'choice', 'choice', 'noul']);
    assert.deepEqual(seen[0].body.questions.action.choices, ['PROCEED', 'OBSERVE', 'WAIT', 'HANDOFF']);
    assert.equal(seen[0].body.model, 'jev-latest');
    // the raw answer is mapped onto NAgex's names and then validated like any other
    const advice = normalizeAdvice(raw, REQUEST);
    assert.ok(advice.ok);
    assert.equal(advice.ok && advice.advice.actionConfidence, 0.9);
    assert.equal(advice.ok && advice.advice.riskProbability, 0.2);
  });

  it('what is sent is only what a DecisionRequest can hold: enumerated kinds, counts and outcome categories', () => {
    const body = JSON.stringify(buildJevDecisionBody(REQUEST));
    const text = (buildJevDecisionBody(REQUEST).state as { text: Record<string, unknown> }).text;
    assert.deepEqual(Object.keys(text).sort(), ['changesAFormControl', 'checksFailed', 'checksPassed', 'proposedAction', 'recentOutcomes', 'remainingSteps', 'repeatsOnTheSamePage', 'stepNumber', 'targetRole', 'task']);
    assert.ok(body.length < 3000);
    for (const secret of ['password', 'http', 'cookie', 'token']) assert.ok(!body.toLowerCase().includes(secret), secret);
  });

  it('an error status, nonsense, or an unknown choice from the service becomes "no advice"', async () => {
    const http500 = new JevDecisionPort({ apiKey: 'k', fetchFn: (async () => new Response('x', { status: 500 })) as never });
    assert.equal((await new DecisionAdvisor(http500).consult('s', REQUEST)).status, 'UNAVAILABLE');
    const unknownChoice = new JevDecisionPort({ apiKey: 'k', fetchFn: simulatedJev({ action: { choice: 'ISSUE_INVOICE', confidence: 1 }, risk: { probability: 0 }, retry: { choice: 'CONTINUE' }, completion: { choice: 'COMPLETE' } }) });
    assert.equal((await new DecisionAdvisor(unknownChoice).consult('s', REQUEST)).status, 'INVALID');
    const empty = new JevDecisionPort({ apiKey: 'k', fetchFn: simulatedJev({}) });
    assert.equal((await new DecisionAdvisor(empty).consult('s', REQUEST)).status, 'INVALID');
  });
});

// ---- the real loop, in real Chromium, with a SIMULATED provider -------------------------------------------------------------------------------------------------------------------------------

describe('REAL Chromium: the invoice task with a provider that tries to loosen, fails, or is wrong', () => {
  const T = 'ten_dec';
  let O = 'usr_dec';
  let counter = 0;
  let runtime: PlaywrightBrowserRuntime;
  let browser: BrowserToolService;
  let sessions: DeviceExecutionSessionStore;
  const apps: InvoiceApp[] = [];
  beforeEach(() => { counter += 1; O = `usr_dec_${counter}`; });
  before(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nagex-dec-'));
    runtime = new PlaywrightBrowserRuntime(false, path.join(dir, 'profiles'));
    browser = new BrowserToolService(runtime, new BrowserSessionStore({ dir: path.join(dir, 'bs') }), new ActionApprovalStore(), new AuditLogger(), new MemoryEngine({ dir: path.join(dir, 'm') }));
    sessions = new DeviceExecutionSessionStore({ dir: path.join(dir, 'ds') });
  });
  after(async () => { await runtime.shutdown(); for (const a of apps) await a.close(); });

  const GOAL = 'Open the invoice system, select the customer Hanbit Trading Co., enter the supplied invoice information, verify the totals and prepare the invoice. Stop before issuing it.';
  const site = async (): Promise<InvoiceApp> => { const a = await startInvoiceApp(); apps.push(a); return a; };
  const run = (planner: InvoiceStandInPlanner, advisor: DecisionAdvisor | null, s: InvoiceApp): Promise<DeviceControlOutcome> =>
    new DeviceControlService(sessions, browser, planner, advisor).startSession({ tenantId: T, ownerId: O, requestId: 'req_dec', goal: GOAL, allowedDomains: [s.hostname], maxSteps: 45, maxDurationMs: 180_000 });
  const port = (answer: (request: DecisionRequest) => Promise<unknown>): DecisionPort & { requests: DecisionRequest[] } => {
    const p = { provider: 'sim', requests: [] as DecisionRequest[], configured: () => true, advise: async (request: DecisionRequest) => { p.requests.push(request); return answer(request); } };
    return p;
  };

  it('a provider that agrees with everything changes nothing: the same draft, nothing issued - and it is told nothing about the person, the page or the goal', async () => {
    const s = await site();
    const sim = port(async () => ({ ...ADVICE, riskProbability: 0.02 }));
    const outcome = await run(new InvoiceStandInPlanner(s.baseUrl, 'HAPPY'), new DecisionAdvisor(sim), s);
    assert.equal(outcome.kind, 'COMPLETED', JSON.stringify(outcome));
    assert.equal(s.state.issued.length, 0);
    assert.equal(s.state.drafts.size, 1);
    assert.ok(sim.requests.length >= 8, `it was consulted before the acting steps (${sim.requests.length})`);
    const sent = JSON.stringify(sim.requests);
    for (const secret of ['Hanbit', 'Consulting', 'Setup fee', 'invoice', '127.0.0.1', 'localhost', 'Total', 'customer', '2026-11-03', '300000']) assert.ok(!sent.includes(secret), `"${secret}" must never reach a decision provider`);
    assert.ok(sim.requests.every((r) => r.candidates.join() === 'PROCEED,OBSERVE,WAIT,HANDOFF'));
  });

  it('it cannot allow what the policy holds: a planner that goes for "Issue invoice" is held for approval whatever the provider says (full confidence, zero risk, "complete")', async () => {
    const s = await site();
    const sim = port(async () => ({ recommendedActionId: 'PROCEED', actionConfidence: 1, riskProbability: 0, retryRecommendation: 'CONTINUE', completionAssessment: 'COMPLETE', decisionReasonCode: 'ROUTINE' }));
    const outcome = await run(new InvoiceStandInPlanner(s.baseUrl, 'ISSUE_DIRECTLY'), new DecisionAdvisor(sim), s);
    assert.equal(outcome.kind, 'WAITING_APPROVAL', 'held for the person');
    assert.equal(s.state.issued.length, 0, 'nothing issued');
  });

  it('a high risk estimate holds a click that the policy would have let through - for approval, before the page is touched', async () => {
    const s = await site();
    const sim = port(async (request) => ({ ...ADVICE, riskProbability: request.proposed.action === 'CLICK' ? 0.95 : 0.1 }));
    const outcome = await run(new InvoiceStandInPlanner(s.baseUrl, 'HAPPY'), new DecisionAdvisor(sim), s);
    assert.equal(outcome.kind, 'WAITING_APPROVAL');
    assert.ok(!s.state.requests.some((r) => r.includes('/invoices/new')), 'the link was not followed: ' + s.state.requests.join(', '));
  });

  it('a confident hand-over ends the task as "a person needs to step in" before anything is touched', async () => {
    const s = await site();
    const sim = port(async () => ({ recommendedActionId: 'HANDOFF', actionConfidence: 0.95, riskProbability: 0.3, retryRecommendation: 'TAKEOVER', completionAssessment: 'UNKNOWN', decisionReasonCode: 'LOW_CONFIDENCE' }));
    const outcome = await run(new InvoiceStandInPlanner(s.baseUrl, 'HAPPY'), new DecisionAdvisor(sim), s);
    assert.equal(outcome.kind, 'TERMINATED');
    assert.equal((outcome as { status: string }).status, 'BLOCKED_NEEDS_HUMAN');
    assert.match(String((outcome as { terminationReason: string }).terminationReason), /decision helper advised that a person should take over/);
    assert.equal(s.state.requests.length, 0, 'the site was never contacted');
  });

  it('FALLBACK: a provider that is down, never answers, answers nonsense, or names an action that was never offered - the task completes exactly as without one', async () => {
    for (const [label, answer] of [
      ['down', async () => { throw new Error('ECONNREFUSED'); }],
      ['never answers', () => new Promise(() => undefined)],
      ['nonsense', async () => ({ hello: 'world' })],
      ['an action that was never offered', async () => ({ ...ADVICE, recommendedActionId: 'ISSUE_INVOICE' })],
      ['out of range', async () => ({ ...ADVICE, actionConfidence: 7 })],
    ] as Array<[string, () => Promise<unknown>]>) {
      const s = await site();
      counter += 1; O = `usr_dec_${counter}`;
      const sim = port(answer);
      const outcome = await run(new InvoiceStandInPlanner(s.baseUrl, 'HAPPY'), new DecisionAdvisor(sim, { timeoutMs: 150, maxConsecutiveFailures: 2 }), s);
      assert.equal(outcome.kind, 'COMPLETED', `${label}: ${JSON.stringify(outcome)}`);
      assert.equal(s.state.drafts.size, 1, label);
      assert.equal(s.state.issued.length, 0, label);
      assert.ok(sim.requests.length <= 2, `${label}: a failing provider is given up on (${sim.requests.length} asks)`);
    }
  });
});
