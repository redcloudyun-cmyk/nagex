// D-11 advisory plans. An advice-only request ("prepare a briefing", "what should I do next") may be answered with ADVICE (no steps) when - and only when - the PERSON's own words
// ask for advice and nothing to be done, the model declares it, and the suggestions are concrete. An action request with no steps stays rejected, an advisory answer is never a
// plan (no plan object, nothing to resolve, approve or run), and only the interactive Home route can ask for it. Fake provider endpoints only: this proves the contract,
// NOT that a real model answered (the real Nemotron runs are in docs/evidence/NAGEX_D11_ADVISORY_PLAN_CERT_20261014.md).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AiService } from '../src/model-gateway/ai-service.js';
import { classifyPlanRequest, isConcreteSuggestion } from '../src/model-gateway/plan-request-kind.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { NebiusProvider, GeminiProvider } from '../src/model-gateway/providers.js';
import { PlanResolver } from '../src/planning/plan-resolver.js';
import { skillRegistry } from '../src/skills/skill-registry.js';
import { toolRegistry } from '../src/tools/tool-registry.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';

const NEMOTRON = 'nvidia/Nemotron-3_5-Lightning';
const DEMO = "Prepare a concise briefing for tomorrow's meeting, use what you remember about this project, draft a one-page summary, and suggest the next action.";
const nebiusOk = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
const geminiOk = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200 });

const advice = (over: Record<string, unknown> = {}) => JSON.stringify({
  goal: 'Be ready for tomorrow\'s project review', summary: 'Tomorrow\'s review centers on the approval flow; lead with the status and decide the next milestone with the team.',
  reasoningSummary: 'The request asks for a briefing and a next action, nothing that must be executed.', responseKind: 'ADVISORY', steps: [],
  suggestions: ['Open the review by stating where the approval flow stands today.', 'Ask the design lead which open item blocks the next milestone.', 'Agree on one owner and a date for the next action before the meeting ends.'],
  ...over,
});
const actionPlan = JSON.stringify({ goal: 'g', summary: 'Create the requested calendar event only.', reasoningSummary: 'r', suggestions: [], steps: [{ title: 'Create event', reasoning: 'asked', skill: 'skill.scheduling', tool: 'google_calendar.create_event', requiresApproval: true, necessity: 'REQUIRED', dependsOn: [], parameters: {} }] });

function service(nebius: (body: any) => Response | Promise<Response>, gemini?: (body: any) => Response | Promise<Response>) {
  const seen: any[] = [];
  const providers = [
    new NebiusProvider({ apiKey: 'k', model: NEMOTRON, fetchFn: (async (_u: any, init: any) => { const body = JSON.parse(String(init?.body ?? '{}')); seen.push({ p: 'nebius', body }); return nebius(body); }) as typeof fetch }),
    ...(gemini ? [new GeminiProvider({ apiKey: 'o', model: 'gm', fetchFn: (async (_u: any, init: any) => { const body = JSON.parse(String(init?.body ?? '{}')); seen.push({ p: 'gemini', body }); return gemini(body); }) as typeof fetch })] : []),
  ];
  const router = new UnifiedModelRouter(providers, { info: () => {}, warn: () => {} });
  return { svc: new AiService(router), router, seen };
}
const plan = (svc: AiService, prompt: string, allowAdvisory?: boolean, conversation?: Array<{ role: 'user' | 'assistant'; content: string }>) =>
  svc.plan({ prompt, memories: [], mode: 'auto', requestId: 'r_adv', ...(allowAdvisory !== undefined ? { allowAdvisory } : {}), ...(conversation ? { conversation } : {}) });
const systemOf = (call: any): string => String((call.body.messages ?? []).find((m: any) => m.role === 'system')?.content ?? '');

describe('the request is classified from the person\'s words, fail-closed', () => {
  const advisory = [
    DEMO, 'What should I focus on this week?', 'Suggest the next action for the launch.', 'Help me think through the risks of this release.', 'Summarize where the project stands and recommend priorities.',
    'Prepare talking points for tomorrow\'s review.', '내일 회의 브리핑을 준비하고 다음 행동을 제안해줘.', '이번 주에 무엇을 해야 할지 조언해줘.', '프로젝트 현황을 요약하고 우선순위를 추천해줘.', 'Give me ideas for how to open the meeting.',
  ];
  const action = [
    'Schedule a 30 minute project review tomorrow at 10:00.', 'Send an email to Alex with the summary.', 'Cancel my 3pm meeting.', 'Create a calendar event for Friday.', 'Reply to the vendor and accept the quote.',
    '내일 오전 10시에 회의 일정을 잡아줘.', '알렉스에게 메일을 보내줘.', '3시 회의를 취소해줘.', 'Prepare the briefing and send it to the team.', 'Remind me to call Sam tomorrow.',
  ];
  for (const text of advisory) it(`ADVISORY: ${text.slice(0, 60)}`, () => assert.equal(classifyPlanRequest(text).kind, 'ADVISORY'));
  for (const text of action) it(`ACTION: ${text.slice(0, 60)}`, () => assert.equal(classifyPlanRequest(text).kind, 'ACTION'));

  it('unknown or unclear requests are ACTION, and one action cue outweighs any amount of advice wording', () => {
    for (const text of ['hello', 'ok do it', 'yes', "What's on my calendar tomorrow?", '', '   ']) assert.equal(classifyPlanRequest(text).kind, 'ACTION', JSON.stringify(text));
    assert.equal(classifyPlanRequest('Please summarize, recommend and suggest ideas - then delete the old report.').kind, 'ACTION');
    assert.equal(classifyPlanRequest('This is advice only, no action needed: schedule the meeting for 2pm.').kind, 'ACTION');
  });
});

describe('suggestions must be concrete', () => {
  it('accepts full-sentence next moves (English and Korean) and refuses placeholders, fragments and non-strings', () => {
    for (const ok of ['Ask the design lead which open item blocks the milestone.', '다음 회의 전에 승인 흐름의 남은 항목을 담당자와 확인하세요.']) assert.equal(isConcreteSuggestion(ok), true, ok);
    for (const bad of ['', 'n/a', 'TBD', 'next steps', 'Do it.', 'string', '...', 'see above', 'a b c', 42, null, undefined, {}, 'x'.repeat(401)]) assert.equal(isConcreteSuggestion(bad as unknown), false, JSON.stringify(bad));
  });
});

describe('an advisory answer is accepted only under every condition', () => {
  it('advice-only request + declared ADVISORY + steps [] + concrete suggestions -> ADVISORY, answered by Nemotron itself (no fallback)', async () => {
    const { svc, router, seen } = service(() => nebiusOk(advice()), () => geminiOk(actionPlan));
    const result = await plan(svc, DEMO, true);
    assert.equal(result.data.kind, 'ADVISORY');
    assert.deepEqual(result.data.steps, []);
    assert.equal(result.data.suggestions!.length, 3);
    assert.equal(result.provider, 'nebius');
    assert.equal(result.model, NEMOTRON);
    assert.equal(router.recentCalls(1)[0].fallbackUsed, false);
    assert.deepEqual(seen.map((s) => s.p), ['nebius'], 'no other provider was called');
  });

  it('the same answer is NOT accepted for a caller that did not ask for advisory (runners, chat channels): they keep the strict rule and the next provider answers', async () => {
    const { svc, seen } = service(() => nebiusOk(advice()), () => geminiOk(actionPlan));
    const result = await plan(svc, DEMO);                       // allowAdvisory not set
    assert.equal(result.data.kind, 'ACTION');
    assert.equal(result.data.steps.length, 1);
    assert.deepEqual(seen.map((s) => s.p), ['nebius', 'nebius', 'gemini']);
    const explicitFalse = service(() => nebiusOk(advice()), () => geminiOk(actionPlan));
    assert.equal((await plan(explicitFalse.svc, DEMO, false)).data.kind, 'ACTION');
  });

  it('an ACTION request with no steps stays rejected even if the model calls it advisory (it must not be downgraded to advice)', async () => {
    for (const prompt of ['Schedule a 30 minute project review tomorrow at 10:00.', '내일 오전 10시에 회의 일정을 잡아줘.', 'Send the briefing to the team.', 'hello']) {
      const { svc, seen } = service(() => nebiusOk(advice()), () => geminiOk(actionPlan));
      const result = await plan(svc, prompt, true);
      assert.equal(result.data.kind, 'ACTION', prompt);
      assert.equal(result.provider, 'gemini', `${prompt}: Nemotron's zero-step answer was refused and the fallback produced a real plan`);
      assert.deepEqual(seen.map((s) => s.p), ['nebius', 'nebius', 'gemini']);
    }
  });

  const rejected: Array<[string, Record<string, unknown>]> = [
    ['responseKind ACTION_PLAN with no steps', { responseKind: 'ACTION_PLAN' }],
    ['an unknown responseKind', { responseKind: 'SOMETHING_ELSE' }],
    ['no suggestions', { suggestions: [] }],
    ['suggestions missing', { suggestions: undefined }],
    ['suggestions not an array', { suggestions: 'Open with the status of the approval flow.' }],
    ['a placeholder suggestion', { suggestions: ['n/a', 'TBD'] }],
    ['a fragment suggestion', { suggestions: ['Follow up.'] }],
    ['one concrete and one placeholder', { suggestions: ['Ask the design lead which open item blocks the milestone.', 'tbd'] }],
    ['a non-string suggestion', { suggestions: ['Ask the design lead which open item blocks the milestone.', 42] }],
    ['more than eight suggestions', { suggestions: Array.from({ length: 9 }, (_v, i) => `Concrete next move number ${i + 1} for the team to do.`) }],
    ['a summary too short to be an answer', { summary: 'Be ready.' }],
    ['no goal', { goal: '' }],
    ['steps present although declared ADVISORY', { steps: JSON.parse(actionPlan).steps }],
    ['steps not an array', { steps: 'none' }],
    ['steps missing', { steps: undefined }],
  ];
  for (const [label, override] of rejected) {
    it(`rejects: ${label} (and the next provider answers instead)`, async () => {
      const { svc, seen } = service(() => nebiusOk(advice(override)), () => geminiOk(actionPlan));
      const result = await plan(svc, DEMO, true);
      assert.equal(result.provider, 'gemini', 'Nemotron\'s answer was invalid');
      assert.equal(result.data.kind, 'ACTION');
      assert.deepEqual(seen.map((s) => s.p), ['nebius', 'nebius', 'gemini']);
    });
  }

  it('with no provider able to answer validly the request FAILS (no empty or invented advice)', async () => {
    const { svc } = service(() => nebiusOk(advice({ suggestions: [] })));
    await assert.rejects(() => plan(svc, DEMO, true), (error: any) => error.code === 'ALL_MODEL_PROVIDERS_FAILED');
  });

  it('a missing responseKind or reasoningSummary does not matter: the request, the empty steps and the concrete suggestions decide (nothing is invented for the missing field)', async () => {
    const { svc } = service(() => nebiusOk(advice({ responseKind: undefined, reasoningSummary: undefined })), () => geminiOk(actionPlan));
    const result = await plan(svc, DEMO, true);
    assert.equal(result.data.kind, 'ADVISORY');
    assert.equal(result.provider, 'nebius');
    assert.equal(result.data.reasoningSummary, '');
  });

  it('a suggestion wrapped as {"sentence"|"text"|"suggestion"|"action": "..."} is unwrapped; any other shape is still rejected', async () => {
    const good = ['Open the review by stating where the approval flow stands today.', 'Ask the design lead which open item blocks the next milestone.'];
    const wrapped = service(() => nebiusOk(advice({ suggestions: [{ sentence: good[0] }, { text: good[1] }] })));
    const result = await plan(wrapped.svc, DEMO, true);
    assert.deepEqual(result.data.suggestions, good);
    assert.equal(result.provider, 'nebius');
    for (const bad of [[{ text: good[0], extra: 1 }], [{ foo: good[0] }], [{ text: 42 }], [[good[0], good[1]]], [1, 2, 3, 4, 5], [1.1, 1.2], [{}], [null]]) {
      const { svc, seen } = service(() => nebiusOk(advice({ suggestions: bad })), () => geminiOk(actionPlan));
      const answered = await plan(svc, DEMO, true);
      assert.equal(answered.provider, 'gemini', JSON.stringify(bad));
      assert.equal(answered.data.kind, 'ACTION');
      assert.deepEqual(seen.map((s) => s.p), ['nebius', 'nebius', 'gemini']);
    }
  });

  it('duplicate suggestions are collapsed; Korean advice is accepted', async () => {
    const dup = 'Ask the design lead which open item blocks the milestone.';
    const { svc } = service(() => nebiusOk(advice({ suggestions: [dup, dup, '다음 회의 전에 승인 흐름의 남은 항목을 담당자와 확인하세요.'] })));
    const result = await plan(svc, '내일 회의 브리핑을 준비하고 다음 행동을 제안해줘.', true);
    assert.deepEqual(result.data.suggestions, [dup, '다음 회의 전에 승인 흐름의 남은 항목을 담당자와 확인하세요.']);
  });
});

describe('the prompt contract changes only for an advisory request', () => {
  it('the advisory instruction is sent for an advice-only request and is absent for an action request and for non-interactive callers', async () => {
    const adv = service(() => nebiusOk(advice()));
    await plan(adv.svc, DEMO, true);
    assert.match(systemOf(adv.seen[0]), /ADVISORY ANSWER/);
    assert.match(systemOf(adv.seen[0]), /"responseKind":"ADVISORY"/);

    const act = service(() => nebiusOk(actionPlan));
    await plan(act.svc, 'Schedule a 30 minute project review tomorrow at 10:00.', true);
    assert.doesNotMatch(systemOf(act.seen[0]), /ADVISORY|responseKind/, 'an action request gets exactly the original prompt');

    const runner = service(() => nebiusOk(actionPlan));
    await plan(runner.svc, DEMO);
    assert.doesNotMatch(systemOf(runner.seen[0]), /ADVISORY|responseKind/, 'a non-interactive caller gets exactly the original prompt');
  });
});

describe('an advisory answer is never an executable plan', () => {
  const resolver = new PlanResolver(skillRegistry, toolRegistry);
  const advisoryPlan = { goal: 'g', summary: 'A substantial advisory summary about tomorrow.', reasoningSummary: 'r', kind: 'ADVISORY', steps: [], suggestions: ['Ask the design lead which open item blocks the milestone.'] };

  it('the resolver refuses it, with or without steps', () => {
    assert.throws(() => resolver.resolve(advisoryPlan as never), (e: any) => e.code === 'INVALID_PLAN_PREVIEW');
    assert.throws(() => resolver.resolve({ ...advisoryPlan, steps: JSON.parse(actionPlan).steps } as never), (e: any) => e.code === 'INVALID_PLAN_PREVIEW', 'a client cannot pass advice off as a plan');
    assert.throws(() => resolver.resolve({ ...advisoryPlan, kind: 'ACTION' } as never), (e: any) => e.code === 'INVALID_PLAN_PREVIEW', 'and zero steps is refused regardless');
  });

  it('POST /api/v1/ambient/intent returns ADVISORY_RESPONSE with no plan, executable:false and no execution side effects', async () => {
    const { svc } = service(() => nebiusOk(advice()));
    const res = await handleAsyncApiRequest('POST', '/api/v1/ambient/intent', { prompt: DEMO }, authAs('ten_adv_route', 'usr_adv_route'), svc) as any;
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.status, 'ADVISORY_RESPONSE');
    assert.equal(res.data.executable, false);
    assert.equal('plan' in res.data, false, 'advice is not a plan');
    assert.equal(res.data.advice.suggestions.length, 3);
    assert.equal(res.data.provider, 'nebius');
    assert.match(res.data.message, /No actions were taken/);
    for (const key of ['approval', 'approvals', 'taskId', 'executionId', 'steps']) assert.equal(key in res.data, false, key);
  });

  it('the same route still returns a PLAN_PREVIEW for an action request, and a zero-step answer there is not turned into advice', async () => {
    const act = service(() => nebiusOk(actionPlan));
    const ok = await handleAsyncApiRequest('POST', '/api/v1/ambient/intent', { prompt: 'Schedule a 30 minute project review tomorrow at 10:00.' }, authAs('ten_adv_route', 'usr_adv_route2'), act.svc) as any;
    assert.equal(ok.data.status, 'PLAN_PREVIEW');
    assert.equal(ok.data.plan.steps.length, 1);
    const zero = service(() => nebiusOk(advice()));
    const refused = await handleAsyncApiRequest('POST', '/api/v1/ambient/intent', { prompt: 'Schedule a 30 minute project review tomorrow at 10:00.' }, authAs('ten_adv_route', 'usr_adv_route3'), zero.svc) as any;
    assert.notEqual(refused.status, 200, JSON.stringify(refused.data));
    assert.notEqual(refused.data.status, 'ADVISORY_RESPONSE');
  });

  it('only the interactive Home route asks for advisory answers: no runner, channel service or other module sets allowAdvisory', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && /allowAdvisory\s*[:=]/.test(fs.readFileSync(full, 'utf8').replace(/\/\/.*$/gm, ''))) offenders.push(path.relative('src', full).split(path.sep).join('/'));
      }
    };
    walk(path.resolve('src'));
    assert.deepEqual(offenders.sort(), ['http/routes/conversation.routes.ts', 'model-gateway/ai-service.ts']);
    const routes = fs.readFileSync(path.resolve('src/http/routes/conversation.routes.ts'), 'utf8');
    assert.equal((routes.match(/allowAdvisory:\s*true/g) ?? []).length, 1);
  });
});
