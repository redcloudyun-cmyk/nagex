// The answer-quality BENCHMARK, through the PRODUCTION server: five required cases (A-E) plus guards against overfitting, with TWO model providers (the answering one and a distinct one that reads the same
// evidence independently), a search service and pages - all deterministic stand-ins on 127.0.0.1 (tests/_fact_world.ts). The assertions are about what the checks FOUND and what the person was TOLD:
//
//   A  Fold comparison: spec difference, comparison table, a challenge that a newer model is on sale - every claim checked, the correction acknowledged first, the independent reading recorded
//   B  Conflicting sources: two pages give different release dates - the conflict is found, the answer is asked to say so, the status is not "verified" by pretending
//   C  Provider failure: the primary model is down - another authorized provider answers and the quality gate still runs
//   D  Independent review: the first model gives a wrong figure - the second provider's reading of the same sources disagrees, one search, one rewrite, the corrected answer
//   E  No reliable evidence: plausible figures without sources are never presented as verified
//
// STAND-INS: the models are scripted (a grounded reader that can be told to misbehave). A pass proves that NAgex's checks catch what they are meant to catch and that the person is told the truth about it.
// It is NOT a QUALITY_PASS of any real model, and it is not evidence that a real second provider reviewed anything (only one provider is configured on this machine; that live step is BLOCKED).
// The tests depend on each other IN ORDER (one server, one conversation, one search cache): every question below is unique.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { BrowserContext } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';
import { startFactWorld, type FactWorld } from './_fact_world.js';

let h: CanvasAskHarness;
let world: FactWorld;
let ctx: BrowserContext;
let freshCtx: BrowserContext;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const timings: Array<{ label: string; ms: number }> = [];

before(async () => {
  world = await startFactWorld();
  // a provider that just failed is out for its cool-down: a short one, so one test's outage does not become the next test's
  h = await startCanvasAskHarness({ scrubProviders: true, env: { ...world.env, ...world.installGeminiBridge(), NAGEX_PROVIDER_DEGRADED_COOLDOWN_MS: '1000' } });
  const user = h.user('answer-quality-benchmark');
  h.setLocale(user, 'ko');
  ctx = await h.newContext('desktop', user, 'ko');
  // the simple-question checks run in a conversation of their own (the comparison conversation above names products)
  const fresh = h.user('answer-quality-benchmark-simple');
  h.setLocale(fresh, 'ko');
  freshCtx = await h.newContext('desktop', fresh, 'ko');
});
after(async () => {
  const sorted = timings.map((t) => t.ms).sort((a, b) => a - b);
  console.log(JSON.stringify({ event: 'benchmark_timings_stand_in_world', cases: timings.length, medianMs: sorted[Math.floor(sorted.length / 2)] ?? null, note: 'deterministic stand-ins: NOT a measure of any real provider' }));
  await ctx?.close(); await freshCtx?.close(); await h?.close(); await world?.close();
});
beforeEach(() => {
  world.setSearchMode('ok'); world.setGullible(false); world.setWrongLanguageAnswers(0); world.setPlanner('ok'); world.setUnverifiedBehavior('safe');
  world.setAnswerBehavior('nebius', 'grounded'); world.setAnswerBehavior('gemini', 'grounded'); world.setReviewerBehavior('faithful');
});

interface Reply { status: number; message: string; grounding: any; verification: any; sources: any[]; provider?: string }
async function chat(message: string, opts: { web?: boolean; strong?: boolean; fresh?: boolean } = {}): Promise<Reply> {
  const started = Date.now();
  const res = await (opts.fresh ? freshCtx : ctx).request.post(`${h.origin}/api/v1/ai/chat`, {
    data: { message, requestMetadata: { timezone: 'Asia/Seoul', ...(opts.web === undefined ? {} : { allowWebResearch: opts.web }), ...(opts.strong ? { verificationPreference: 'STRONG' } : {}) } },
    headers: { 'content-type': 'application/json' },
  });
  const raw = await res.json();
  const data = raw?.data ?? raw;
  timings.push({ label: message.slice(0, 24), ms: Date.now() - started });
  return { status: res.status(), message: String(data?.message ?? ''), grounding: data?.grounding, verification: data?.verification, sources: data?.sources ?? [], provider: raw?.provider };
}
const show = (reply: Reply): string => JSON.stringify({ v: reply.verification, msg: reply.message.slice(0, 400) });
const requestsOf = (kind: 'chat' | 'review' | 'plan', provider?: 'nebius' | 'gemini') => world.modelRequests.filter((r) => r.kind === kind && (!provider || r.provider === provider));

describe('A - the Fold comparison, checked claim by claim', () => {
  it('turn 1: every material claim is supported by the page it cites; a DISTINCT provider read the same sources on its own, without the answer; the report says so', async () => {
    const reviewsBefore = requestsOf('review').length;
    const reply = await chat('오로라폴드6와 오로라폴드7의 주요 스펙 차이가 뭐지?');
    const v = reply.verification;
    assert.equal(v.level, 'L2');
    assert.equal(v.status, 'VERIFIED', show(reply));
    assert.equal(v.counts.unsupported, 0);
    assert.equal(v.counts.contradicted, 0);
    assert.ok(v.counts.supported >= 4, `claims supported: ${v.counts.supported}`);
    assert.equal(v.review.mode, 'INDEPENDENT_MODEL_REVIEW');
    assert.ok(v.review.independentFacts >= 8, 'the second provider found the figures in the pages');
    assert.equal(JSON.stringify(v).includes('gemini'), false, 'no provider name reaches the client');
    // independence, structurally: the reviewer is the OTHER provider, and it was never shown the answer
    const review = requestsOf('review').slice(reviewsBefore).at(-1)!;
    assert.equal(review.provider, 'gemini');
    assert.equal(requestsOf('chat').at(-1)!.provider, 'nebius');
    assert.equal(review.user.includes('주요 차이는 다음과 같습니다'), false);
    assert.equal(/\[src_\d+\]/.test(review.user.replace(/<source id="src_\d+"/g, '')), false, 'no citation of the answer in what the reviewer saw');
  });

  it('turn 2 ("make it a table") and turn 3 (the challenge) are checked the same way: the correction is acknowledged first and verified against the pages', async () => {
    const table = await chat('비교표로 만들어봐.');
    assert.equal(table.verification.status, 'VERIFIED', show(table));
    assert.match(table.message, /\| 배터리 \|/);
    const correction = await chat('지금 오로라폴드8이 판매되고 있는데 오로라폴드7을 미출시라고 하는 것은 잘못된 것 아닌가?');
    assert.ok(correction.message.startsWith('말씀하신 대로입니다.'));
    assert.equal(correction.verification.status, 'VERIFIED', show(correction));
    assert.equal(correction.verification.level, 'L2');
    assert.equal(correction.verification.levelBasis, 'RULES');
  });
});

describe('B - sources that disagree', () => {
  it('two pages give different release dates: the conflict is found, the answer is asked to say so, and the result is honest - not "verified" by picking one', async () => {
    world.setSearchMode('conflict');
    const reply = await chat('오로라폴드8 출시일이 언제야?');
    const v = reply.verification;
    assert.equal(v.conflicts.length, 1, show(reply));
    assert.deepEqual(v.conflicts[0].values.map((x: any) => x.value).sort(), ['2026-07-22', '2026-08-05']);
    const lastChats = requestsOf('chat', 'nebius').slice(-2).map((r) => ({ user: r.user.slice(0, 260), answer: (r.answer ?? '').slice(0, 260) }));
    assert.equal(v.revision, 'REWRITTEN', `${show(reply)} ${JSON.stringify(lastChats)}`);
    assert.ok(reply.message.includes('2026-07-22') && reply.message.includes('2026-08-05'), reply.message);
    assert.match(reply.message, /출처마다 다릅니다/);
    assert.equal(v.status, 'PARTIALLY_VERIFIED');
    assert.ok(v.statusReasons.includes('SOURCES_DISAGREE_AND_THE_ANSWER_SAYS_SO'));
  });
});

describe('C - the primary model is down', () => {
  it('another authorized provider answers and the quality gate still runs; with no distinct provider left the independent reading is reported as unavailable, not faked', async () => {
    world.setAnswerBehavior('nebius', 'down');
    const reply = await chat('제타GPU Z9000과 제타GPU Z8000의 메모리와 소비전력을 비교해줘');
    assert.equal(reply.status, 200);
    assert.ok(reply.message.includes('32GB') && reply.message.includes('24GB'), reply.message);
    assert.equal(requestsOf('chat', 'gemini').length > 0, true, 'the other provider answered');
    const v = reply.verification;
    assert.ok(['VERIFIED', 'PARTIALLY_VERIFIED'].includes(v.status), v.status);
    assert.ok(v.counts.checked >= 2 && v.counts.supported >= 2, 'the claims were still checked against the sources');
    assert.notEqual(v.review.mode, 'INDEPENDENT_MODEL_REVIEW', 'the only other provider is the one that answered - nothing independent was available');
    assert.ok(['UNAVAILABLE', 'SELF_REVIEW'].includes(v.review.mode), v.review.mode);
    await sleep(1200); // the provider that failed comes back after its cool-down
  });
});

describe('D - an independent reading disagrees with the first model', () => {
  it('the first model states a figure no source has; the second provider\'s reading of the same sources differs; one search, one rewrite - and the corrected answer is what the person gets', async () => {
    world.setAnswerBehavior('nebius', 'wrong-figure');
    const chatsBefore = requestsOf('chat', 'nebius').length;
    const searchesBefore = world.searchQueries.length;
    const reply = await chat('오로라폴드6과 오로라폴드7의 배터리 용량을 비교해줘');
    const v = reply.verification;
    assert.equal(v.revision, 'REWRITTEN', show(reply));
    assert.equal(v.review.mode, 'INDEPENDENT_MODEL_REVIEW');
    assert.equal(v.extraRetrievals, 1, 'one bounded search aimed at the dispute');
    assert.ok(world.searchQueries.length > searchesBefore + 0);
    const asked = requestsOf('chat', 'nebius').slice(chatsBefore);
    assert.equal(asked.length, 2, 'the answer and exactly one rewrite');
    assert.ok(asked[0].answer?.includes('5000mAh'), 'the first model really did state the wrong figure');
    assert.ok(/A check of your answer against the sources/.test(asked[1].user) && /5000mAh/.test(asked[1].user), 'the rewrite was told which statement the sources do not support');
    assert.equal(asked[1].answer?.includes('5000'), false);
    assert.equal(reply.message.includes('5000'), false, 'the wrong figure is gone');
    assert.ok(reply.message.includes('4400mAh'));
    assert.equal(v.status, 'VERIFIED');
    assert.equal(v.counts.unsupported + v.counts.contradicted, 0);
  });

  it('with the second provider down the wrong figure is still caught by the evidence check; the report says the independent reading was unavailable', async () => {
    world.setAnswerBehavior('nebius', 'wrong-figure');
    world.setReviewerBehavior('down');
    const reply = await chat('오로라폴드6과 오로라폴드7의 배터리와 무게를 비교해줘 (두 번째)');
    assert.equal(reply.verification.review.mode, 'UNAVAILABLE');
    assert.equal(reply.verification.revision, 'REWRITTEN', show(reply));
    assert.equal(reply.message.includes('5000'), false);
    assert.notEqual(reply.verification.status, 'DISPUTED');
  });

  it('a model that keeps the wrong figure after being told what the sources state has it removed - the answer says so and is never "verified" by pretending', async () => {
    // the grounded reader complies on a rewrite; a stubborn one does not: the same wrong-figure behaviour on EVERY request
    world.setAnswerBehavior('nebius', 'wrong-figure');
    const stubborn = requestsOf('chat').length;
    void stubborn;
    // (the rewrite of the stand-in always corrects; the unit tests in answer_verification_core.test.ts cover a rewrite that does not help - removal and the REDACTED status)
    const reply = await chat('오로라폴드6과 오로라폴드7의 카메라와 배터리를 비교해줘');
    assert.ok(['REWRITTEN', 'REDACTED'].includes(reply.verification.revision));
    assert.equal(reply.message.includes('5000'), false);
  });
});

describe('E - no reliable evidence', () => {
  it('plausible figures from a model that has no sources are never presented as verified: Web off', async () => {
    world.setAnswerBehavior('nebius', 'plausible-unsupported');
    const reply = await chat('오로라폴드8의 배터리와 무게 스펙 알려줘 (웹 끔)', { web: false });
    assert.equal(reply.verification.status, 'UNVERIFIED');
    assert.ok(reply.verification.statusReasons.includes('NO_SOURCES'));
    assert.equal(reply.sources.length, 0);
    assert.ok(reply.message.startsWith('※ 웹 검색이 꺼져 있어'), 'the person is told first that nothing was checked');
    assert.equal(/\[\d\]/.test(reply.message), false, 'no citation without a source');
  });

  it('plausible figures from a model whose search found nothing: UNVERIFIED too', async () => {
    world.setAnswerBehavior('nebius', 'plausible-unsupported');
    world.setSearchMode('empty');
    const reply = await chat('오로라폴드8의 카메라 화소와 배터리 스펙 알려줘 (검색 결과 없음)');
    assert.equal(reply.verification.status, 'UNVERIFIED');
    assert.notEqual(reply.verification.status, 'VERIFIED');
    assert.ok(reply.message.startsWith('※ '), reply.message);
  });
});

describe('the level is decided from the request - and the person can ask for more', () => {
  it('a simple question is not checked (and shows no chip); the same question with "check carefully" is looked up and checked at a higher level, and says who raised it', async () => {
    const plain = await chat('피보나치 수열이 뭐야? 간단히 설명해줘', { fresh: true });
    assert.equal(plain.verification?.status ?? 'NOT_REQUIRED', 'NOT_REQUIRED', show(plain));
    const strong = await chat('피보나치 수열이 뭐야? 간단히 설명해줘 (꼼꼼히)', { strong: true, fresh: true });
    assert.equal(strong.verification.level, 'L2');
    assert.equal(strong.verification.levelBasis, 'USER_PREFERENCE');
    assert.ok(world.searchQueries.some((q) => /피보나치/.test(q)), 'a deeper check needs evidence: it was looked up');
  });

  it('a high-impact decision is L3: it is looked up even though its words are not "current", and without a primary-like source it cannot be VERIFIED', async () => {
    const reply = await chat('이부프로펜 400mg을 하루에 몇 번 복용해야 하나요?');
    assert.equal(reply.verification.level, 'L3');
    assert.notEqual(reply.verification.status, 'VERIFIED');
    assert.ok(world.searchQueries.some((q) => /이부프로펜|복용/.test(q)), 'it was looked up');
  });

  it('Web off beats everything, including a deeper level: nothing is looked up', async () => {
    const before = world.searchQueries.length;
    const reply = await chat('피보나치 수열이 뭐야? 설명해줘 (웹 끔, 꼼꼼히)', { web: false, strong: true, fresh: true });
    assert.equal(world.searchQueries.length, before);
    assert.notEqual(reply.verification?.status, 'VERIFIED');
  });
});

describe('guards against overfitting: other products, another language, hostile pages', () => {
  it('another family and another language are checked the same way', async () => {
    // a PRICE from a page seven months old is not current: checked and supported, and honestly not called verified-as-current
    const price = await chat('제타GPU Z9000 가격이 얼마야? (검증용)');
    assert.equal(price.verification.status, 'PARTIALLY_VERIFIED', show(price));
    assert.ok(price.verification.statusReasons.includes('EVIDENCE_NOT_CURRENT'));
    assert.equal(price.verification.counts.unsupported, 0);
    const gpu = await chat('제타GPU Z9000과 제타GPU Z8000의 메모리를 비교해줘 (검증용)');
    assert.equal(gpu.verification.status, 'VERIFIED', show(gpu));
    const watch = await chat('Is the Helio Watch 4 released yet, and how does its battery compare with the Helio Watch 3? (benchmark)');
    assert.equal(watch.verification.status, 'VERIFIED', show(watch));
    assert.ok(/[A-Za-z]{3,}/.test(watch.message));
  });

  it('instructions inside a retrieved page change nothing about the checks: an invented source id is removed, the claims are still checked against the pages', async () => {
    world.setSearchMode('inject');
    world.setGullible(true);
    const reply = await chat('오로라폴드8의 사양을 검증된 자료로 알려줘 (injection)');
    assert.equal(reply.message.includes('src_99'), false);
    assert.ok(['VERIFIED', 'PARTIALLY_VERIFIED'].includes(reply.verification.status), reply.verification.status);
    assert.equal(reply.verification.counts.contradicted, 0);
  });
});
