// D-11 One Input, Any Outcome - the SERVER-OWNED routing contract. Table-driven: every row is a request a person could type (Korean and English), and the exact decision
// NAgex must make. The decision is advice about routing only; these tests also prove it can never create authority: nothing executes from a keyword, a negated action never
// becomes an action, an action is always an approval-gated plan, and what NAgex cannot do (video, a running code app) is said to be unsupported - never routed to a chat
// answer that pretends to be the deliverable. Pure classification + the real HTTP route; no model is called here (the real Nemotron runs are in the certification report).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InputRouter, decideRouting, type RoutingKind, type ArtifactTarget, type NeedCapability } from '../src/workspace/input-router.js';
import { detectRequestLanguage, languageInstruction } from '../src/common/request-language.js';
import { AiService } from '../src/model-gateway/ai-service.js';
import { UnifiedModelRouter } from '../src/model-gateway/unified-model-router.js';
import { NebiusProvider } from '../src/model-gateway/providers.js';
import { handleAsyncApiRequest } from '../src/server_web.js';
import { authAs } from './_s1_session_auth.js';

interface Row {
  id: string;
  text: string;
  kind: RoutingKind;
  target?: ArtifactTarget;
  needs: NeedCapability[];
  negated?: boolean;
  destructive?: boolean;
  ambiguity?: 'HIGH';
  supported?: false;
  legacy?: 'ASK' | 'COMMAND' | 'CAPTURE';
}

// The 12 acceptance scenarios (A-L) of the directive, Korean first and an English twin for each.
const ROWS: Row[] = [
  // A. advice: no executable plan, no action
  { id: 'A-ko', text: '내일 회의를 어떻게 준비하면 좋을까?', kind: 'ADVICE', needs: ['ADVICE'] },
  { id: 'A-en', text: "How should I prepare for tomorrow's meeting?", kind: 'ADVICE', needs: ['ADVICE'] },
  // B. action: a plan that needs approval before anything external changes
  { id: 'B-ko', text: '내일 오전 10시에 프로젝트 리뷰 회의를 잡아줘', kind: 'ACTION_PLAN', needs: ['ACTION'] },
  { id: 'B-en', text: 'Schedule a project review meeting tomorrow at 10 AM', kind: 'ACTION_PLAN', needs: ['ACTION'] },
  // C. research with sources
  { id: 'C-ko', text: '최근 AI 동향을 조사해서 출처와 함께 알려줘', kind: 'RESEARCH', needs: ['RESEARCH'] },
  { id: 'C-en', text: 'Research the latest AI trends and cite sources', kind: 'RESEARCH', needs: ['RESEARCH'] },
  // D. a document
  { id: 'D-ko', text: '이번 회의 내용을 한 페이지 보고서로 작성해줘', kind: 'CREATE_ARTIFACT', target: 'DOCUMENT', needs: ['DOCUMENT'] },
  { id: 'D-en', text: 'Write a one-page report on this meeting', kind: 'CREATE_ARTIFACT', target: 'DOCUMENT', needs: ['DOCUMENT'] },
  // E. slides
  { id: 'E-ko', text: '이 주제로 10장 슬라이드 만들어줘', kind: 'CREATE_ARTIFACT', target: 'PRESENTATION', needs: ['PRESENTATION'], ambiguity: 'HIGH' },
  { id: 'E-ko2', text: '로드맵을 10장 슬라이드로 만들어줘', kind: 'CREATE_ARTIFACT', target: 'PRESENTATION', needs: ['PRESENTATION'] },
  { id: 'E-en', text: 'Create a 10 slide deck about our roadmap', kind: 'CREATE_ARTIFACT', target: 'PRESENTATION', needs: ['PRESENTATION'] },
  // F. an image (a request that says nothing about what to draw asks ONE question instead of spending a provider call)
  { id: 'F-ko', text: '이런 이미지를 만들어줘', kind: 'CREATE_ARTIFACT', target: 'IMAGE', needs: ['IMAGE'], ambiguity: 'HIGH' },
  { id: 'F-ko2', text: '일출의 산 풍경 이미지를 만들어줘', kind: 'CREATE_ARTIFACT', target: 'IMAGE', needs: ['IMAGE'] },
  { id: 'F-en', text: 'Generate an image of a mountain at sunrise', kind: 'CREATE_ARTIFACT', target: 'IMAGE', needs: ['IMAGE'] },
  // G. unsupported capability: said plainly, never faked
  { id: 'G-ko-video', text: '30초 홍보영상 만들어줘', kind: 'UNSUPPORTED', target: 'VIDEO', needs: ['VIDEO'], supported: false },
  { id: 'G-en-video', text: 'Make a 30 second promo video', kind: 'UNSUPPORTED', target: 'VIDEO', needs: ['VIDEO'], supported: false },
  { id: 'G-ko-code', text: '웹사이트 코드 작성해서 실행해줘', kind: 'UNSUPPORTED', target: 'CODE', needs: ['CODE'], supported: false },
  { id: 'G-en-code', text: 'Build a website and run it', kind: 'UNSUPPORTED', target: 'CODE', needs: ['CODE'], supported: false },
  // H. compound: research THEN a document - recognised as a compound, in order
  { id: 'H-ko', text: 'AI 동향을 조사해서 보고서로 만들어줘', kind: 'CREATE_ARTIFACT', target: 'DOCUMENT', needs: ['RESEARCH', 'DOCUMENT'] },
  { id: 'H-en', text: 'Research the AI market and turn it into a report', kind: 'CREATE_ARTIFACT', target: 'DOCUMENT', needs: ['RESEARCH', 'DOCUMENT'] },
  // I. mixed with a real-world consequence: still an approval-gated plan
  { id: 'I-ko', text: '설명해줘 그리고 이메일로 보내줘', kind: 'ACTION_PLAN', needs: ['ANSWER', 'ACTION'] },
  { id: 'I-en', text: 'Explain it and then email it to Alex', kind: 'ACTION_PLAN', needs: ['ANSWER', 'ACTION'] },
  // J. destructive: never auto-executed from a keyword
  { id: 'J-ko', text: '이 문서를 지워줘', kind: 'ACTION_PLAN', needs: ['ACTION'], destructive: true },
  { id: 'J-en', text: 'Delete this document', kind: 'ACTION_PLAN', needs: ['ACTION'], destructive: true },
  // K. negated send: a draft is text, not an action
  { id: 'K-ko', text: '보내지 말고 이메일 초안만 작성해줘', kind: 'CONVERSATION', needs: ['ANSWER'], negated: true },
  { id: 'K-en', text: 'Do not send it, just draft the email', kind: 'CONVERSATION', needs: ['ANSWER'], negated: true },
  // L. vague: one minimal question, nothing runs
  { id: 'L-ko', text: '그거 해줘', kind: 'CLARIFY', needs: [], ambiguity: 'HIGH' },
  { id: 'L-en', text: 'help', kind: 'CLARIFY', needs: [], ambiguity: 'HIGH' },
  // plain questions stay conversations, even with an action word inside them
  { id: 'Q-en-1', text: 'How do I send an email in NAgex?', kind: 'CONVERSATION', needs: ['ANSWER'] },
  { id: 'Q-en-2', text: 'What is NAgex architecture?', kind: 'CONVERSATION', needs: ['ANSWER'] },
  { id: 'Q-en-3', text: 'How do I optimize Nebius Token Factory?', kind: 'CONVERSATION', needs: ['ANSWER'] },
  { id: 'Q-ko-1', text: '일정은 어떻게 잡나요?', kind: 'CONVERSATION', needs: ['ANSWER'] },
  { id: 'Q-ko-2', text: '회의 안건 만들어줘', kind: 'CONVERSATION', needs: ['ANSWER'] },
  { id: 'Q-ko-3', text: '네이젝스가 뭐야? 두 문장으로 설명해줘.', kind: 'CONVERSATION', needs: ['ANSWER'] },
  { id: 'Q-en-4', text: 'Explain how OAuth works', kind: 'CONVERSATION', needs: ['ANSWER'] },
  { id: 'Q-en-5', text: 'What should I focus on this week to keep the launch on track?', kind: 'ADVICE', needs: ['ADVICE'] },
  // more phrasings of the same intents
  { id: 'X-1', text: 'Can you send an email to Alex saying the report is ready?', kind: 'ACTION_PLAN', needs: ['ACTION'] },
  { id: 'T-en', text: 'Use my test tool to echo "approval check 42"', kind: 'ACTION_PLAN', needs: ['ACTION'] },
  { id: 'T-ko', text: '내 테스트 도구를 사용해서 "안녕" 메시지를 보내줘', kind: 'ACTION_PLAN', needs: ['ACTION'] },
  { id: 'T-ko2', text: '연동된 도구로 이 메시지를 실행해줘', kind: 'ACTION_PLAN', needs: ['ACTION'] },
  { id: 'T-q', text: 'What does the MCP tool protocol do?', kind: 'CONVERSATION', needs: ['ANSWER'] },
  { id: 'X-2', text: '알렉스에게 보고서가 준비됐다고 메일을 보내줘', kind: 'ACTION_PLAN', needs: ['ACTION'] },
  { id: 'X-3', text: '금요일 오후 3시 회의를 취소해줘', kind: 'ACTION_PLAN', needs: ['ACTION'], destructive: true },
  { id: 'X-4', text: '고양이 그림 그려줘', kind: 'CREATE_ARTIFACT', target: 'IMAGE', needs: ['IMAGE'] },
  { id: 'X-5', text: '이 내용을 발표 자료로 정리해줘', kind: 'CREATE_ARTIFACT', target: 'PRESENTATION', needs: ['PRESENTATION'], ambiguity: 'HIGH' },
  { id: 'X-6', text: '프로젝트 현황을 요약하고 우선순위를 추천해줘', kind: 'ADVICE', needs: ['ADVICE'] },
  { id: 'X-7', text: 'What should I focus on this week to keep the launch on track?', kind: 'ADVICE', needs: ['ADVICE'] },
  { id: 'X-8', text: '앱 소개서 만들어줘', kind: 'CREATE_ARTIFACT', target: 'DOCUMENT', needs: ['DOCUMENT'] },
  { id: 'X-9', text: '메모: 내일 병원 예약 확인', kind: 'CAPTURE', needs: ['CAPTURE'], legacy: 'CAPTURE' },
  { id: 'X-10', text: 'Remember to review the security policy', kind: 'CAPTURE', needs: ['CAPTURE'], legacy: 'CAPTURE' },
  { id: 'X-11', text: 'Please do not delete anything, only summarize the notes', kind: 'ADVICE', needs: ['ADVICE'], negated: true },
  { id: 'X-12', text: '삭제하지 말고 메일 내용을 요약해줘', kind: 'CONVERSATION', needs: ['ANSWER'], negated: true },
];

describe('the routing decision for the 12 scenarios (Korean and English)', () => {
  for (const row of ROWS) {
    it(`${row.id}: ${row.text}`, () => {
      const result = InputRouter.classify({ text: row.text });
      const d = result.decision;
      assert.equal(d.kind, row.kind, `kind of "${row.text}"`);
      assert.equal(d.targetArtifactType, row.target ?? null, 'target artifact');
      assert.deepEqual(d.needs.map((n) => n.capability), row.needs, 'ordered needs');
      assert.equal(d.compound, row.needs.length > 1, 'compound flag follows the needs');
      assert.equal(d.executionNegated, row.negated === true, 'negation flag');
      assert.equal(d.destructive, row.destructive === true, 'destructive flag');
      assert.equal(d.ambiguity.level, row.ambiguity ?? 'NONE', 'ambiguity');
      assert.equal(d.supported, row.supported !== false, 'supported');
      if (row.legacy) assert.equal(result.primaryIntent, row.legacy);
      assert.equal(d.version, 1);
      assert.ok(d.confidence > 0 && d.confidence <= 1);
      assert.ok(Array.isArray(d.reasonCodes) && d.reasonCodes.length > 0 || row.kind === 'CAPTURE', 'there is always a reason code');
    });
  }
});

describe('the decision can never create authority', () => {
  it('every ACTION_PLAN is external-consequential, approval-required, and keeps the legacy COMMAND intent; nothing else is', () => {
    for (const row of ROWS) {
      const r = InputRouter.classify({ text: row.text });
      if (r.decision.kind === 'ACTION_PLAN') {
        assert.equal(r.decision.permissionRisk, 'EXTERNAL_CONSEQUENTIAL', row.id);
        assert.equal(r.primaryIntent, 'COMMAND', row.id);
        assert.ok(r.decision.needs.some((n) => n.capability === 'ACTION' && n.approvalRequired === true), `${row.id}: the action need requires approval`);
        assert.ok(r.decision.reasonCodes.includes('APPROVAL_REQUIRED'), row.id);
      } else {
        assert.notEqual(r.decision.permissionRisk, 'EXTERNAL_CONSEQUENTIAL', `${row.id}: only an action plan may carry external consequence`);
        assert.notEqual(r.primaryIntent, 'COMMAND', row.id);
        assert.ok(r.decision.needs.every((n) => n.approvalRequired !== true), row.id);
      }
    }
  });

  it('a negated action never becomes an action - in either language, with several verbs, and with a different verb that IS requested', () => {
    for (const text of [
      '메일을 보내지 말고 초안만 써줘', '보내지는 말고 내용만 정리해줘', '삭제하지 말고 그대로 두고 요약해줘', '예약하지 마',
      "Don't send the email, just write it", 'Please do not delete the file', 'Draft the reply without sending it', 'Never post this, only draft it',
    ]) {
      const d = decideRouting(text);
      assert.notEqual(d.kind, 'ACTION_PLAN', text);
      assert.equal(d.executionNegated, true, text);
      assert.equal(d.permissionRisk === 'EXTERNAL_CONSEQUENTIAL', false, text);
    }
    // the negation only covers the negated verb: asking for a DIFFERENT consequential thing still needs a (gated) plan
    const mixed = decideRouting('보내지 말고 삭제해줘');
    assert.equal(mixed.kind, 'ACTION_PLAN');
    assert.equal(mixed.destructive, true);
    assert.equal(mixed.executionNegated, true);
  });

  it('a consequential verb inside a QUESTION is a conversation, but a request that merely starts like a question is still an action', () => {
    for (const text of ['How do I cancel a meeting?', 'What happens if I delete a task?', '이메일은 어떻게 보내나요?', '일정을 삭제하면 어떻게 되나요?']) {
      assert.equal(decideRouting(text).kind === 'ACTION_PLAN', false, text);
    }
    for (const text of ['Can you cancel my 3 PM meeting?', 'Could you email Alex the summary?', '메일 좀 보내줄 수 있어?', 'Explain the plan and then send it to the team']) {
      assert.equal(decideRouting(text).kind, 'ACTION_PLAN', text);
    }
  });

  it('an explicit shortcut can bias a plain request toward an artifact but never overrides an action or an unsupported kind', () => {
    const base = 'Q3 시장 상황';
    assert.equal(decideRouting(base).kind, 'CONVERSATION');
    assert.equal(decideRouting(base, { hint: { artifactType: 'DOCUMENT' } }).targetArtifactType, 'DOCUMENT');
    assert.equal(decideRouting(base, { hint: { artifactType: 'IMAGE' } }).targetArtifactType, 'IMAGE');
    assert.equal(decideRouting(base, { hint: { capability: 'RESEARCH' } }).kind, 'RESEARCH');
    assert.deepEqual(decideRouting(base, { hint: { artifactType: 'DOCUMENT' } }).reasonCodes.includes('EXPLICIT_SHORTCUT'), true);
    // a shortcut cannot turn an action into something else, nor an unsupported kind into a supported one
    assert.equal(decideRouting('이 문서를 지워줘', { hint: { artifactType: 'DOCUMENT' } }).kind, 'ACTION_PLAN');
    assert.equal(decideRouting('Delete this report', { hint: { artifactType: 'DOCUMENT' } }).kind, 'ACTION_PLAN');
    assert.equal(decideRouting('30초 홍보영상 만들어줘', { hint: { artifactType: 'IMAGE' } }).kind, 'UNSUPPORTED');
    assert.equal(decideRouting('웹사이트 만들어서 배포해줘', { hint: { artifactType: 'DOCUMENT' } }).kind, 'UNSUPPORTED');
    // an unknown hint is ignored
    assert.equal(decideRouting(base, { hint: { artifactType: 'WEIRD', capability: 'PLAN' } }).kind, 'CONVERSATION');
  });

  it('research feeds a document or slides, but an image is made from the description alone: no research need is promised for it, and the reason is recorded', () => {
    for (const text of ['서울 야경을 조사해서 이미지로 만들어줘', 'Research the Seoul skyline and generate an image of it']) {
      const d = decideRouting(text);
      assert.equal(d.kind, 'CREATE_ARTIFACT', text);
      assert.equal(d.targetArtifactType, 'IMAGE', text);
      assert.deepEqual(d.needs.map((n) => n.capability), ['IMAGE'], text);
      assert.equal(d.compound, false, text);
      assert.ok(d.reasonCodes.includes('RESEARCH_NOT_USED_FOR_IMAGE'), text);
    }
    for (const [text, target] of [['전기차 시장을 조사해서 보고서로 만들어줘', 'DOCUMENT'], ['경쟁사를 리서치해서 발표 자료로 정리해줘', 'PRESENTATION']] as const) {
      const d = decideRouting(text);
      assert.equal(d.targetArtifactType, target, text);
      assert.deepEqual(d.needs.map((n) => n.capability), ['RESEARCH', target], text);
      assert.equal(d.compound, true, text);
      assert.ok(!d.reasonCodes.includes('RESEARCH_NOT_USED_FOR_IMAGE'), text);
    }
  });

  it('unsupported kinds are marked unsupported, say which, and are not creatable artifacts', () => {
    for (const text of ['30초 홍보영상 만들어줘', 'Create a short animation clip', '웹사이트 코드 작성해서 실행해줘', 'Deploy my app to a server', '게임 만들어줘']) {
      const d = decideRouting(text);
      assert.equal(d.kind, 'UNSUPPORTED', text);
      assert.equal(d.supported, false, text);
      assert.ok(d.targetArtifactType === 'VIDEO' || d.targetArtifactType === 'CODE', text);
      assert.equal(d.needs.every((n) => n.supported === false), true, text);
    }
    // a document ABOUT a video or an app is a document
    assert.equal(decideRouting('앱 출시 계획서를 작성해줘').kind, 'CREATE_ARTIFACT');
    assert.equal(decideRouting('Summarize this video').kind === 'UNSUPPORTED', false);
    assert.equal(decideRouting('영상 내용을 요약해줘').kind === 'UNSUPPORTED', false);
  });

  it('classification is pure: the same input gives the same decision, and the route needs a signed-in caller', async () => {
    for (const row of ROWS.slice(0, 12)) assert.deepEqual(InputRouter.classify({ text: row.text }), InputRouter.classify({ text: row.text }));
    const unauth = await handleAsyncApiRequest('POST', '/api/v1/workspace/route-input', { text: 'hello' }, {});
    assert.equal(unauth.status, 401);
  });
});

describe('legacy classification is unchanged', () => {
  it('upload, audio, link and capture keep their intents; the legacy ASK / COMMAND split follows the decision', () => {
    assert.equal(InputRouter.classify({ text: 'document.pdf', hasFile: true, mimeType: 'application/pdf' }).primaryIntent, 'UPLOAD');
    assert.equal(InputRouter.classify({ text: '', hasFile: true }).decision.kind, 'CAPTURE');
    assert.equal(InputRouter.classify({ text: '이 파일을 요약해줘', hasFile: true }).decision.kind, 'ADVICE');
    assert.equal(InputRouter.classify({ text: 'recording.webm', hasAudio: true, mimeType: 'audio/webm' }).primaryIntent, 'AUDIO_CAPTURE');
    const link = InputRouter.classify({ text: 'https://nebius.com/docs/storage' });
    assert.equal(link.primaryIntent, 'LINK_CAPTURE');
    assert.equal(link.normalizedPayload.url, 'https://nebius.com/docs/storage');
    assert.equal(InputRouter.classify({ text: 'What is the latest NVIDIA Nemotron model?' }).primaryIntent, 'ASK');
    assert.equal(InputRouter.classify({ text: 'Schedule a meeting tomorrow at 3 PM.' }).primaryIntent, 'COMMAND');
    const korean = InputRouter.classify({ text: '메모: 내일 병원 예약 확인' });
    assert.equal(korean.primaryIntent, 'CAPTURE');
    assert.equal(korean.normalizedPayload.cleanText, '내일 병원 예약 확인');
  });

  it('with an attachment present, a request with no topic of its own is not asked "what topic" (the attachment is the topic)', () => {
    assert.equal(decideRouting('이런 이미지를 만들어줘', { hasAttachment: true }).ambiguity.level, 'NONE');
    assert.equal(decideRouting('이런 이미지를 만들어줘', { hasAttachment: false }).ambiguity.level, 'HIGH');
  });
});

describe('the real HTTP route returns the same decision, and creates nothing', () => {
  it('POST /api/v1/workspace/route-input for scenarios A-L returns the table decision as JSON, with the optional shortcut applied server-side', async () => {
    const headers = authAs('ten_one_input', 'usr_one_input');
    for (const row of ROWS) {
      const res = await handleAsyncApiRequest('POST', '/api/v1/workspace/route-input', { text: row.text }, headers);
      assert.equal(res.status, 200, row.id);
      const data = res.data as any;
      assert.equal(data.decision.kind, row.kind, row.id);
      assert.deepEqual(data.decision.needs.map((n: any) => n.capability), row.needs, row.id);
      // pure classification: no record of any kind is created or referenced by the response
      for (const key of ['captureId', 'taskId', 'candidateId', 'approvalId', 'executionId', 'planId', 'artifactId']) assert.equal(data[key], undefined, `${row.id}: ${key}`);
    }
    const hinted = await handleAsyncApiRequest('POST', '/api/v1/workspace/route-input', { text: 'Q3 시장 상황', requestMetadata: { preferredArtifactType: 'DOCUMENT', preferredCapability: null } }, headers);
    assert.equal((hinted.data as any).decision.targetArtifactType, 'DOCUMENT');
    const overridden = await handleAsyncApiRequest('POST', '/api/v1/workspace/route-input', { text: '이 문서를 지워줘', requestMetadata: { preferredArtifactType: 'DOCUMENT' } }, headers);
    assert.equal((overridden.data as any).decision.kind, 'ACTION_PLAN');
    assert.equal((overridden.data as any).primaryIntent, 'COMMAND');
  });

  it('route-input leaves the person\'s approvals, tasks and executions exactly as they were', async () => {
    const headers = authAs('ten_one_input_b', 'usr_one_input_b');
    const count = async (path: string, key: string) => ((await handleAsyncApiRequest('GET', path, null, headers)).data as any)?.[key]?.length ?? -1;
    const before = [await count('/api/v1/approvals', 'approvals'), await count('/api/v1/tasks', 'tasks')];
    for (const row of ROWS) await handleAsyncApiRequest('POST', '/api/v1/workspace/route-input', { text: row.text }, headers);
    const after = [await count('/api/v1/approvals', 'approvals'), await count('/api/v1/tasks', 'tasks')];
    assert.deepEqual(after, before);
  });
});

describe('the request language', () => {
  it('is read from the request itself', () => {
    assert.equal(detectRequestLanguage('내일 회의를 준비해줘'), 'ko');
    assert.equal(detectRequestLanguage('AI 동향을 조사해줘'), 'ko', 'Latin words inside a Korean request do not make it English');
    assert.equal(detectRequestLanguage('Prepare tomorrow\'s meeting'), 'en');
    assert.equal(detectRequestLanguage('NVIDIA 뉴스'), 'ko');
    assert.equal(detectRequestLanguage('こんにちは'), 'other');
    assert.equal(detectRequestLanguage('1234 !!'), 'unknown');
    assert.equal(detectRequestLanguage(undefined), 'unknown');
  });

  it('turns into one prompt line: Korean is named, any other language is "the language of the request", and protocol values stay English', () => {
    assert.match(languageInstruction('ko'), /Korean/);
    assert.match(languageInstruction('ko'), /JSON keys, enum values and tool or skill identifiers in English/);
    assert.match(languageInstruction('en'), /same language as the request/);
    assert.doesNotMatch(languageInstruction('en'), /Korean/);
    assert.match(languageInstruction('other'), /same language as the request/);
  });
});

// A Korean request must reach the model WITH an instruction to answer in Korean (the plan and chat prompts used to be all English with no language rule, so the
// model answered in English). Fake provider endpoint: this proves what the prompt says, NOT how a real model obeys it (see the certification report).
describe('the model prompts carry the language of the request', () => {
  const NEMOTRON = 'nvidia/Nemotron-3_5-Lightning';
  const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
  async function systemPromptFor(run: (svc: AiService) => Promise<unknown>): Promise<string> {
    const seen: string[] = [];
    const provider = new NebiusProvider({ apiKey: 'k', model: NEMOTRON, fetchFn: (async (_u: any, init: any) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      seen.push(String((body.messages ?? []).find((m: any) => m.role === 'system')?.content ?? ''));
      return ok('{}');
    }) as typeof fetch });
    const svc = new AiService(new UnifiedModelRouter([provider], { info: () => {}, warn: () => {} }));
    await run(svc).catch(() => undefined);
    assert.ok(seen.length >= 1, 'the model was asked');
    return seen[0];
  }

  it('plan, chat and research: Korean request -> an explicit Korean instruction; English request -> "the language of the request"; protocol values stay English', async () => {
    const plan = (prompt: string) => systemPromptFor((svc) => svc.plan({ prompt, memories: [], mode: 'auto', requestId: 'r_lang_plan', allowAdvisory: true }));
    const chat = (message: string) => systemPromptFor((svc) => svc.chat({ message, mode: 'auto', requestId: 'r_lang_chat' }));
    const research = (query: string) => systemPromptFor((svc) => svc.research({ query, evidencePack: { evidencePackId: 'ep', sources: [] } as any, mode: 'auto', requestId: 'r_lang_research' }));
    for (const make of [plan, chat, research]) {
      const ko = await make('내일 회의를 준비해줘');
      assert.match(ko, /LANGUAGE: the request is written in Korean/);
      assert.match(ko, /natural Korean/);
      assert.match(ko, /JSON keys, enum values and tool or skill identifiers in English/);
      const en = await make('Prepare tomorrow\'s meeting');
      assert.match(en, /LANGUAGE: write every text the person will read in the same language as the request/);
      assert.doesNotMatch(en, /written in Korean/);
    }
  });
});
