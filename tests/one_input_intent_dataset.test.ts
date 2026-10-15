// D-10 overnight Task D - measure the One Input router on REALISTIC phrasings it was not tuned on: Korean and English, polite / casual / terse, negatives, compound, ambiguous, connected-tool.
// Each row is a request a person could type and the decision that is SAFE and USEFUL. The test prints the accuracy per scenario and fails below the bar, so a regression in what people
// actually type is caught - not only in the examples the rules were written for. Pure classification, no model, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRouting, type RoutingKind, type ArtifactTarget } from '../src/workspace/input-router.js';

type Row = [scenario: string, text: string, kind: RoutingKind, target?: ArtifactTarget];

const ROWS: Row[] = [
  // A advice
  ['A', '내일 중요한 미팅이 있는데 어떻게 준비하면 좋을지 조언해줘', 'ADVICE'],
  ['A', '이번 분기 우선순위를 어떻게 정하면 좋을까요?', 'ADVICE'],
  ['A', '다음 주 출시 전에 점검할 것들을 추천해줘', 'ADVICE'],
  ['A', '팀 회의에서 무엇을 논의해야 할지 제안해줘', 'ADVICE'],
  ['A', 'What should I do first to get ready for the investor call tomorrow?', 'ADVICE'],
  ['A', 'Give me some advice on prioritizing my tasks this week', 'ADVICE'],
  ['A', 'Recommend what to focus on before the launch', 'ADVICE'],
  ['A', 'Help me prepare for tomorrow\'s performance review', 'ADVICE'],
  // B action / schedule
  ['B', '내일 오후 3시에 팀 미팅 잡아줘', 'ACTION_PLAN'],
  ['B', '다음 주 월요일 10시에 치과 예약해줘', 'ACTION_PLAN'],
  ['B', '금요일 점심 약속을 취소해줘', 'ACTION_PLAN'],
  ['B', '민수에게 회의 자료 메일로 보내줘', 'ACTION_PLAN'],
  ['B', '내일 아침 9시에 약 먹으라고 알려줘', 'ACTION_PLAN'],
  ['B', 'Book a meeting with Dana next Tuesday at 2pm', 'ACTION_PLAN'],
  ['B', 'Email Sam the meeting notes', 'ACTION_PLAN'],
  ['B', 'Please cancel my dentist appointment on Friday', 'ACTION_PLAN'],
  ['B', 'Remind me to pay the electricity bill tomorrow morning', 'ACTION_PLAN'],
  ['B', 'Invite Ana and Joe to the planning session on Thursday', 'ACTION_PLAN'],
  // C research
  ['C', '전기차 시장 최신 동향을 조사해줘', 'RESEARCH'],
  ['C', '경쟁사 3곳의 가격 정책을 리서치해서 출처도 알려줘', 'RESEARCH'],
  ['C', '생성형 AI 규제 현황을 출처와 함께 정리해줘', 'RESEARCH'],
  ['C', 'Research the current state of solid-state batteries and cite sources', 'RESEARCH'],
  ['C', 'Investigate how competitors price their subscription plans', 'RESEARCH'],
  ['C', 'Look up the latest news on quantum computing with sources', 'RESEARCH'],
  // D document
  ['D', '이번 주 회의 내용을 한 페이지 보고서로 써줘', 'CREATE_ARTIFACT', 'DOCUMENT'],
  ['D', '신제품 출시 계획서를 작성해줘', 'CREATE_ARTIFACT', 'DOCUMENT'],
  ['D', '프로젝트 진행 상황 요약 문서를 만들어줘', 'CREATE_ARTIFACT', 'DOCUMENT'],
  ['D', 'Write a one-page memo about our hiring plan', 'CREATE_ARTIFACT', 'DOCUMENT'],
  ['D', 'Draft a proposal for the new onboarding flow', 'CREATE_ARTIFACT', 'DOCUMENT'],
  ['D', 'Create a report summarizing last quarter\'s results', 'CREATE_ARTIFACT', 'DOCUMENT'],
  // E slides
  ['E', '신규 서비스 소개 발표 자료를 10장으로 만들어줘', 'CREATE_ARTIFACT', 'PRESENTATION'],
  ['E', '분기 실적을 슬라이드로 만들어줘', 'CREATE_ARTIFACT', 'PRESENTATION'],
  ['E', '투자자 설명용 PPT 만들어줘', 'CREATE_ARTIFACT', 'PRESENTATION'],
  ['E', 'Make a 12 slide deck about our product roadmap', 'CREATE_ARTIFACT', 'PRESENTATION'],
  ['E', 'Build a presentation on remote work best practices', 'CREATE_ARTIFACT', 'PRESENTATION'],
  // F image
  ['F', '노을 지는 바다 이미지를 만들어줘', 'CREATE_ARTIFACT', 'IMAGE'],
  ['F', '우리 카페 로고 디자인해줘', 'CREATE_ARTIFACT', 'IMAGE'],
  ['F', '귀여운 고양이 그림 그려줘', 'CREATE_ARTIFACT', 'IMAGE'],
  ['F', 'Generate a poster image for a jazz night', 'CREATE_ARTIFACT', 'IMAGE'],
  ['F', 'Draw a mountain landscape at dawn', 'CREATE_ARTIFACT', 'IMAGE'],
  // G unsupported
  ['G', '제품 소개 영상을 만들어줘', 'UNSUPPORTED', 'VIDEO'],
  ['G', '30초짜리 광고 동영상 제작해줘', 'UNSUPPORTED', 'VIDEO'],
  ['G', '간단한 게임 앱을 만들어서 배포해줘', 'UNSUPPORTED', 'CODE'],
  ['G', '웹사이트를 만들어서 실행해줘', 'UNSUPPORTED', 'CODE'],
  ['G', 'Create a promo video for our launch', 'UNSUPPORTED', 'VIDEO'],
  ['G', 'Build me a web app and deploy it', 'UNSUPPORTED', 'CODE'],
  // H compound research -> document / slides
  ['H', '전기차 시장을 조사해서 보고서로 만들어줘', 'CREATE_ARTIFACT', 'DOCUMENT'],
  ['H', '경쟁사 동향을 리서치해서 발표 자료로 정리해줘', 'CREATE_ARTIFACT', 'PRESENTATION'],
  ['H', 'Research the EV market and write a report on it', 'CREATE_ARTIFACT', 'DOCUMENT'],
  ['H', 'Investigate competitor pricing and turn it into slides', 'CREATE_ARTIFACT', 'PRESENTATION'],
  // I explain + send
  ['I', '이 내용을 설명하고 팀에 메일로 보내줘', 'ACTION_PLAN'],
  ['I', 'Summarize this and email it to the team', 'ACTION_PLAN'],
  // J destructive
  ['J', '지난달 보고서 삭제해줘', 'ACTION_PLAN'],
  ['J', '내 일정 전부 지워줘', 'ACTION_PLAN'],
  ['J', 'Delete all my old drafts', 'ACTION_PLAN'],
  ['J', 'Remove the meeting from my calendar', 'ACTION_PLAN'],
  // K negated
  ['K', '메일은 보내지 말고 내용만 작성해줘', 'CONVERSATION'],
  ['K', '아직 보내지 마, 초안만 보여줘', 'CONVERSATION'],
  ['K', 'Don\'t send anything, just show me a draft reply', 'CONVERSATION'],
  ['K', 'Write the email but do not send it', 'CONVERSATION'],
  // L vague
  ['L', '그거 좀 해줘', 'CLARIFY'],
  ['L', '도와줘', 'CLARIFY'],
  ['L', 'Do it', 'CLARIFY'],
  ['L', 'Help', 'CLARIFY'],
  // M connected tool named naturally
  ['M', '내 연동 도구로 "안녕하세요" 메시지를 보내줘', 'ACTION_PLAN'],
  ['M', '연결된 도구를 사용해서 이 문장을 실행해줘', 'ACTION_PLAN'],
  ['M', 'Use my connected tool to echo "ready"', 'ACTION_PLAN'],
  ['M', 'Run the tool I connected with the message "hello"', 'ACTION_PLAN'],
  // plain conversation / questions (must NOT become actions, advice, or creations)
  ['Q', '오늘 날씨 어때?', 'CONVERSATION'],
  ['Q', '파이썬에서 리스트와 튜플의 차이가 뭐야?', 'CONVERSATION'],
  ['Q', '이메일은 어떻게 보내나요?', 'CONVERSATION'],
  ['Q', '일정을 삭제하면 어떻게 되나요?', 'CONVERSATION'],
  ['Q', 'What is the difference between a stock and a bond?', 'CONVERSATION'],
  ['Q', 'How do I cancel a calendar event in general?', 'CONVERSATION'],
  ['Q', 'Why is the sky blue?', 'CONVERSATION'],
  ['Q', '안녕', 'CONVERSATION'],
  ['Q', 'thanks, that was helpful', 'CONVERSATION'],
  ['Q', '고마워요', 'CONVERSATION'],
  ['Q', 'Tell me about the history of the printing press', 'CONVERSATION'],
  ['Q', 'Translate "good morning" into Korean', 'CONVERSATION'],
  ['Q', '이 문장을 영어로 번역해줘: 오늘 날씨가 좋네요', 'CONVERSATION'],
];

test('the router on realistic phrasings: per-scenario accuracy, and the safety-critical scenarios are exact', () => {
  const failures: string[] = [];
  const per = new Map<string, { ok: number; total: number }>();
  for (const [scenario, text, kind, target] of ROWS) {
    const d = decideRouting(text);
    const ok = d.kind === kind && (target === undefined || d.targetArtifactType === target);
    const stat = per.get(scenario) ?? { ok: 0, total: 0 };
    stat.total += 1;
    if (ok) stat.ok += 1;
    per.set(scenario, stat);
    if (!ok) failures.push(`[${scenario}] "${text}" -> ${d.kind}${d.targetArtifactType ? '/' + d.targetArtifactType : ''}, expected ${kind}${target ? '/' + target : ''}`);
  }
  const summary = [...per.entries()].map(([s, v]) => `${s} ${v.ok}/${v.total}`).join('  ');
  console.log(`router accuracy: ${ROWS.length - failures.length}/${ROWS.length}  (${summary})`);
  for (const f of failures) console.log('  MISS ' + f);
  // safety: an action, a destructive request, a negation, an unsupported kind and a plain question are NEVER misrouted
  const safety = ['B', 'I', 'J', 'K', 'G', 'Q'];
  const safetyMisses = failures.filter((f) => safety.some((s) => f.startsWith(`[${s}]`)));
  assert.deepEqual(safetyMisses, [], 'no safety-critical scenario may be misrouted');
  assert.deepEqual(failures, [], 'every realistic phrasing is routed as expected');
});
