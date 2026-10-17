// Answer quality for questions about the current world, through the PRODUCTION server (the real route, intent routing input, evidence pack, search service, page reader, AiService prompt, Model Gateway,
// citation check and conversation store) with a deterministic stand-in world (tests/_fact_world.ts). The incident's three turns - a spec comparison, "make it a table", and a challenge that a newer
// model is on sale - are replayed with a FICTIONAL product line, and the assertions are about what the answers SAY (facts that exist only in the retrieved pages, citations, a correction in the first
// sentence), not about HTTP status or non-empty text. Unrelated scenarios (another product family, English, a live value) guard against a fix that only works for one incident.
//
// STAND-INS: the model is a "grounded reader" that can only state what is in the evidence it is given, and calls the newest product unreleased when it is given none (the incident). A pass proves NAgex's
// chain delivers evidence, keeps context, honours the Web switch and checks the answer; it is NOT a QUALITY_PASS of a real model or search provider (see the live evidence document).
// The tests depend on each other IN ORDER (they share the server's conversation, its route memory and its search cache); the credential-rejection test is last because it keeps the route out for ten minutes.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { BrowserContext } from 'playwright';
import { startCanvasAskHarness, type CanvasAskHarness } from './_canvas_ask_harness.js';
import { startFactWorld, type FactWorld } from './_fact_world.js';

let h: CanvasAskHarness;
let world: FactWorld;
let ctx: BrowserContext;

before(async () => {
  world = await startFactWorld();
  h = await startCanvasAskHarness({ scrubProviders: true, env: world.env });
  const user = h.user('web-answer-quality');
  h.setLocale(user, 'ko');
  ctx = await h.newContext('desktop', user, 'ko');
});
after(async () => { await ctx?.close(); await h?.close(); await world?.close(); });
// every test starts from a healthy world (a failed assertion must not leave the search service broken for the next one)
beforeEach(() => { world.setSearchMode('ok'); world.setGullible(false); world.setWrongLanguageAnswers(0); world.setPlanner('ok'); world.setUnverifiedBehavior('safe'); });

interface ChatReply { status: number; message: string; grounding: any; sources: any[]; raw: any }
async function chat(message: string, opts: { web?: boolean } = {}): Promise<ChatReply> {
  const res = await ctx.request.post(`${h.origin}/api/v1/ai/chat`, {
    data: { message, requestMetadata: { timezone: 'Asia/Seoul', ...(opts.web === undefined ? {} : { allowWebResearch: opts.web }) } },
    headers: { 'content-type': 'application/json' },
  });
  const raw = await res.json();
  const data = raw?.data ?? raw;
  return { status: res.status(), message: String(data?.message ?? ''), grounding: data?.grounding, sources: data?.sources ?? [], raw };
}
const lastChatRequest = () => world.modelRequests.filter((r) => r.kind === 'chat').slice(-1)[0];
const chatCalls = () => world.modelRequests.filter((r) => r.kind === 'chat').length;

describe('the Fold incident, replayed with a fictional device line: a comparison, "make it a table", and a challenge', () => {
  it('turn 1 - a spec comparison is looked up, read from the pages, answered with those facts and cited (not answered from memory)', async () => {
    const before = world.searchQueries.length;
    const reply = await chat('오로라폴드6와 오로라폴드7의 주요 스펙 차이가 뭐지?');
    assert.equal(reply.status, 200);
    assert.ok(world.searchQueries.length > before, 'a search was made');
    const issued = world.searchQueries.slice(before).join(' | ');
    assert.match(issued, /오로라폴드6/);
    assert.match(issued, /오로라폴드7/);
    assert.ok(world.modelRequests.some((r) => r.kind === 'plan'), 'the model named what to look up');
    const req = lastChatRequest();
    assert.equal(req.hasEvidence, true, 'the model was handed the evidence');
    assert.equal(req.hasUnverifiedBlock, false);
    // facts that exist ONLY in the retrieved pages
    for (const fact of ['4400mAh', '239g', '215g', '7.6인치', '8.0인치', '50MP', '200MP']) assert.ok(reply.message.includes(fact), `answer carries ${fact}: ${reply.message}`);
    assert.match(reply.message, /\[src_\d+\]/, 'claims are cited');
    assert.equal(/아직 출시되지|추정치/.test(reply.message), false, 'the newest model is not called unreleased');
    assert.equal(reply.grounding.basis, 'SOURCES_CITED');
    assert.ok(reply.grounding.sourcesRetrieved >= 2);
    assert.ok(reply.sources.every((s: any) => /^http/.test(s.url)), 'sources are real addresses that were retrieved');
    assert.ok(reply.sources.some((s: any) => typeof s.excerpt === 'string' && s.excerpt.includes('오로라폴드7')), 'the page itself was read');
    assert.ok(/[가-힣]/.test(reply.message), 'Korean is kept');
  });

  it('turn 2 - "make it a table" keeps the subject: it searches the comparison again (not the words "비교표로 만들어봐"), and answers with a table of the retrieved facts', async () => {
    const before = world.searchQueries.length;
    const reply = await chat('비교표로 만들어봐.');
    const issued = world.searchQueries.slice(before);
    assert.ok(issued.join(' | ').includes('오로라폴드6') && issued.join(' | ').includes('오로라폴드7'), `the searches keep the subject: ${issued.join(' | ')}`);
    assert.equal(issued.includes('비교표로 만들어봐.'), false, 'the words of the follow-up alone are never the search');
    assert.match(reply.message, /\| 항목 \| 오로라폴드6 \| 오로라폴드7 \|/);
    assert.match(reply.message, /\| 배터리 \| 4400mAh \[src_\d+\] \| 4400mAh \[src_\d+\] \|/);
    assert.match(reply.message, /\| 무게 \| 239g/);
    assert.equal(reply.grounding.turnKind, 'FOLLOW_UP');
    assert.equal(reply.grounding.basis, 'SOURCES_CITED');
  });

  it('turn 3 - the challenge "a newer model is on sale, so calling the previous one unreleased is wrong" is checked against the sources, acknowledged in the first sentence, corrected, and the comparison is redone', async () => {
    const before = world.searchQueries.length;
    const reply = await chat('지금 오로라폴드8이 판매되고 있는데 오로라폴드7을 미출시라고 하는 것은 잘못된 것 아닌가?');
    const issued = world.searchQueries.slice(before).join(' | ');
    assert.equal(reply.grounding.turnKind, 'CORRECTION');
    const req = lastChatRequest();
    assert.equal(req.hasChallengeBlock, true);
    assert.equal(req.hasEvidence, true);
    assert.match(issued, /오로라폴드8/, 'the search is about the product the person named');
    assert.match(issued, /오로라폴드6/, 'and keeps the earlier subject');
    assert.ok(reply.message.startsWith('말씀하신 대로입니다.'), `acknowledged first: ${reply.message.slice(0, 80)}`);
    assert.ok(reply.message.includes('2025-07-09'), 'the release date of the disputed product comes from the sources');
    assert.ok(reply.message.includes('2026-07-22'), 'so does the newer one');
    assert.ok(reply.message.includes('4800mAh'), 'the corrected comparison includes the newer model');
    assert.equal(/아직 출시되지|추정치/.test(reply.message), false);
    assert.equal(/live web search|unavailable/i.test(reply.message), false, 'the old canned English sentence is gone');
    assert.ok(/[가-힣]/.test(reply.message));
  });

  it('the correction is part of the conversation: the stored answers carry it, so the next turn starts from the corrected facts', async () => {
    const res = await ctx.request.get(`${h.origin}/api/v1/conversations/main`);
    const body = await res.json();
    const messages: Array<{ role: string; content: string }> = body?.data?.messages ?? body?.messages ?? [];
    const assistant = messages.filter((m) => m.role === 'ASSISTANT');
    assert.ok(assistant.length >= 3);
    assert.ok(assistant.at(-1)!.content.startsWith('말씀하신 대로입니다.'));
    assert.ok(messages.filter((m) => m.role === 'USER').length >= 3);
  });
});

describe('unrelated current-fact scenarios work the same way (nothing is keyed to one incident)', () => {
  it('another family, a price: the retrieved price is stated and cited', async () => {
    const reply = await chat('제타GPU Z9000 가격이 얼마야?');
    assert.ok(reply.message.includes('1,899달러'), reply.message);
    assert.match(reply.message, /\[src_\d+\]/);
    assert.equal(reply.grounding.category, 'PRODUCT_PRICE');
  });

  it('English request, Latin names: answered in English from the retrieved pages, with the release date', async () => {
    const reply = await chat('Is the Helio Watch 4 released yet, and how does its battery compare with the Helio Watch 3?');
    assert.ok(reply.message.includes('2026-05-14'), reply.message);
    assert.ok(reply.message.includes('72시간') && reply.message.includes('48시간'));
    assert.match(reply.message, /\[src_\d+\]/);
    assert.equal(/[가-힣]{6,}/.test(reply.message.replace(/배터리|무게|출시일|시간/g, '')), false, 'the answer is not switched to Korean');
  });

  it('a timeless question triggers no search and no evidence', async () => {
    const queries = world.searchQueries.length;
    const reply = await chat('피보나치 수열을 재귀로 구현하는 방법을 설명해줘');
    assert.equal(world.searchQueries.length, queries);
    assert.equal(reply.grounding.basis, 'NOT_REQUIRED');
    assert.equal(lastChatRequest().hasEvidence, false);
  });
});

describe('the Web switch of the composer is real', () => {
  it('Web OFF: a product question is not searched; the answer says so in Korean and does not guess "unreleased"', async () => {
    const queries = world.searchQueries.length;
    const reply = await chat('오로라폴드7의 배터리 용량이 얼마야? 후속 모델도 나왔어?', { web: false });
    assert.equal(world.searchQueries.length, queries, 'nothing was looked up');
    assert.equal(reply.grounding.evidenceStatus, 'DISABLED');
    assert.equal(reply.grounding.basis, 'NOT_VERIFIED_LIVE');
    assert.ok(reply.message.startsWith('※ 웹 검색이 꺼져 있어'), reply.message);
    assert.equal(lastChatRequest().hasUnverifiedBlock, true);
    assert.equal(/아직 출시되지/.test(reply.message), false);
  });

  it('a model that cannot check but DENIES a release anyway is asked once more; one that insists has the denial removed - the incident\'s own sentence never reaches the person', async () => {
    world.setUnverifiedBehavior('denies-once');
    const calls = chatCalls();
    const once = await chat('오로라폴드8이 출시됐는지 알려줘 (첫 번째)', { web: false });
    assert.equal(chatCalls() - calls, 2, 'one rewrite');
    assert.equal(/아직 출시되지|미출시/.test(once.message), false, once.message);
    assert.equal(once.grounding.releaseDenial, 'REWRITTEN');
    assert.ok(once.message.startsWith('※ 웹 검색이 꺼져 있어'));

    world.setUnverifiedBehavior('denies-always');
    const calls2 = chatCalls();
    const always = await chat('오로라폴드8이 출시됐는지 알려줘 (두 번째)', { web: false });
    assert.equal(chatCalls() - calls2, 2, 'bounded: one rewrite, never a loop');
    assert.equal(/아직 출시되지|미출시/.test(always.message), false, always.message);
    assert.equal(always.grounding.releaseDenial, 'REDACTED');
    assert.ok(always.message.includes('4400mAh'), 'what the model remembered stays');
    assert.ok(always.message.includes('※ 출시 여부는 확인하지 못했습니다.'));
  });

  it('Web OFF: a live value is not answered from memory at all - and the model is not even called', async () => {
    const calls = chatCalls();
    const reply = await chat('제타GPU Z9000 시세 알려줘', { web: false });
    assert.equal(chatCalls(), calls, 'no model call: nothing to invent a price from');
    assert.match(reply.message, /기억에 의존해 답하면 틀린 값을 드릴 수 있어 답변을 보류합니다/);
    assert.match(reply.message, /웹 검색이 꺼져 있어/);
  });
});

describe('a failing or hostile search route', () => {
  it('search service down (HTTP 500): the product question is still answered - labelled unverified, in Korean, with the reason - and the number of search requests stays bounded', async () => {
    world.setSearchMode('http500');
    const before = world.searchQueries.length;
    const reply = await chat('오로라폴드8의 카메라 화소는 얼마야? 새로 나온 모델 기준으로 알려줘');
    assert.ok(world.searchQueries.length - before <= 2, 'at most one retry');
    assert.equal(reply.grounding.basis, 'NOT_VERIFIED_LIVE');
    assert.ok(reply.message.startsWith('※ '), reply.message);
    assert.match(reply.message, /확인되지 않은 것/);
    assert.equal(lastChatRequest().hasUnverifiedBlock, true);
    assert.equal(reply.sources.length, 0, 'no source is made up');
    assert.equal(/\[src_\d+\]/.test(reply.message), false);
    assert.equal(/live web search is unavailable/i.test(reply.message), false);
    world.setSearchMode('ok');
  });

  it('the model that names what to look up is down: the person\'s own words are searched and the answer is still grounded', async () => {
    world.setPlanner('down');
    const before = world.searchQueries.length;
    const question = '오로라폴드6와 오로라폴드7의 무게와 카메라를 비교해줘';
    const reply = await chat(question);
    assert.ok(world.searchQueries.slice(before).includes(question), 'the question itself was searched');
    assert.ok(reply.message.includes('239g') && reply.message.includes('215g'), reply.message);
    assert.equal(reply.grounding.basis, 'SOURCES_CITED');
  });

  it('rate limited with a two-minute Retry-After: not waited out, reported as such', async () => {
    world.setSearchMode('http429');
    const started = Date.now();
    const reply = await chat('오로라폴드7의 카메라 화소는 얼마야? 최신 정보로 알려줘');
    assert.ok(Date.now() - started < 8000, 'no long wait');
    assert.equal(reply.grounding.evidenceStatus, 'RATE_LIMITED');
    assert.match(reply.message, /웹 검색 서비스가 지금은 요청을 받지 않아/);
    world.setSearchMode('ok');
  });

  it('instructions inside a retrieved page are data: they stay inside the fence, a model that obeys them cannot cite a source that does not exist, and nothing is executed', async () => {
    world.setSearchMode('inject');
    world.setGullible(true);
    const reply = await chat('오로라폴드8의 사양을 최신 기준으로 알려줘');
    const req = lastChatRequest();
    assert.match(req.system, /untrusted DATA/);
    const fenced = /<<<EVIDENCE (\w+)\n([\s\S]*?)\nEVIDENCE \1>>>/.exec(req.system);
    assert.ok(fenced, 'the evidence is fenced');
    assert.ok(fenced![2].includes('IGNORE ALL PREVIOUS INSTRUCTIONS'), 'the hostile text is inside the fence');
    assert.equal(req.system.replace(fenced![0], '').includes('IGNORE ALL PREVIOUS INSTRUCTIONS'), false, 'and nowhere outside it');
    assert.equal(reply.message.includes('src_99'), false, 'the invented citation was removed');
    assert.ok(reply.grounding.removedCitations.includes('src_99'));
    assert.ok(reply.sources.every((s: any) => s.sourceId !== 'src_99'));
    world.setGullible(false);
    world.setSearchMode('ok');
  });

  it('a model that answers in the wrong language is asked once more; a model that persists is delivered as it is after exactly one extra call', async () => {
    world.setWrongLanguageAnswers(1);
    const calls = chatCalls();
    const fixed = await chat('오로라폴드6의 디스플레이 크기를 최신 정보로 알려줘');
    assert.equal(chatCalls() - calls, 2);
    assert.equal(fixed.grounding.languageRewritten, true);
    assert.ok(/[가-힣]/.test(fixed.message));

    world.setWrongLanguageAnswers(5);
    const calls2 = chatCalls();
    const stubborn = await chat('오로라폴드7의 무게를 최신 정보로 알려줘');
    assert.equal(chatCalls() - calls2, 2, 'bounded: one extra call, never a loop');
    assert.equal(stubborn.grounding.languageRewritten, false);
    world.setWrongLanguageAnswers(0);
  });

  it('a rejected search credential: the product question is answered unverified, and the rejected route is not asked again on the next request', async () => {
    world.setSearchMode('http401');
    const before = world.searchQueries.length;
    const first = await chat('오로라폴드8이 출시됐는지 최신 정보로 알려줘');
    assert.equal(first.grounding.evidenceStatus, 'AUTH_FAILED');
    assert.match(first.message, /웹 검색 서비스가 인증을 거부해/);
    assert.equal(world.searchQueries.length - before, 1, 'one request, no retry');
    const second = await chat('제타GPU Z8000 출시 여부를 알려줘');
    assert.equal(world.searchQueries.length - before, 1, 'the route that rejected its credential is not asked again');
    assert.equal(second.grounding.evidenceStatus, 'AUTH_FAILED');
    world.setSearchMode('ok');
  });
});
