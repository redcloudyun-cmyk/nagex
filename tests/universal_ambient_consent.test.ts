import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AmbientConsentStore,
  AmbientSignalBus,
  ConsentedProactiveNeedDetector,
  ControlCenterAmbientTelemetry,
  ProactiveDigestBuilder,
  ProactiveGoalConverter,
  UniversalAmbientConsentEngine,
  type AmbientProvider,
  type AmbientSource,
  type AmbientSourceConsent,
  type AmbientSourceType,
} from '../src/proactive/index.js';

const now = '2026-10-10T00:00:00.000Z';

function source(sourceType: AmbientSourceType, provider: AmbientProvider, accountRef: string): AmbientSource {
  return {
    sourceId: `${provider}:${accountRef}`,
    sourceType,
    provider,
    accountRef,
    displayName: `${provider} ${accountRef}`,
    connectionState: 'CONNECTED',
    capabilities: ['OBSERVE', 'READ_CONTENT', 'READ_ATTACHMENT', 'DRAFT', 'EXECUTE'],
    platform: 'SERVER',
    lastSeenAt: now,
  };
}

function consent(input: Partial<AmbientSourceConsent> & Pick<AmbientSourceConsent, 'sourceType' | 'provider' | 'accountRef'>): AmbientSourceConsent {
  const { sourceType, provider, accountRef, ...overrides } = input;
  return {
    consentId: `consent_${input.provider}_${input.accountRef}`,
    sourceType,
    provider,
    accountRef,
    scope: { kind: 'ALL_MAIL' },
    purposeTags: ['SEARCH', 'SUMMARIZATION', 'PROACTIVE_ASSISTANCE', 'TRAVEL_PREP', 'MEETING_PREP', 'FOLLOW_UP'],
    observeAllowed: true,
    backgroundAllowed: true,
    contentReadAllowed: true,
    attachmentAllowed: false,
    proactiveUseAllowed: true,
    draftAllowed: false,
    executeAllowed: false,
    retentionClass: 'EPHEMERAL',
    grantedAt: now,
    updatedAt: now,
    consentVersion: 1,
    ...overrides,
  };
}

test('connected source is not observe, content, proactive, draft, or execution authority', () => {
  const gmail = source('EMAIL', 'GMAIL', 'work');
  const engine = new UniversalAmbientConsentEngine(new AmbientConsentStore());
  assert.equal(engine.canObserve(gmail, { scope: { kind: 'INBOX_ONLY' }, purpose: 'SEARCH', privacyClass: 'PERSONAL' }).decision, 'NEEDS_USER_CONSENT');
  assert.equal(engine.canReadContent(gmail, { scope: { kind: 'INBOX_ONLY' }, purpose: 'SEARCH', privacyClass: 'PERSONAL' }).decision, 'NEEDS_USER_CONSENT');
  assert.equal(engine.canUseProactively(gmail, { scope: { kind: 'INBOX_ONLY' }, purpose: 'PROACTIVE_ASSISTANCE', privacyClass: 'PERSONAL' }).decision, 'NEEDS_USER_CONSENT');
  assert.equal(engine.canDraft(gmail, { scope: { kind: 'INBOX_ONLY' }, purpose: 'DRAFTING', privacyClass: 'PERSONAL' }).decision, 'NEEDS_USER_CONSENT');
  assert.equal(engine.canExecute(gmail, { scope: { kind: 'INBOX_ONLY' }, purpose: 'EXECUTION_SUPPORT', privacyClass: 'PERSONAL' }).decision, 'NEEDS_USER_CONSENT');
});

test('account-specific provider-neutral email consent gates Gmail, Naver, and custom IMAP independently', () => {
  const store = new AmbientConsentStore();
  const engine = new UniversalAmbientConsentEngine(store);
  const gmail = source('EMAIL', 'GMAIL', 'gmail-primary');
  const naver = source('EMAIL', 'NAVER_MAIL', 'naver-personal');
  const imap = source('EMAIL', 'CUSTOM_IMAP_SMTP', 'custom-imap');
  store.upsert(consent({ sourceType: 'EMAIL', provider: 'GMAIL', accountRef: 'gmail-primary', scope: { kind: 'INBOX_ONLY' }, proactiveUseAllowed: true }));
  store.upsert(consent({ sourceType: 'EMAIL', provider: 'NAVER_MAIL', accountRef: 'naver-personal', scope: { kind: 'INBOX_ONLY' }, proactiveUseAllowed: false }));

  assert.equal(engine.canObserve(gmail, { scope: { kind: 'INBOX_ONLY' }, purpose: 'SEARCH', privacyClass: 'PERSONAL' }).decision, 'ALLOW');
  assert.equal(engine.canUseProactively(gmail, { scope: { kind: 'INBOX_ONLY' }, purpose: 'PROACTIVE_ASSISTANCE', privacyClass: 'PERSONAL' }).decision, 'ALLOW');
  assert.equal(engine.canObserve(naver, { scope: { kind: 'INBOX_ONLY' }, purpose: 'SEARCH', privacyClass: 'PERSONAL' }).decision, 'ALLOW');
  assert.equal(engine.canUseProactively(naver, { scope: { kind: 'INBOX_ONLY' }, purpose: 'PROACTIVE_ASSISTANCE', privacyClass: 'PERSONAL' }).decision, 'DENY');
  assert.equal(engine.canObserve(imap, { scope: { kind: 'INBOX_ONLY' }, purpose: 'SEARCH', privacyClass: 'PERSONAL' }).decision, 'NEEDS_USER_CONSENT');
});

test('scope, purpose, and attachment gates deny widening before observation', () => {
  const store = new AmbientConsentStore();
  const engine = new UniversalAmbientConsentEngine(store);
  const mail = source('EMAIL', 'MICROSOFT_OUTLOOK', 'office');
  store.upsert(consent({ sourceType: 'EMAIL', provider: 'MICROSOFT_OUTLOOK', accountRef: 'office', scope: { kind: 'SPECIFIC_SENDER', value: 'ceo@example.com' }, purposeTags: ['SUMMARIZATION'], attachmentAllowed: false }));

  assert.equal(engine.canObserve(mail, { scope: { kind: 'INBOX_ONLY' }, purpose: 'SUMMARIZATION', privacyClass: 'PERSONAL' }).decision, 'OUT_OF_SCOPE');
  assert.equal(engine.canObserve(mail, { scope: { kind: 'SPECIFIC_SENDER', value: 'ceo@example.com' }, purpose: 'PROACTIVE_ASSISTANCE', privacyClass: 'PERSONAL' }).decision, 'PURPOSE_NOT_ALLOWED');
  assert.equal(engine.canReadAttachment(mail, { scope: { kind: 'SPECIFIC_SENDER', value: 'ceo@example.com' }, purpose: 'SUMMARIZATION', privacyClass: 'PERSONAL' }).decision, 'DENY');
});

test('pre-observation signal bus blocks raw content and stores derived signals only after consent', () => {
  const store = new AmbientConsentStore();
  const engine = new UniversalAmbientConsentEngine(store);
  const bus = new AmbientSignalBus(engine);
  const calendar = source('CALENDAR', 'GOOGLE_CALENDAR', 'primary');
  store.upsert(consent({ sourceType: 'CALENDAR', provider: 'GOOGLE_CALENDAR', accountRef: 'primary', scope: { kind: 'ALL_CALENDARS' }, purposeTags: ['TRAVEL_PREP'], contentReadAllowed: true, proactiveUseAllowed: true }));
  const signal = bus.ingest({
    source: calendar,
    timestamp: now,
    sourceRef: 'calendar://busan',
    scope: { kind: 'SPECIFIC_CALENDAR', value: 'work' },
    purpose: 'TRAVEL_PREP',
    privacyClass: 'PERSONAL',
    confidence: 0.95,
    rawContent: 'Tomorrow Busan 10:00 meeting. Private details stay ephemeral.',
    derivedSummary: 'Tomorrow Busan 10:00 meeting',
    userRef: 'usr_hash_1',
  });

  assert.ok(signal);
  assert.equal(Object.prototype.hasOwnProperty.call(signal, 'rawContent'), false);
  assert.equal(signal?.consentId, 'consent_GOOGLE_CALENDAR_primary');
  assert.equal(signal?.purposeProof?.[0], 'TRAVEL_PREP');
});

test('revocation immediately stops future ingestion and proactive candidate creation', () => {
  const store = new AmbientConsentStore();
  const engine = new UniversalAmbientConsentEngine(store);
  const bus = new AmbientSignalBus(engine);
  const kakao = source('MESSAGING', 'KAKAOTALK', 'phone');
  store.upsert(consent({ sourceType: 'MESSAGING', provider: 'KAKAOTALK', accountRef: 'phone', scope: { kind: 'DIRECT_ONLY' }, purposeTags: ['FOLLOW_UP'], proactiveUseAllowed: true }));
  store.revoke(kakao);
  const signal = bus.ingest({ source: kakao, timestamp: now, sourceRef: 'kakao://chat', scope: { kind: 'DIRECT_ONLY' }, purpose: 'FOLLOW_UP', privacyClass: 'PERSONAL', confidence: 0.8, derivedSummary: 'waiting reply' });
  assert.equal(signal, undefined);
  assert.equal(bus.auditEvents.at(-1)?.eventType, 'SIGNAL_BLOCKED_BY_CONSENT');
});

test('messaging multi-provider scenario permits observation without proactive use', () => {
  const store = new AmbientConsentStore();
  const engine = new UniversalAmbientConsentEngine(store);
  const bus = new AmbientSignalBus(engine);
  const kakao = source('MESSAGING', 'KAKAOTALK', 'phone');
  const line = source('MESSAGING', 'LINE', 'line-account');
  store.upsert(consent({ sourceType: 'MESSAGING', provider: 'KAKAOTALK', accountRef: 'phone', scope: { kind: 'DIRECT_ONLY' }, purposeTags: ['FOLLOW_UP'], proactiveUseAllowed: true }));
  store.upsert(consent({ sourceType: 'MESSAGING', provider: 'LINE', accountRef: 'line-account', scope: { kind: 'DIRECT_ONLY' }, purposeTags: ['SUMMARIZATION'], proactiveUseAllowed: false }));

  const allowed = bus.ingest({ source: kakao, timestamp: now, sourceRef: 'kakao://a', scope: { kind: 'DIRECT_ONLY' }, purpose: 'FOLLOW_UP', privacyClass: 'PERSONAL', confidence: 0.91, derivedSummary: 'client waiting reply', userRef: 'usr_hash_1' });
  const readOnly = bus.ingest({ source: line, timestamp: now, sourceRef: 'line://b', scope: { kind: 'DIRECT_ONLY' }, purpose: 'SUMMARIZATION', privacyClass: 'PERSONAL', confidence: 0.91, derivedSummary: 'summary only', userRef: 'usr_hash_1' });
  const candidate = new ConsentedProactiveNeedDetector().detectEligible(bus.signals);

  assert.ok(allowed);
  assert.ok(readOnly);
  assert.equal(candidate?.supportingSignals.includes(allowed.signalId), true);
  assert.equal(candidate?.supportingSignals.includes(readOnly.signalId), false);
});

test('browser and calendar scopes use the same consent engine without system exceptions', () => {
  const store = new AmbientConsentStore();
  const engine = new UniversalAmbientConsentEngine(store);
  const browser = source('BROWSER_CONTEXT', 'BROWSER', 'desktop-browser');
  const localCalendar = source('CALENDAR', 'LOCAL_DEVICE_CALENDAR', 'fold3');
  store.upsert(consent({ sourceType: 'BROWSER_CONTEXT', provider: 'BROWSER', accountRef: 'desktop-browser', scope: { kind: 'ACTIVE_TAB_ONLY' }, purposeTags: ['SUMMARIZATION'] }));
  store.upsert(consent({ sourceType: 'CALENDAR', provider: 'LOCAL_DEVICE_CALENDAR', accountRef: 'fold3', scope: { kind: 'BUSY_FREE_ONLY' }, purposeTags: ['PROACTIVE_ASSISTANCE'], contentReadAllowed: false }));

  assert.equal(engine.canObserve(browser, { scope: { kind: 'SPECIFIC_DOMAIN', value: 'bank.example' }, purpose: 'SUMMARIZATION', privacyClass: 'SENSITIVE' }).decision, 'OUT_OF_SCOPE');
  assert.equal(engine.canReadContent(localCalendar, { scope: { kind: 'BUSY_FREE_ONLY' }, purpose: 'PROACTIVE_ASSISTANCE', privacyClass: 'PERSONAL' }).decision, 'DENY');
});

test('explicit acceptance converts proactive candidate to goal with consent refs and no execution authority', () => {
  const store = new AmbientConsentStore();
  const engine = new UniversalAmbientConsentEngine(store);
  const bus = new AmbientSignalBus(engine);
  const calendar = source('CALENDAR', 'GOOGLE_CALENDAR', 'primary');
  store.upsert(consent({ sourceType: 'CALENDAR', provider: 'GOOGLE_CALENDAR', accountRef: 'primary', scope: { kind: 'ALL_CALENDARS' }, purposeTags: ['TRAVEL_PREP'], proactiveUseAllowed: true }));
  const signal = bus.ingest({ source: calendar, timestamp: now, sourceRef: 'calendar://travel', scope: { kind: 'SPECIFIC_CALENDAR', value: 'work' }, purpose: 'TRAVEL_PREP', privacyClass: 'PERSONAL', confidence: 0.9, derivedSummary: 'Tomorrow Busan 10:00 meeting KTX needed', userRef: 'usr_hash_1' });
  assert.ok(signal);
  const candidate = new ConsentedProactiveNeedDetector().detectEligible(bus.signals);
  assert.ok(candidate);
  const silence = new ProactiveGoalConverter().accept(candidate, false);
  const accepted = new ProactiveGoalConverter().accept(candidate, true);
  assert.equal(silence, undefined);
  assert.equal(accepted?.reusedCapability, 'LIFE_EXECUTION');
  assert.equal(accepted?.executionAuthorityGranted, false);
  assert.deepEqual(accepted?.consentRefs, ['consent_GOOGLE_CALENDAR_primary']);
});

test('digest and Control Center telemetry include only consent-valid aggregate data', () => {
  const detector = new ConsentedProactiveNeedDetector();
  const store = new AmbientConsentStore();
  const engine = new UniversalAmbientConsentEngine(store);
  const bus = new AmbientSignalBus(engine);
  const gmail = source('EMAIL', 'GMAIL', 'primary');
  store.upsert(consent({ sourceType: 'EMAIL', provider: 'GMAIL', accountRef: 'primary', scope: { kind: 'INBOX_ONLY' }, purposeTags: ['MEETING_PREP'], proactiveUseAllowed: true }));
  bus.ingest({ source: gmail, timestamp: now, sourceRef: 'mail://brief', scope: { kind: 'INBOX_ONLY' }, purpose: 'MEETING_PREP', privacyClass: 'PERSONAL', confidence: 0.86, derivedSummary: 'meeting brief needed', userRef: 'usr_hash_1' });
  const candidate = detector.detectEligible(bus.signals);
  const candidates = candidate ? [candidate] : [];
  const digest = new ProactiveDigestBuilder().build(candidates);
  const telemetry = new ControlCenterAmbientTelemetry().aggregate([gmail], bus.signals, bus.auditEvents, candidates, ['ACCEPTED', 'DISMISSED']);

  assert.equal(digest.items.length, 1);
  assert.equal(telemetry.aggregateOnly, true);
  assert.equal(telemetry.privateSignalContentVisible, false);
  assert.equal(telemetry.sourcesConnected, 1);
  assert.equal(telemetry.proactiveCandidates, 1);
});
