import type { HomeItem, PersonalHomeResponse } from '../src/home/personal-home.service.js';

export type HomeScenarioId =
  | 'S1_EMPTY'
  | 'S2_BUSY_DAY'
  | 'S3_WORKING'
  | 'S4_APPROVALS'
  | 'S5_MIXED_LIFECYCLE'
  | 'S6_MEMORY_RICH'
  | 'S7_RESULTS_RICH'
  | 'S8_FULL_HOME'
  | 'S9_DEGRADED'
  | 'S10_LONG_CONTENT';

export interface HomeScenarioFixture {
  id: HomeScenarioId;
  response: PersonalHomeResponse;
  expectedIdentity: 'PERSONAL_AI';
}

const now = '2026-10-06T09:00:00.000Z';

function action(type: string, label: string, targetUrl?: string) {
  return { type, label, targetUrl };
}

function item(id: string, type: string, title: string, summary: string, state: PersonalHomeResponse['needsAttention'][number]['state'], actionType: string, label = 'Open'): HomeItem {
  const sourceType: HomeItem['sourceType'] = type === 'APPROVAL' ? 'APPROVAL' : 'TASK';
  return {
    id,
    type,
    title,
    summary,
    sourceType,
    sourceId: id,
    state,
    createdAt: now,
    action: action(actionType, label, `#${id}`),
  };
}

function base(): PersonalHomeResponse {
  return {
    generatedAt: now,
    rightNow: null,
    upcoming: [],
    today: {
      briefStatus: 'READY',
      freshness: 'FRESH',
      summary: null,
      meetings: [],
      counts: { meetings: 0, emails: 0, tasks: 0, approvals: 0 },
    },
    needsAttention: [],
    preparedForYou: [],
    workingForYou: [],
    recentResults: [],
    memoryContext: [],
    creationActions: [
      { id: 'RESEARCH', title: 'Research', description: 'Find and synthesize verified information.', action: action('START_RESEARCH', 'Start research') },
      { id: 'ANALYZE', title: 'Analyze', description: 'Understand supported documents and files.', action: action('START_ANALYSIS', 'Choose a file') },
    ],
    recentCreations: [],
    suggestions: [],
    sourceStatus: { calendar: 'CONNECTED', gmail: 'CONNECTED', activity: 'OK', tasks: 'OK' },
    userProfile: { name: 'Alex' },
  };
}

function meeting(id: string, title: string, summary: string, hour: number) {
  return {
    id,
    title,
    summary,
    startsAt: `2026-10-06T${String(hour).padStart(2, '0')}:15:00.000Z`,
    endsAt: `2026-10-06T${String(hour + 1).padStart(2, '0')}:00:00.000Z`,
    state: 'Prepared' as const,
    sourceRef: id,
    action: action('OPEN_CALENDAR_ITEM', 'Open', `#${id}`),
  };
}

function memory(id: string, type: string, title: string, summary: string) {
  return { id, type, title, summary, sourceType: 'MEMORY' as const, sourceId: id };
}

function withRecent(target: PersonalHomeResponse, id: string, type: string, title: string, summary: string) {
  target.recentResults.push({
    id,
    type,
    title,
    summary,
    sourceType: 'ACTIVITY',
    sourceId: id,
    state: 'Completed',
    createdAt: now,
    action: action('OPEN_ARTIFACT', 'Open', `#${id}`),
  });
}

function buildScenarios(): HomeScenarioFixture[] {
  const s1 = base();

  const s2 = base();
  s2.today.meetings = [
    meeting('meeting-1', 'Client strategy meeting', 'Prep notes and prior context are ready.', 8),
    meeting('meeting-2', 'Design review', 'Review Home visual certification screenshots.', 10),
    meeting('meeting-3', 'Partner follow-up', 'Confirm next action owner.', 13),
    meeting('meeting-4', 'End-of-day recap', 'Summarize completed work.', 17),
  ];
  s2.today.counts = { meetings: 4, emails: 3, tasks: 2, approvals: 1 };

  const s3 = base();
  s3.workingForYou = [
    item('work-short', 'TASK', 'Draft follow-up', 'Preparing a concise response.', 'In progress', 'OPEN_TASK'),
    item('work-long', 'TASK', 'Synthesize a long competitive intelligence memo for the product owner review', 'Collecting verified notes and preserving sources.', 'In progress', 'OPEN_TASK'),
    item('work-context', 'TASK', 'Prepare context packet', 'Using saved project context and recent results.', 'In progress', 'OPEN_TASK'),
  ];

  const s4 = base();
  s4.needsAttention = [
    item('approval-email', 'APPROVAL', 'Approve Gmail reply', 'External message requires review before sending.', 'Needs approval', 'REVIEW_APPROVAL', 'Review'),
    item('approval-calendar', 'APPROVAL', 'Approve calendar invite', 'Meeting creation needs confirmation.', 'Needs approval', 'REVIEW_APPROVAL', 'Review'),
    item('approval-action', 'APPROVAL', 'Approve external action', 'Browser action requires human confirmation.', 'Needs approval', 'REVIEW_APPROVAL', 'Review'),
  ];

  const s5 = base();
  s5.workingForYou = [item('workflow-running', 'TASK', 'Client brief is running', 'NAgex is preparing the first draft.', 'In progress', 'OPEN_TASK')];
  s5.needsAttention = [item('workflow-approval', 'APPROVAL', 'Client brief needs approval', 'Review before sending externally.', 'Needs approval', 'REVIEW_APPROVAL', 'Review')];
  withRecent(s5, 'workflow-completed', 'RESEARCH', 'Client brief source pack', 'Completed research artifact.');

  const s6 = base();
  s6.memoryContext = [
    memory('mem-project', 'PROJECT', 'Project context', 'NAgex Home emphasizes Remember, Create, Approve, Act.'),
    memory('mem-pref', 'PREFERENCE', 'Working preference', 'Keep approvals explicit and avoid fake runtime state.'),
    memory('mem-person', 'PERSON', 'Product owner context', 'Prefers screenshot-backed certification evidence.'),
    memory('mem-fact', 'CONTEXT', 'Recent contextual fact', 'D7 Home certification passed with personal-home scope green.'),
  ];

  const s7 = base();
  withRecent(s7, 'result-report', 'REPORT', 'Hackathon readiness report', 'A completed report artifact.');
  withRecent(s7, 'result-research', 'RESEARCH', 'Hackathon evidence research', 'A grounded research synthesis.');
  withRecent(s7, 'result-image', 'IMAGE', 'Product hero image', 'A generated image artifact.');
  withRecent(s7, 'result-plan', 'PLAN', 'Launch checklist', 'A completed planning artifact.');

  const s8 = base();
  s8.today = { ...s2.today, meetings: [...s2.today.meetings, meeting('meeting-5', 'Submission readiness', 'Confirm evidence packet.', 19)] };
  s8.workingForYou = s3.workingForYou;
  s8.needsAttention = s4.needsAttention.slice(0, 2);
  s8.memoryContext = s6.memoryContext;
  s8.recentResults = s7.recentResults;

  const s9 = base();
  s9.sourceStatus = { calendar: 'UNAVAILABLE', gmail: 'CONNECTED', activity: 'OK', tasks: 'UNAVAILABLE' };
  s9.workingForYou = [item('degraded-work', 'TASK', 'Continue available work', 'Calendar is unavailable, but task history still renders.', 'In progress', 'OPEN_TASK')];

  const s10 = base();
  s10.today.meetings = [meeting('long-ko', '매우 긴 한국어 회의 제목이 줄바꿈과 버튼 배치를 깨뜨리지 않는지 확인하는 전략 검토 회의', '긴 제목과 보조 텍스트가 함께 표시됩니다.', 15)];
  s10.workingForYou = [item('long-en', 'TASK', 'Prepare an exceptionally long English working item title that should wrap without clipping or hiding the Open action', 'Secondary context remains readable and compact.', 'In progress', 'OPEN_TASK')];
  s10.needsAttention = [item('long-approval', 'APPROVAL', 'Review approval for an unusually long external action target with multiple consequence details', 'The Review action must keep an accessible name.', 'Needs approval', 'REVIEW_APPROVAL', 'Review')];
  s10.memoryContext = [memory('long-memory', 'CONTEXT', 'Long context memory', 'This safe memory projection intentionally uses a longer sentence to verify wrapping, readability, and protected rendering without clipping.')];
  withRecent(s10, 'long-result', 'RESEARCH', 'A very long recent result title that should remain readable while preserving the Open action', 'Completed long-content result.');

  return [
    ['S1_EMPTY', s1],
    ['S2_BUSY_DAY', s2],
    ['S3_WORKING', s3],
    ['S4_APPROVALS', s4],
    ['S5_MIXED_LIFECYCLE', s5],
    ['S6_MEMORY_RICH', s6],
    ['S7_RESULTS_RICH', s7],
    ['S8_FULL_HOME', s8],
    ['S9_DEGRADED', s9],
    ['S10_LONG_CONTENT', s10],
  ].map(([id, response]) => ({ id: id as HomeScenarioId, response: response as PersonalHomeResponse, expectedIdentity: 'PERSONAL_AI' as const }));
}

export const HOME_SCENARIO_FIXTURES = Object.freeze(buildScenarios());
export const HOME_SCENARIO_FIXTURES_DEFAULT_ENABLED = false;
