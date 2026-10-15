// "3쪽 분량의 보고서": the named length reaches the model as a concrete size, a draft that is several times too short is asked for once more (bounded), and the longer answer is kept.
// Fake provider endpoint: this proves the prompt and the control flow, NOT how a real model obeys it (the real-model run is in the P0-01 report).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiService } from '../src/model-gateway/ai-service.js';
import { NebiusProvider } from '../src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { lengthInstruction, minimumCharacters, requestedPages, tooShortInstruction } from '../src/creation/document-length.js';

describe('requestedPages reads a named length and nothing else', () => {
  it('Korean and English page counts', () => {
    assert.equal(requestedPages('개인 AI 비서가 업무에 미치는 영향에 대한 3쪽 분량의 보고서를 작성해줘'), 3);
    assert.equal(requestedPages('5페이지 보고서 써줘'), 5);
    assert.equal(requestedPages('보고서를 10 쪽으로'), 10);
    assert.equal(requestedPages('A 2-page report on onboarding'), 2);
    assert.equal(requestedPages('write a 12 pages summary'), 12);
    assert.equal(requestedPages('3장 분량 보고서'), 3);
  });
  it('slides, years, huge or absent numbers are not page counts', () => {
    assert.equal(requestedPages('발표자료를 6장 만들어줘'), null);
    assert.equal(requestedPages('2026쪽'), null);
    assert.equal(requestedPages('300쪽 보고서'), null);
    assert.equal(requestedPages('시장 동향 보고서를 써줘'), null);
    assert.equal(requestedPages(''), null);
  });
  it('instructions state the minimum in characters and stay in the request language', () => {
    assert.equal(minimumCharacters(3, 'ko'), 3900);
    assert.match(lengthInstruction(3, 'ko'), /최소 3900자/);
    assert.match(lengthInstruction(3, 'en'), /about 3 A4 pages/);
    assert.match(tooShortInstruction(3, 'ko', 1118), /1118자/);
  });
});

describe('documentSynthesis honours a named length with at most one extra call', () => {
  const NEMOTRON = 'nvidia/Nemotron-3_5-Lightning';
  const reply = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
  const doc = (chars: number) => JSON.stringify({ title: '제목', summary: '요약', content: '가'.repeat(chars) });
  function service(answers: string[], seen: Array<{ system: string; user: string }>): AiService {
    let i = 0;
    const provider = new NebiusProvider({ apiKey: 'k', model: NEMOTRON, fetchFn: (async (_u: any, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      seen.push({ system: String(body.messages.find((m: any) => m.role === 'system')?.content ?? ''), user: String(body.messages.find((m: any) => m.role === 'user')?.content ?? '') });
      return reply(answers[Math.min(i++, answers.length - 1)]);
    }) as typeof fetch });
    return new AiService(new UnifiedModelRouter([provider], { info: () => {}, warn: () => {} }));
  }

  it('a long enough first draft is used as is: one call, the length instruction is in the system prompt', async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const out = await service([doc(5000)], seen).documentSynthesis({ prompt: '업무 영향 3쪽 분량 보고서', locale: 'ko', requestId: 'r1' });
    assert.equal(seen.length, 1);
    assert.match(seen[0].system, /최소 3900자/);
    assert.equal(out.data.content.length, 5000);
  });
  it('a draft far below the target is asked for once more and the longer one is kept', async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const out = await service([doc(1100), doc(4300)], seen).documentSynthesis({ prompt: '업무 영향 3쪽 분량 보고서', locale: 'ko', requestId: 'r2' });
    assert.equal(seen.length, 2);
    assert.match(seen[1].user, /앞선 초안은 1100자/);
    assert.equal(out.data.content.length, 4300);
  });
  it('never loops and never keeps a shorter retry: two short drafts -> exactly two calls, the longer one returned unchanged', async () => {
    const seen: Array<{ system: string; user: string }> = [];
    const out = await service([doc(1200), doc(900)], seen).documentSynthesis({ prompt: '3쪽 보고서', locale: 'ko', requestId: 'r3' });
    assert.equal(seen.length, 2);
    assert.equal(out.data.content.length, 1200);
  });
  it('a request without a named length is untouched: one call, no length line', async () => {
    const seen: Array<{ system: string; user: string }> = [];
    await service([doc(300)], seen).documentSynthesis({ prompt: '회의록 양식을 만들어줘', locale: 'ko', requestId: 'r4' });
    assert.equal(seen.length, 1);
    assert.doesNotMatch(seen[0].system, /분량: 요청한 분량/);
  });
});
