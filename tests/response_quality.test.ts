// Response quality of the chat answer, found with the REAL model before it was fixed ("explain 5 features" listed generic assistant skills as NAgex features; "can NAgex read my Outlook mail?"
// was answered "yes"; the system prompt said only "Be concise"). What is pinned here, deterministically: the answer is told what NAgex really is and cannot do (and that list agrees with the
// runtime), what the request asks for (parts, an exact count, how big an answer it deserves) reaches the model, a mechanically checkable miss (a number of items, the numbers of a numbered
// request) is asked for once more - never in a loop - and a simple question stays simple.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CAPABILITY_BRIEF, capabilityBriefLines } from '../src/model-gateway/capability-brief.js';
import { analyzeRequest, checkCoverage, requestShapeInstructions } from '../src/model-gateway/request-analysis.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { GeminiProvider } from '../src/model-gateway/providers.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { CapabilityRegistry } from '../src/capabilities/capability.registry.js';
import { CONNECTOR_CATALOG } from '../src/connectors/connector-catalog.js';
import { decideRouting } from '../src/workspace/input-router.js';

describe('what a request asks for', () => {
  it('reads an exact count, numbered parts and the size of the answer from the words', () => {
    const s1 = analyzeRequest('오늘 날짜가 언제인지 알려주고, NAgex의 주요 기능 5가지를 각각 사용 예시와 함께 설명해줘.');
    assert.deepEqual([s1.requestedCount, s1.complexity, s1.language], [5, 'MULTI', 'ko']);
    const s6 = analyzeRequest('다음 세 가지를 모두 해줘. 1) 오늘 날짜와 요일을 알려줘 2) 좋은 회의의 조건을 3가지로 설명해줘 3) 위 내용을 영어 한 문장으로 요약해줘.');
    assert.deepEqual(s6.parts, ['오늘 날짜와 요일을 알려줘', '좋은 회의의 조건을 3가지로 설명해줘', '위 내용을 영어 한 문장으로 요약해줘']);
    assert.equal(s6.complexity, 'COMPLEX', 'numbered parts together with a count');
    assert.deepEqual([analyzeRequest('한국의 수도는 어디야?').complexity, analyzeRequest('한국의 수도는 어디야?').requestedCount], ['SIMPLE', null]);
    assert.equal(analyzeRequest('What is the capital of France?').complexity, 'SIMPLE');
    assert.equal(analyzeRequest('Give me three examples of good meeting habits').requestedCount, 3);
    assert.equal(analyzeRequest('Explain five ways to prepare for a review').requestedCount, 5);
    assert.equal(analyzeRequest('한 가지만 알려줘').requestedCount, null, '"one thing" is not a list');
    assert.deepEqual(analyzeRequest('1. 일정 확인\n2. 보고서 요약\n3. 메일 초안').parts, ['일정 확인', '보고서 요약', '메일 초안']);
    assert.deepEqual(analyzeRequest('Plan 2 days in Seoul. Version 3. beta').parts, [], 'numbers inside a sentence are not parts');
    assert.equal(analyzeRequest('아주 긴 요청 '.repeat(60)).complexity, 'COMPLEX');
  });

  it('tells the model what to do for that shape; a simple question is kept simple', () => {
    const multi = requestShapeInstructions(analyzeRequest('NAgex의 주요 기능 5가지를 각각 사용 예시와 함께 설명해줘'));
    assert.ok(multi.some((l) => /exactly 5/.test(l)));
    assert.ok(multi.some((l) => /complete, well-organised answer/.test(l)));
    const numbered = requestShapeInstructions(analyzeRequest('1) 날짜 알려줘 2) 회의 조건 설명해줘'));
    assert.ok(numbered.some((l) => /has 2 parts/.test(l)) && numbered.some((l) => /Answer EVERY part/.test(l)));
    const simple = requestShapeInstructions(analyzeRequest('한국의 수도는 어디야?'));
    assert.ok(simple.some((l) => /simple question/.test(l) && /No list/.test(l)));
  });

  it('checks only what can be checked: a count of items, and the numbers of a numbered request', () => {
    const five = analyzeRequest('기능 5가지를 설명해줘');
    assert.deepEqual(checkCoverage(five, '1. 하나\n2. 둘\n3. 셋\n4. 넷').map((i) => i.code), ['COUNT_SHORT']);
    assert.deepEqual(checkCoverage(five, '1. 하나\n2. 둘\n3. 셋\n4. 넷\n5. 다섯'), []);
    assert.deepEqual(checkCoverage(five, '**1. 하나**\n설명\n**2. 둘**\n설명\n**3. 셋**\n**4. 넷**\n**5. 다섯**'), [], 'bold-numbered headings count');
    assert.deepEqual(checkCoverage(five, '- a\n- b\n- c\n- d\n- e'), [], 'bullets count');
    const parts = analyzeRequest('1) 날짜 알려줘 2) 회의 조건 설명해줘 3) 영어로 요약해줘');
    assert.deepEqual(checkCoverage(parts, '1. 날짜\n2. 조건\n3. summary'), []);
    assert.deepEqual(checkCoverage(parts, '1. 날짜\n2. 조건').map((i) => i.code), ['PART_MISSING']);
    assert.deepEqual(checkCoverage(analyzeRequest('한국의 수도는?'), '서울입니다.'), [], 'a simple question has nothing to check');
  });
});

describe('what NAgex tells the model about itself is true', () => {
  const lines = capabilityBriefLines().join('\n');

  it('the list names real capabilities and the right limits; it never promises a Microsoft mailbox, video or running apps', () => {
    assert.match(lines, /WHAT NAGEX CAN REALLY DO/);
    assert.match(lines, /never with the general abilities of an AI model/);
    assert.match(lines, /Never answer "yes" to a capability that is not on the list/);
    const available = CAPABILITY_BRIEF.available.join('\n');
    assert.doesNotMatch(available, /outlook|onedrive|teams|video|weather|tutor/i);
    assert.match(CAPABILITY_BRIEF.notAvailable.join('\n'), /Video creation/);
    assert.match(CAPABILITY_BRIEF.notAvailable.join('\n'), /Microsoft mail, calendar, OneDrive and Teams/);
  });

  it('it agrees with the runtime: the routes it says are unsupported are unsupported, the approvals it promises are required, Microsoft is only planned', () => {
    assert.equal(decideRouting('30초 홍보 영상 만들어줘').kind, 'UNSUPPORTED');
    assert.equal(decideRouting('웹사이트 코드 작성해서 실행해줘').kind, 'UNSUPPORTED');
    const registry = new CapabilityRegistry();
    const byId = new Map(registry.list().map((c) => [c.id, c]));
    for (const id of ['google_calendar.create_event', 'google_calendar.update_event', 'google_calendar.cancel_event', 'gmail.send_email', 'gmail.reply']) {
      assert.equal(byId.get(id)?.approval, 'REQUIRED', `${id} needs approval, as the brief says`);
    }
    for (const id of ['google_calendar.list_events', 'github.list_repos', 'github.read_file']) assert.equal(byId.get(id)?.risk, 'READ_ONLY', id);
    const microsoft = CONNECTOR_CATALOG.filter((c) => c.provider === 'Microsoft');
    assert.ok(microsoft.length >= 3 && microsoft.every((c) => c.availability === 'PLANNED'), 'nothing Microsoft is available');
    assert.ok(![...byId.keys()].some((id) => /microsoft|outlook/i.test(id)));
  });
});

// ---- the chat call, with a scripted model ----
function scripted(answers: string[]): { service: AiService; seen: Array<{ system: string; user: string; turns: number }> } {
  const seen: Array<{ system: string; user: string; turns: number }> = [];
  let n = 0;
  const provider = new GeminiProvider({
    apiKey: 'k', model: 'gemini-test',
    fetchFn: (async (_url: any, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const contents = Array.isArray(body.contents) ? body.contents : [];
      seen.push({ system: String(body.systemInstruction?.parts?.[0]?.text ?? ''), user: String(contents[contents.length - 1]?.parts?.[0]?.text ?? ''), turns: contents.length });
      const text = answers[Math.min(n++, answers.length - 1)];
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }), { status: 200 });
    }) as typeof fetch,
  });
  return { service: new AiService(new UnifiedModelRouter([provider], { info: () => {}, warn: () => {} })), seen };
}
const ask = (service: AiService, message: string) => service.chat({ message, mode: 'auto', requestId: 'req_q' });
const items = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. 기능 ${i + 1}: 설명과 예시`).join('\n');

describe('the chat answer', () => {
  it('is asked with the product description and the duties of an answer - not "Be concise" - and the request\'s own shape', async () => {
    const { service, seen } = scripted([items(5)]);
    await ask(service, 'NAgex의 주요 기능 5가지를 각각 사용 예시와 함께 설명해줘.');
    const system = seen[0].system;
    assert.doesNotMatch(system, /Be concise/);
    assert.match(system, /WHAT NAGEX CAN REALLY DO/);
    assert.match(system, /Google Calendar \(after the person connects it\)/);
    assert.match(system, /every instruction in the request is answered/);
    assert.match(system, /give exactly 5/);
    assert.match(system, /Do not claim that any tool was executed/);
    assert.equal(seen.length, 1, 'a complete answer is not asked for twice');
  });

  it('a count that is not met is asked for once more, with what is missing; the better answer wins and no more than one retry happens', async () => {
    const { service, seen } = scripted([items(3), items(5)]);
    const result = await ask(service, 'NAgex의 주요 기능 5가지를 각각 설명해줘.');
    assert.equal(seen.length, 2);
    assert.equal(seen[1].turns, seen[0].turns + 2, 'the first answer and the correction were added');
    assert.match(seen[1].user, /asks for 5 items but the answer has 3/);
    assert.match(seen[1].user, /Write the COMPLETE answer again/);
    assert.equal(result.data.message, items(5));

    const never = scripted([items(3), items(3), items(5)]);
    const stuck = await ask(never.service, 'NAgex의 주요 기능 5가지를 각각 설명해줘.');
    assert.equal(never.seen.length, 2, 'one retry at most');
    assert.equal(stuck.data.message, items(3), 'an answer that did not improve is not swapped');

    const worse = scripted([items(4), items(2)]);
    assert.equal((await ask(worse.service, 'NAgex의 주요 기능 5가지를 설명해줘.')).data.message, items(4), 'the worse of the two is never kept');
  });

  it('a numbered request is told its parts and checked for their numbers', async () => {
    const complete = '1. 오늘은 2026년 10월 16일 금요일입니다.\n2. 목적, 참석자, 결론.\n3. A good meeting has a purpose, the right people and decisions.';
    const { service, seen } = scripted(['오늘은 금요일입니다. 회의는 목적이 중요합니다.', complete]);
    const result = await ask(service, '다음을 해줘. 1) 오늘 날짜와 요일 2) 좋은 회의 조건 설명 3) 위 내용을 영어 한 문장으로 요약');
    assert.match(seen[0].system, /has 3 parts: \(1\)/);
    assert.match(seen[1].user, /Parts 1, 2, 3 of the 3 requested are not answered under their numbers/);
    assert.equal(result.data.message, complete);
  });

  it('a simple question stays simple: told so, answered once, nothing checked', async () => {
    const { service, seen } = scripted(['한국의 수도는 서울입니다.']);
    const result = await ask(service, '한국의 수도는 어디야?');
    assert.match(seen[0].system, /simple question: answer it directly in one to three sentences/);
    assert.equal(seen.length, 1);
    assert.equal(result.data.message, '한국의 수도는 서울입니다.');
  });
});
