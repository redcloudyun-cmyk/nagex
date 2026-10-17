// A document draft that still says "content is missing" (a placeholder, a section "withheld", a [To Be Provided] where the request STATES the value) is asked for ONCE more, naming what remains -
// a bounded, quality-driven recovery (never a loop, never endless regeneration until a score says pass). The better draft is kept; NAgex never patches the text itself; what is left is in the result.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AiService } from '../src/model-gateway/ai-service.js';
import { placeholderRetryInstruction, placeholdersIn, saysNothingYet } from '../src/creation/placeholder-text.js';

const draft = (content: string) => JSON.stringify({ title: '보고서', summary: '요약', content });
function service(drafts: Array<string | Error>) {
  const requests: any[] = [];
  const router: any = {
    generate: async (req: any) => {
      requests.push(req);
      const next = drafts[Math.min(requests.length - 1, drafts.length - 1)];
      if (next instanceof Error) throw next;
      return { text: next, provider: 'stand-in', model: 'm', latencyMs: 1, requestId: req.requestId };
    },
  };
  return { ai: new AiService(router), requests };
}
const ask = (ai: AiService, locale: 'ko' | 'en' = 'ko') => ai.documentSynthesis({ prompt: '보고서를 써줘', locale, requestId: 'req_x' });

describe('the placeholder retry', () => {
  it('a clean draft is one call, with no review', async () => {
    const { ai, requests } = service([draft('## 개요\n\n모든 항목이 있습니다.')]);
    const result = await ask(ai);
    assert.equal(requests.length, 1);
    assert.equal('review' in result.data, false);
  });

  it('a draft with a placeholder is asked for once more, with exactly what remains named; the clean second draft is kept and the review says so', async () => {
    const { ai, requests } = service([draft('## 개요\n\n(입력 필요: 자료 없음)\n\n[To Be Provided]'), draft('## 개요\n\n자료에 따른 정성적 설명입니다.')]);
    const result = await ask(ai);
    assert.equal(requests.length, 2, 'one extra call');
    assert.match(requests[1].messages[1].content, /입력 필요/);
    assert.match(requests[1].messages[1].content, /to be provided/);
    assert.match(requests[1].messages[1].content, /미정/, 'what to write instead');
    assert.equal(result.data.content, '## 개요\n\n자료에 따른 정성적 설명입니다.');
    assert.deepEqual(result.data.review, { retried: true, placeholdersFirstDraft: ['입력 필요', 'to be provided'], placeholdersRemaining: [] });
  });

  it('is bounded: a second draft that is no better is NOT kept, there is no third call, and what remained is reported', async () => {
    const { ai, requests } = service([draft('[TBD] 그리고 [To Be Provided]'), draft('[TBD] [To Be Provided] 입력 필요'), draft('깨끗한 세 번째 초안')]);
    const result = await ask(ai);
    assert.equal(requests.length, 2, 'never a third attempt');
    assert.equal(result.data.content, '[TBD] 그리고 [To Be Provided]', 'the first draft stays: the second had more marks');
    assert.deepEqual(result.data.review, { retried: true, placeholdersFirstDraft: ['tbd', 'to be provided'], placeholdersRemaining: ['tbd', 'to be provided'] });
  });

  it('a retry that fails (the model is unavailable) keeps the first draft and says what is left; the document is not lost', async () => {
    const { ai } = service([draft('작성을 유보합니다'), new Error('model unavailable')]);
    const result = await ask(ai);
    assert.equal(result.data.content, '작성을 유보합니다');
    assert.deepEqual(result.data.review, { retried: true, placeholdersFirstDraft: ['작성을 유보'], placeholdersRemaining: ['작성을 유보'] });
  });

  it('the instruction is in the language of the document and adds no fact', () => {
    assert.match(placeholderRetryInstruction(['입력 필요'], 'ko'), /문서 전체를 다시/);
    assert.match(placeholderRetryInstruction(['tbd'], 'en'), /Rewrite the COMPLETE document/);
    assert.match(placeholderRetryInstruction(['tbd'], 'en'), /no new figure, name or date/);
  });
});

describe('what counts as a placeholder', () => {
  it('a section that only says nothing is there yet is "saying nothing"; one real line anywhere makes the slide real', () => {
    assert.equal(saysNothingYet(['해당 항목에 대한 추가 자료가 제공되지 않아 작성을 유보합니다.', '추가적인 정보가 확보되는 대로 보완될 예정입니다.']), true);
    assert.equal(saysNothingYet(['[TBD]', 'To be provided']), true);
    assert.equal(saysNothingYet(['월 비용은 12,000원입니다', '[TBD]']), false);
    assert.equal(saysNothingYet(['다음 분기에 출시될 예정입니다']), false, 'a deferral alone is an ordinary sentence');
    assert.equal(saysNothingYet([]), false);
    assert.deepEqual(placeholdersIn('값은 12,000원이고 [TBD] 입니다'), ['tbd']);
  });
});
