// The deterministic parts of Universal Computer Use, without a browser: what "the page shows X" means, what counts as a loop, when "done" is believed, and which proposals are even valid.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchExpectation, numericValue, type ExpectationSurface } from '../src/modules/browser/expectation.js';
import { ActionLoopGuard, summarizeCompletion, type StepEvidence } from '../src/device-control/action-loop-guard.js';
import { isProposedDeviceAction } from '../src/device-control/device-action.types.js';
import { mapDeviceActionToRisk } from '../src/device-control/device-action-policy.js';
import { classifyClickConsequence } from '../src/modules/browser/browser.service.js';
import { validateProposal } from '../src/device-control/gateway-execution-model.adapter.js';
import { HybridExecutionModelAdapter } from '../src/device-control/hybrid-execution-model.adapter.js';
import type { ProposeNextActionInput } from '../src/device-control/visual-execution-model.port.js';

const page = (...texts: string[]): ExpectationSurface => ({ found: true, texts, truncated: false });

describe('what "the page shows it" means', () => {
  it('a labelled value matches however the page writes the number (currency marks, thousands separators, spacing, case)', () => {
    const invoice = page('Subtotal: ₩1,000,000 Tax (10%): ₩100,000 Total: ₩1,100,000', 'Customer: Hanbit Trading Co. (123-45-67890)');
    assert.deepEqual(matchExpectation('Total: 1,100,000', invoice), { found: true, as: 'TEXT' });
    assert.deepEqual(matchExpectation('total : 1100000', invoice), { found: true, as: 'TEXT' });
    assert.deepEqual(matchExpectation('hanbit trading co.', invoice), { found: true, as: 'TEXT' });
    assert.deepEqual(matchExpectation('Total: ₩1,100,000원', invoice), { found: true, as: 'TEXT' });
  });

  it('a wrong value is NOT confused with another number on the page: "Total" is not inside "Subtotal", 1,100,000 is not inside 11,000,000', () => {
    const invoice = page('Subtotal: ₩1,000,000 Total: ₩1,100,000');
    assert.deepEqual(matchExpectation('Total: 1,000,000', invoice), { found: false }, 'the subtotal is not the total');
    assert.deepEqual(matchExpectation('Total: 1,100,00', invoice), { found: false }, 'a prefix of a number is not that number');
    assert.deepEqual(matchExpectation('Total: 11,000,000', invoice), { found: false });
    assert.deepEqual(matchExpectation('Total: 1,100,000', page('Total: 11,000,000')), { found: false }, 'nor is a shorter number inside a longer one');
    assert.deepEqual(matchExpectation('Total: 1,100,000', page('Total: 1,100,000.50')), { found: false }, 'nor 1,100,000 inside 1,100,000.50');
  });

  it('a bare number matches only a standalone number of that value; an identifier that contains it does not count', () => {
    assert.deepEqual(matchExpectation('1,100,000', page('Total ₩1,100,000')), { found: true, as: 'NUMBER' });
    assert.deepEqual(matchExpectation('1100000.00', page('Total ₩1,100,000')), { found: true, as: 'NUMBER' });
    assert.deepEqual(matchExpectation('1100000', page('Invoice #1100000')), { found: false });
    assert.deepEqual(matchExpectation('1100000', page('Ref A1100000')), { found: false });
    assert.deepEqual(matchExpectation('1100000', page('Total 11000000')), { found: false });
  });

  it('Korean text, an absent page and an empty expectation', () => {
    assert.deepEqual(matchExpectation('초안 저장', page('현재 상태: 초안 저장됨')), { found: true, as: 'TEXT' });
    assert.deepEqual(matchExpectation('anything', { found: false, texts: [], truncated: false }), { found: false });
    assert.deepEqual(matchExpectation('   ', page('x')), { found: false });
    assert.equal(numericValue('₩1,100,000원'), 1100000);
    assert.equal(numericValue('Total'), null);
  });
});

describe('a loop is a loop, and "done" has to be backed by evidence', () => {
  const step = (over: Partial<StepEvidence>): StepEvidence => ({ action: 'TYPE', signature: 'TYPE|#a|x', stateKey: 's1', outcome: 'VERIFIED', basis: [], mutating: true, ...over });

  it('the same field written again on an unchanged page is a loop even though each write "verifies"; a verified click that paged on is not', () => {
    const guard = new ActionLoopGuard();
    assert.equal(guard.record(step({})).loop, false);
    assert.equal(guard.record(step({})).loop, false);
    assert.equal(guard.record(step({})).loop, true, 'the 3rd identical write');
    const clicks = new ActionLoopGuard();
    for (let i = 0; i < 4; i += 1) assert.equal(clicks.record(step({ action: 'CLICK', signature: 'CLICK|#next|', outcome: 'VERIFIED' })).loop, false, 'paging forward is progress');
    const checks = new ActionLoopGuard();
    checks.record(step({ action: 'VERIFY', signature: 'VERIFY||Total', mutating: false }));
    checks.record(step({ action: 'VERIFY', signature: 'VERIFY||Total', mutating: false }));
    assert.equal(checks.record(step({ action: 'VERIFY', signature: 'VERIFY||Total', mutating: false })).loop, true, 'asking the same question of an unchanged page again and again is a loop');
  });

  it('an expectation the page does not show contradicts "done"; one it shows backs it; the counts are reported', () => {
    const typed = step({ outcome: 'VERIFIED', basis: ['FIELD_VALUE_MATCHED'] });
    const shown = step({ action: 'VERIFY', signature: 'v1', mutating: false, outcome: 'VERIFIED' });
    const notShown = step({ action: 'VERIFY', signature: 'v2', mutating: false, outcome: 'FAILED' });
    const clicked = step({ action: 'CLICK', signature: 'c', outcome: 'NOT_VERIFIED', basis: ['DOM_CHANGED_ONLY'] });

    assert.equal(summarizeCompletion([typed, notShown]).outcome, 'FAILED', 'a failed check after the last change');
    assert.deepEqual(summarizeCompletion([typed, notShown]).basis, ['EXPECTATION_NOT_MET']);
    assert.equal(summarizeCompletion([typed, shown]).outcome, 'VERIFIED');
    assert.equal(summarizeCompletion([typed, clicked, shown]).outcome, 'VERIFIED', 'a shown expectation backs a click that was only "DOM changed"');
    assert.equal(summarizeCompletion([typed, clicked]).outcome, 'NOT_VERIFIED', 'without the check the click stays unverified');
    // a failed check that was followed by a change is not the last word: the correction is judged by what comes after
    assert.equal(summarizeCompletion([typed, notShown, step({ outcome: 'VERIFIED' })]).outcome, 'VERIFIED');
    const counts = summarizeCompletion([typed, shown, notShown, shown]);
    assert.deepEqual([counts.expectationsMet, counts.expectationsNotMet], [2, 1]);
    // only looking and checking: the check alone is the evidence
    assert.equal(summarizeCompletion([shown]).outcome, 'VERIFIED');
    assert.equal(summarizeCompletion([]).outcome, 'NOT_VERIFIED');
  });
});

describe('the action vocabulary', () => {
  it('SELECT, WAIT, VERIFY and STOP carry exactly what they need - nothing is guessed', () => {
    assert.ok(isProposedDeviceAction({ action: 'SELECT', target: { selector: '#tax' }, value: '10' }));
    assert.ok(!isProposedDeviceAction({ action: 'SELECT', target: { selector: '#tax' } }), 'choosing nothing is not a choice');
    assert.ok(!isProposedDeviceAction({ action: 'SELECT', value: '10' }), 'a choice needs a control');
    assert.ok(isProposedDeviceAction({ action: 'WAIT', value: '300' }));
    for (const bad of ['0', '99', '5001', '300ms', '', '-5', '1e3']) assert.ok(!isProposedDeviceAction({ action: 'WAIT', value: bad }), `WAIT ${bad}`);
    assert.ok(!isProposedDeviceAction({ action: 'WAIT' }));
    assert.ok(isProposedDeviceAction({ action: 'VERIFY', value: 'Total: 1,100,000' }));
    assert.ok(isProposedDeviceAction({ action: 'VERIFY', value: 'Total', target: { selector: '#total' } }));
    assert.ok(!isProposedDeviceAction({ action: 'VERIFY', value: '   ' }));
    assert.ok(!isProposedDeviceAction({ action: 'VERIFY', value: 'x'.repeat(301) }));
    assert.ok(isProposedDeviceAction({ action: 'STOP' }) && isProposedDeviceAction({ action: 'STOP', value: 'DONE' }) && isProposedDeviceAction({ action: 'STOP', value: 'BLOCKED' }));
    assert.ok(!isProposedDeviceAction({ action: 'STOP', value: 'RUN_SCRIPT' }));
    for (const forbidden of ['RUN_SCRIPT', 'EVALUATE', 'SHELL', 'UPLOAD_FILE', 'DOWNLOAD']) assert.ok(!isProposedDeviceAction({ action: forbidden, value: 'x' }), forbidden);
  });

  it('risk: choosing an option is like typing; waiting and checking only look', () => {
    assert.deepEqual(mapDeviceActionToRisk('SELECT'), mapDeviceActionToRisk('TYPE'));
    assert.deepEqual(mapDeviceActionToRisk('WAIT'), { risk: 'READ_ONLY', approval: 'NONE' });
    assert.deepEqual(mapDeviceActionToRisk('VERIFY'), { risk: 'READ_ONLY', approval: 'NONE' });
  });

  it('issuing wording is consequential as whole words (Issue invoice, Approve, 발행하기) and ordinary words are not (Issues, tissue, executive summary)', () => {
    for (const label of ['Issue invoice', 'Approve', 'Authorize payment', 'Execute trade', 'Finalise order', 'Withdraw funds', '발행하기', '세금계산서 발급']) assert.equal(classifyClickConsequence(label, false), true, label);
    for (const label of ['Issues', 'tissue box', 'executive summary', 'Open help', 'Next', 'Back to edit', 'Save draft']) assert.equal(classifyClickConsequence(label, false), false, label);
  });
});

describe('the planner adapter validates what a model proposes', () => {
  const input = (over: Partial<ProposeNextActionInput> = {}): ProposeNextActionInput => ({
    tenantId: 't', ownerId: 'o', goal: 'g', screenshotRef: null, allowedDomains: ['example.com'], riskCeiling: 'CONSEQUENTIAL', stepNumber: 1, remainingSteps: 9, priorActions: [], requestId: 'r',
    allowedActions: ['NAVIGATE', 'CLICK', 'TYPE', 'VERIFY', 'STOP'],
    structuredSnapshot: { url: 'https://example.com/', title: 't', text: 'x', links: [], buttons: [], inputs: [], forms: [], interactive: [{ index: 0, role: 'button', name: 'Go', selector: '#go', enabled: true }], trust: {} as any },
    ...over,
  });

  it('accepts a good proposal (also fenced, also with the action in lower case) and rejects everything else with a reason the model is shown', () => {
    assert.deepEqual(validateProposal('{"action":"CLICK","target":{"selector":"#go"}}', input()), { action: 'CLICK', target: { selector: '#go' } });
    assert.equal(validateProposal('```json\n{"action":"verify","value":"Total: 1"}\n```', input()).action, 'VERIFY');
    assert.throws(() => validateProposal('not json', input()), /valid JSON/);
    assert.throws(() => validateProposal('{"nothing":1}', input()), /no "action"/);
    assert.throws(() => validateProposal('{"action":"CLICK","target":{"selector":"#missing"}}', input()), /not in ELEMENTS/);
    assert.throws(() => validateProposal('{"action":"CLICK"}', input()), /complete action/);
    assert.throws(() => validateProposal('{"action":"SCROLL","value":"down"}', input()), /not allowed/);
    assert.throws(() => validateProposal('{"action":"RUN_SCRIPT","value":"x"}', input()), /complete action|not allowed/);
    assert.throws(() => validateProposal('{"action":"NAVIGATE"}', input()), /complete action/);
  });
});

describe('which planner reads the screen', () => {
  const snapshot = (n: number) => ({ url: 'https://example.com/', title: 't', text: 'x', links: [], buttons: [], inputs: [], forms: [], interactive: Array.from({ length: n }, (_, i) => ({ index: i, role: 'button', name: 'b' + i, selector: '#b' + i, enabled: true })), trust: {} as any });
  const base = (n: number): ProposeNextActionInput => ({ tenantId: 't', ownerId: 'o', goal: 'g', screenshotRef: 'ev_1', allowedActions: ['OBSERVE'], allowedDomains: [], riskCeiling: 'CONSEQUENTIAL', stepNumber: 1, remainingSteps: 9, priorActions: [], requestId: 'r', structuredSnapshot: snapshot(n) as any });

  it('semantic first; a screenshot-reading planner only when there is nothing to act on or the DOM planner failed; every switch is reported', async () => {
    const calls: string[] = [];
    const events: string[] = [];
    const dom = { proposeNextAction: async () => { calls.push('dom'); return { action: 'OBSERVE' } as const; } };
    const vision = { proposeNextAction: async () => { calls.push('vision'); return { action: 'OBSERVE' } as const; } };
    const both = new HybridExecutionModelAdapter({ dom, vision, onFallback: (e) => events.push(e.reason) });
    await both.proposeNextAction(base(3));
    await both.proposeNextAction(base(0));
    assert.deepEqual(calls, ['dom', 'vision']);
    assert.deepEqual(events, ['NO_ACTIONABLE_STRUCTURE']);

    const failing = new HybridExecutionModelAdapter({ dom: { proposeNextAction: async () => { throw new Error('model outage'); } }, vision, onFallback: (e) => events.push(e.reason) });
    await failing.proposeNextAction(base(3));
    assert.equal(events.at(-1), 'DOM_PLANNER_FAILED');
    const noShot = new HybridExecutionModelAdapter({ dom: { proposeNextAction: async () => { throw new Error('model outage'); } }, vision });
    await assert.rejects(() => noShot.proposeNextAction({ ...base(3), screenshotRef: null }), /model outage/, 'without a screenshot there is nothing to fall back to');

    assert.deepEqual(new HybridExecutionModelAdapter({ dom }).status(), { configured: true, dom: true, vision: false });
    assert.equal(new HybridExecutionModelAdapter({}).status().configured, false);
    await assert.rejects(() => new HybridExecutionModelAdapter({}).proposeNextAction(base(1)), /No execution planner/);
  });
});
