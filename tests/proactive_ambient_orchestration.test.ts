import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmbientSignalFactory,
  AttentionPolicy,
  ModelIntelligenceRouter,
  ProactiveActivityLog,
  ProactiveDigestBuilder,
  ProactiveExplainer,
  ProactiveGoalConverter,
  ProactiveNeedDetector,
  ProactiveSurfaceRenderer,
  ProactiveThrottle,
  buildProactiveCertificationScenario,
  type AmbientSignal,
} from '../src/proactive/index.js';

const factory = new AmbientSignalFactory();

function signal(overrides: Partial<AmbientSignal> & { summary: string; sourceType: AmbientSignal['sourceType'] }): AmbientSignal {
  return factory.create({
    timestamp: '2026-10-10T00:00:00.000Z',
    sourceRef: 'fixture://signal',
    confidence: 0.9,
    sensitivity: 'MEDIUM',
    privacyClass: 'PERSONAL',
    userRef: 'usr_hash_1',
    ...overrides,
  });
}

test('AmbientSignal stores derived summaries and never raw content by default', () => {
  const observed = signal({ sourceType: 'CALENDAR', summary: '내일 부산 회의' });
  assert.equal(observed.sourceType, 'CALENDAR');
  assert.equal(observed.retentionClass, 'EPHEMERAL');
  assert.equal(Object.prototype.hasOwnProperty.call(observed, 'rawContent'), false);
});

test('external signal is not user command and grants no authority', () => {
  const detector = new ProactiveNeedDetector();
  const candidate = detector.detect([signal({ sourceType: 'CALENDAR', summary: '내일 부산 10:00 회의' })]);
  assert.equal(candidate.authorityGranted, false);
  assert.equal(candidate.actionRisk === 'CONSEQUENTIAL' || candidate.actionRisk === 'HIGH_RISK', false);
});

test('JEV proactive deliberation fuses calendar, email and task into travel preparation', () => {
  const detector = new ProactiveNeedDetector();
  const candidate = detector.detect([
    signal({ sourceType: 'CALENDAR', summary: '내일 부산 10:00 회의' }),
    signal({ sourceType: 'EMAIL', summary: '회의 장소 부산역 인근' }),
    signal({ sourceType: 'TASK', summary: 'KTX 선호, 자료 준비 필요' }),
  ]);
  assert.equal(candidate.candidateType, 'TRAVEL_PREPARATION');
  assert.equal(candidate.needConfidence, 'HIGH');
  assert.equal(candidate.modelTierUsed, 'BALANCED');
  assert.ok(candidate.unknowns.includes('Reservation authority'));
});

test('risk, signal confidence, identity confidence, urgency and need confidence are separate fields', () => {
  const candidate = new ProactiveNeedDetector().detect([signal({ sourceType: 'CALENDAR', summary: '내일 부산 10:00 회의' })]);
  assert.ok(candidate.signalConfidence > 0);
  assert.ok(candidate.identityConfidence > 0);
  assert.equal(candidate.urgency, 'HIGH');
  assert.ok(candidate.actionRisk);
  assert.ok(candidate.needConfidence);
});

test('silence never converts candidate to goal', () => {
  const candidate = new ProactiveNeedDetector().detect([signal({ sourceType: 'CALENDAR', summary: '내일 회의' })]);
  assert.equal(new ProactiveGoalConverter().accept(candidate, false), undefined);
});

test('accepted proactive travel candidate converts to Life Execution goal without execution authority', () => {
  const candidate = new ProactiveNeedDetector().detect([signal({ sourceType: 'CALENDAR', summary: '내일 부산 KTX 이동 필요' })]);
  const link = new ProactiveGoalConverter().accept(candidate, true)!;
  assert.equal(link.reusedCapability, 'LIFE_EXECUTION');
  assert.equal(link.executionAuthorityGranted, false);
  assert.equal(link.originSignalIds[0], candidate.supportingSignals[0]);
});

test('accepted meeting preparation candidate converts to Creation Agent goal', () => {
  const candidate = new ProactiveNeedDetector().detect([
    signal({ sourceType: 'CALENDAR', summary: '내일 전략 회의' }),
    signal({ sourceType: 'FILE_CHANGE', summary: '관련 로컬 파일 변경' }),
    signal({ sourceType: 'EMAIL', summary: '회의 안건 도착' }),
  ]);
  const link = new ProactiveGoalConverter().accept(candidate, true)!;
  assert.equal(candidate.candidateType, 'MEETING_PREPARATION');
  assert.equal(link.reusedCapability, 'CREATION_AGENT');
});

test('attention policy avoids spam and respects quiet hours/shared-device uncertainty', () => {
  const candidate = new ProactiveNeedDetector().detect([signal({ sourceType: 'CALENDAR', summary: '내일 부산 회의' })]);
  const policy = new AttentionPolicy();
  assert.equal(policy.choose(candidate, { quietHours: true, deviceActive: true, recentInterruptions: 0 }), 'DIGEST');
  assert.equal(policy.choose({ ...candidate, identityConfidence: 0.3 }, { quietHours: false, deviceActive: true, recentInterruptions: 0, sharedDevice: true }), 'SILENT');
});

test('throttling suppresses repeated ignored topics and honors dont-suggest-again', () => {
  const throttle = new ProactiveThrottle();
  throttle.record('travel:busan', 'IGNORED');
  throttle.record('travel:busan', 'DISMISSED');
  throttle.record('travel:busan', 'IGNORED');
  assert.equal(throttle.shouldSuppress('travel:busan'), true);
  throttle.record('meeting:brief', 'DONT_SUGGEST_AGAIN');
  assert.equal(throttle.shouldSuppress('meeting:brief'), true);
});

test('feedback learning does not infer permanent dislike from one dismissal', () => {
  const throttle = new ProactiveThrottle();
  throttle.record('followup:client', 'DISMISSED');
  assert.equal(throttle.shouldSuppress('followup:client'), false);
});

test('desktop, mobile and smart tv surfaces remain compact and shared-device safe', () => {
  const candidate = new ProactiveNeedDetector().detect([signal({ sourceType: 'CALENDAR', summary: '내일 부산 회의' })]);
  const renderer = new ProactiveSurfaceRenderer();
  assert.equal(renderer.render(candidate, 'DESKTOP').surface, 'DESKTOP_POPUP');
  assert.equal(renderer.render(candidate, 'MOBILE').surface, 'MOBILE_NOTIFICATION');
  const tv = renderer.render(candidate, 'SMART_TV', false);
  assert.equal(tv.surface, 'SMART_TV_CARD');
  assert.equal(tv.body.includes('부산'), false);
  assert.deepEqual(tv.actions, ['모바일에서 확인']);
});

test('Model Intelligence routing uses fast/local for classification and premium only for complex planning', () => {
  const router = new ModelIntelligenceRouter();
  assert.equal(router.route('SIGNAL_CLASSIFICATION', 'INTERNAL'), 'FAST');
  assert.equal(router.route('SIGNAL_CLASSIFICATION', 'SENSITIVE'), 'LOCAL_PRIVATE');
  assert.equal(router.route('MULTI_SIGNAL_FUSION', 'PERSONAL'), 'BALANCED');
  assert.equal(router.route('COMPLEX_PLANNING', 'PERSONAL'), 'PREMIUM');
});

test('detector records model performance telemetry without raw ambient content', () => {
  const detector = new ProactiveNeedDetector();
  detector.detect([signal({ sourceType: 'CALENDAR', summary: '내일 회의' })]);
  assert.equal(detector.modelTelemetry.length, 1);
  assert.equal(detector.modelTelemetry[0].dataOrigin, 'LIVE');
  assert.equal(detector.modelTelemetry[0].hallucinationFlag, false);
});

test('daily digest groups candidates to reduce interruptions', () => {
  const detector = new ProactiveNeedDetector();
  const digest = new ProactiveDigestBuilder().build([
    detector.detect([signal({ sourceType: 'CALENDAR', summary: '내일 회의' })]),
    detector.detect([signal({ sourceType: 'TASK', summary: '마감 준비 필요' })]),
  ]);
  assert.equal(digest.items.length, 2);
  assert.equal(digest.reducesInterruptions, true);
});

test('explainability returns evidence-based summary without hidden chain-of-thought', () => {
  const signals = [signal({ sourceType: 'CALENDAR', summary: '내일 회의' })];
  const candidate = new ProactiveNeedDetector().detect(signals);
  const explanation = new ProactiveExplainer().explain(candidate, signals);
  assert.ok(explanation.includes('CALENDAR'));
  assert.ok(explanation.includes('숨겨진 추론 과정은 포함하지 않습니다'));
});

test('activity log records privacy-safe proactive lifecycle', () => {
  const log = new ProactiveActivityLog();
  const record = log.record('SIGNAL_OBSERVED', ['sig_1'], 'PERSONAL', '내일 회의');
  assert.equal(record.rawContentStored, false);
  assert.equal(log.list().length, 1);
});

test('deterministic E2E cert covers travel and meeting brief with explicit acceptance', () => {
  const cert = buildProactiveCertificationScenario();
  assert.equal(cert.travel.candidateType, 'TRAVEL_PREPARATION');
  assert.equal(cert.travelGoal?.reusedCapability, 'LIFE_EXECUTION');
  assert.equal(cert.meeting.candidateType, 'MEETING_PREPARATION');
  assert.equal(cert.meetingGoal?.reusedCapability, 'CREATION_AGENT');
  assert.equal(cert.authority.signalAsInstruction, false);
  assert.equal(cert.authority.silenceAuthorizes, false);
  assert.equal(cert.authority.unauthorizedActionOccurred, false);
  assert.ok(cert.activityLog.some((row) => row.eventType === 'GOAL_CREATED'));
});
