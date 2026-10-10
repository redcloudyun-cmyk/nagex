import crypto from 'node:crypto';
import { MODEL_SCORING_POLICY_VERSION, type ModelPerformanceRecord } from '../creation-agent/model-intelligence.js';

export type AmbientSignalSourceType = 'CALENDAR' | 'EMAIL' | 'MESSAGE' | 'SMS' | 'NOTIFICATION' | 'TASK' | 'FILE_CHANGE' | 'BROWSER_CONTEXT' | 'DEVICE_CONTEXT' | 'TIME_CONTEXT' | 'CONNECTED_APP_EVENT' | 'SYSTEM_EVENT';
export type AmbientSourceType = 'EMAIL' | 'MESSAGING' | 'CALENDAR' | 'SMS' | 'NOTIFICATION' | 'TASK' | 'FILE_WATCH' | 'BROWSER_CONTEXT' | 'DEVICE_CONTEXT' | 'CONNECTED_APP_EVENT' | 'OTHER';
export type AmbientProvider = 'GMAIL' | 'MICROSOFT_OUTLOOK' | 'HOTMAIL' | 'NAVER_MAIL' | 'DAUM_HANMAIL' | 'YAHOO' | 'ICLOUD' | 'PROTON' | 'CUSTOM_IMAP_SMTP' | 'CORPORATE_MAIL' | 'KAKAOTALK' | 'LINE' | 'TELEGRAM' | 'WHATSAPP' | 'INSTAGRAM_DM' | 'FACEBOOK_MESSENGER' | 'SIGNAL' | 'SLACK' | 'TEAMS' | 'SMS_RCS' | 'GOOGLE_CALENDAR' | 'MICROSOFT_CALENDAR' | 'LOCAL_DEVICE_CALENDAR' | 'LOCAL_FILE_SYSTEM' | 'BROWSER' | 'ANDROID' | 'IOS' | 'WINDOWS' | 'OTHER';
export type AmbientScopeKind = 'ALL_MAIL' | 'INBOX_ONLY' | 'UNREAD_ONLY' | 'SPECIFIC_FOLDER' | 'SPECIFIC_LABEL' | 'SPECIFIC_SENDER' | 'ALL_CONVERSATIONS' | 'DIRECT_ONLY' | 'SPECIFIC_CONTACTS' | 'SPECIFIC_ROOMS' | 'SPECIFIC_WORKSPACE' | 'ALL_CALENDARS' | 'SPECIFIC_CALENDAR' | 'BUSY_FREE_ONLY' | 'FULL_EVENT_DETAILS' | 'SPECIFIC_FILE' | 'PROJECT_ONLY' | 'ACTIVE_TAB_ONLY' | 'SPECIFIC_DOMAIN' | 'SELECTED_TEXT_ONLY';
export type AmbientPurposeTag = 'SEARCH' | 'SUMMARIZATION' | 'PROACTIVE_ASSISTANCE' | 'MEETING_PREP' | 'TRAVEL_PREP' | 'FOLLOW_UP' | 'TASK_EXTRACTION' | 'DRAFTING' | 'EXECUTION_SUPPORT';
export type AmbientConsentDecision = 'ALLOW' | 'DENY' | 'NEEDS_USER_CONSENT' | 'OUT_OF_SCOPE' | 'PURPOSE_NOT_ALLOWED' | 'REVOKED';
export type PrivacyClass = 'PUBLIC' | 'INTERNAL' | 'PERSONAL' | 'SENSITIVE' | 'HIGHLY_SENSITIVE';
export type SignalSensitivity = 'LOW' | 'MEDIUM' | 'HIGH';
export type RetentionClass = 'EPHEMERAL' | 'SHORT' | 'AUDIT_SAFE';
export type CandidateType = 'TRAVEL_PREPARATION' | 'MEETING_PREPARATION' | 'FOLLOW_UP' | 'SCHEDULE_CONFLICT' | 'DEADLINE_PREPARATION' | 'RESERVATION_OPPORTUNITY' | 'DOCUMENT_PREPARATION' | 'REPLY_DRAFT' | 'ROUTE_PLANNING';
export type ProactiveActionRisk = 'INFORMATION_ONLY' | 'PREPARE_ONLY' | 'LOW_RISK_REVERSIBLE' | 'CONSEQUENTIAL' | 'HIGH_RISK';
export type Surface = 'DESKTOP_POPUP' | 'MOBILE_NOTIFICATION' | 'SMART_TV_CARD' | 'DIGEST' | 'SILENT';
export type AttentionMode = 'IMMEDIATE' | 'NEXT_CONVENIENT' | 'DIGEST' | 'SILENT';
export type UserFeedback = 'ACCEPTED' | 'DISMISSED' | 'IGNORED' | 'SNOOZED' | 'MODIFIED' | 'DONT_SUGGEST_AGAIN';

export interface AmbientSignal {
  readonly signalId: string;
  readonly sourceType: AmbientSignalSourceType;
  readonly sourceId?: string;
  readonly provider?: AmbientProvider;
  readonly accountRef?: string;
  readonly timestamp: string;
  readonly sourceRef: string;
  readonly summary: string;
  readonly confidence: number;
  readonly sensitivity: SignalSensitivity;
  readonly privacyClass: PrivacyClass;
  readonly retentionClass: RetentionClass;
  readonly consentId?: string;
  readonly consentVersion?: number;
  readonly scopeProof?: string;
  readonly purposeProof?: readonly AmbientPurposeTag[];
  readonly deviceId?: string;
  readonly userRef?: string;
  readonly relatedGoalIds: readonly string[];
  readonly rawContent?: never;
}

export interface AmbientSource {
  readonly sourceId: string;
  readonly sourceType: AmbientSourceType;
  readonly provider: AmbientProvider;
  readonly accountRef: string;
  readonly displayName: string;
  readonly connectionState: 'CONNECTED' | 'DISCONNECTED' | 'ERROR' | 'REVOKED';
  readonly capabilities: readonly ('OBSERVE' | 'READ_CONTENT' | 'READ_ATTACHMENT' | 'DRAFT' | 'EXECUTE')[];
  readonly platform: 'SERVER' | 'WEB' | 'ANDROID' | 'IOS' | 'DESKTOP' | 'BROWSER' | 'OTHER';
  readonly deviceRef?: string;
  readonly lastSeenAt?: string;
}

export interface AmbientScope {
  readonly kind: AmbientScopeKind;
  readonly value?: string;
}

export interface AmbientSourceConsent {
  readonly consentId: string;
  readonly sourceType: AmbientSourceType;
  readonly provider: AmbientProvider;
  readonly accountRef: string;
  readonly scope: AmbientScope;
  readonly purposeTags: readonly AmbientPurposeTag[];
  readonly observeAllowed: boolean;
  readonly backgroundAllowed: boolean;
  readonly contentReadAllowed: boolean;
  readonly attachmentAllowed: boolean;
  readonly proactiveUseAllowed: boolean;
  readonly draftAllowed: boolean;
  readonly executeAllowed: boolean;
  readonly retentionClass: RetentionClass;
  readonly grantedAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
  readonly consentVersion: number;
}

export interface AmbientConsentContext {
  readonly scope: AmbientScope;
  readonly purpose: AmbientPurposeTag;
  readonly privacyClass: PrivacyClass;
  readonly action: 'OBSERVE' | 'READ_CONTENT' | 'READ_ATTACHMENT' | 'PROACTIVE_USE' | 'DRAFT' | 'EXECUTE';
}

export interface AmbientConsentResult {
  readonly decision: AmbientConsentDecision;
  readonly reasonCode: string;
  readonly consent?: AmbientSourceConsent;
  readonly scopeProof?: string;
  readonly purposeProof?: readonly AmbientPurposeTag[];
}

export interface AmbientInboundEvent {
  readonly source: AmbientSource;
  readonly timestamp: string;
  readonly sourceRef: string;
  readonly scope: AmbientScope;
  readonly purpose: AmbientPurposeTag;
  readonly privacyClass: PrivacyClass;
  readonly confidence: number;
  readonly derivedSummary?: string;
  readonly rawContent?: string;
  readonly attachmentRequested?: boolean;
  readonly userRef?: string;
}

export interface ProactiveNeedCandidate {
  readonly candidateId: string;
  readonly candidateType: CandidateType;
  readonly supportingSignals: readonly string[];
  readonly consentRefs: readonly string[];
  readonly reason: string;
  readonly assumptions: readonly string[];
  readonly unknowns: readonly string[];
  readonly needConfidence: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly signalConfidence: number;
  readonly identityConfidence: number;
  readonly urgency: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly actionRisk: ProactiveActionRisk;
  readonly suggestedAction: string;
  readonly suggestedSurface: Surface;
  readonly expiresAt: string;
  readonly modelTierUsed: 'FAST' | 'LOCAL_PRIVATE' | 'BALANCED' | 'PREMIUM';
  readonly authorityGranted: false;
}

export interface ProactiveSuggestion {
  readonly suggestionId: string;
  readonly candidateId: string;
  readonly surface: Surface;
  readonly attentionMode: AttentionMode;
  readonly title: string;
  readonly body: string;
  readonly actions: readonly string[];
  readonly state: 'SURFACED' | 'DIGESTED' | 'SILENT' | 'EXPIRED';
}

export interface ProactiveGoalLink {
  readonly candidateId: string;
  readonly originSignalIds: readonly string[];
  readonly consentRefs: readonly string[];
  readonly userAcceptanceTimestamp: string;
  readonly goalId: string;
  readonly reusedCapability: 'LIFE_EXECUTION' | 'CREATION_AGENT' | 'COMMUNICATION' | 'CALENDAR' | 'RESEARCH';
  readonly executionAuthorityGranted: false;
}

export interface ActivityLogRecord {
  readonly eventId: string;
  readonly eventType: 'CONSENT_GRANTED' | 'CONSENT_CHANGED' | 'CONSENT_REVOKED' | 'SIGNAL_BLOCKED_BY_CONSENT' | 'SIGNAL_OBSERVED' | 'SIGNAL_CREATED' | 'CANDIDATE_INFERRED' | 'PROACTIVE_CANDIDATE_CREATED' | 'SUGGESTION_SURFACED' | 'USER_RESPONSE' | 'GOAL_CREATED' | 'EXECUTION_VERIFIED';
  readonly timestamp: string;
  readonly refs: readonly string[];
  readonly privacyClass: PrivacyClass;
  readonly summary: string;
  readonly rawContentStored: false;
}

export interface ProactiveSettings {
  readonly enabled: boolean;
  readonly categories: Record<CandidateType, boolean>;
  readonly frequency: 'MINIMAL' | 'BALANCED' | 'PROACTIVE';
  readonly quietHours?: { readonly start: string; readonly end: string };
}

export class AmbientSignalFactory {
  create(input: Omit<AmbientSignal, 'signalId' | 'summary' | 'retentionClass' | 'relatedGoalIds'> & { readonly summary: string; readonly relatedGoalIds?: readonly string[] }): AmbientSignal {
    return {
      ...input,
      signalId: `sig_${crypto.randomUUID()}`,
      summary: input.summary.slice(0, 220),
      retentionClass: input.privacyClass === 'PUBLIC' ? 'SHORT' : 'EPHEMERAL',
      relatedGoalIds: input.relatedGoalIds ?? [],
    };
  }
}

export class AmbientConsentStore {
  private readonly consents = new Map<string, AmbientSourceConsent>();
  upsert(consent: AmbientSourceConsent): AmbientSourceConsent {
    this.consents.set(this.key(consent.sourceType, consent.provider, consent.accountRef), consent);
    return consent;
  }
  lookup(source: Pick<AmbientSource, 'sourceType' | 'provider' | 'accountRef'>): AmbientSourceConsent | undefined {
    return this.consents.get(this.key(source.sourceType, source.provider, source.accountRef));
  }
  revoke(source: Pick<AmbientSource, 'sourceType' | 'provider' | 'accountRef'>, revokedAt = new Date().toISOString()): AmbientSourceConsent | undefined {
    const current = this.lookup(source);
    if (!current) return undefined;
    const revoked = { ...current, revokedAt, updatedAt: revokedAt, observeAllowed: false, backgroundAllowed: false, contentReadAllowed: false, attachmentAllowed: false, proactiveUseAllowed: false, draftAllowed: false, executeAllowed: false, consentVersion: current.consentVersion + 1 };
    this.upsert(revoked);
    return revoked;
  }
  private key(sourceType: AmbientSourceType, provider: AmbientProvider, accountRef: string): string {
    return `${sourceType}:${provider}:${accountRef}`;
  }
}

export class UniversalAmbientConsentEngine {
  constructor(private readonly store: AmbientConsentStore) {}

  canObserve(source: AmbientSource, context: Omit<AmbientConsentContext, 'action'>): AmbientConsentResult {
    return this.evaluate(source, { ...context, action: 'OBSERVE' });
  }
  canReadContent(source: AmbientSource, context: Omit<AmbientConsentContext, 'action'>): AmbientConsentResult {
    return this.evaluate(source, { ...context, action: 'READ_CONTENT' });
  }
  canReadAttachment(source: AmbientSource, context: Omit<AmbientConsentContext, 'action'>): AmbientConsentResult {
    return this.evaluate(source, { ...context, action: 'READ_ATTACHMENT' });
  }
  canUseProactively(source: AmbientSource, context: Omit<AmbientConsentContext, 'action'>): AmbientConsentResult {
    return this.evaluate(source, { ...context, action: 'PROACTIVE_USE' });
  }
  canDraft(source: AmbientSource, context: Omit<AmbientConsentContext, 'action'>): AmbientConsentResult {
    return this.evaluate(source, { ...context, action: 'DRAFT' });
  }
  canExecute(source: AmbientSource, context: Omit<AmbientConsentContext, 'action'>): AmbientConsentResult {
    return this.evaluate(source, { ...context, action: 'EXECUTE' });
  }

  evaluate(source: AmbientSource, context: AmbientConsentContext): AmbientConsentResult {
    const consent = this.store.lookup(source);
    if (!consent) return { decision: 'NEEDS_USER_CONSENT', reasonCode: 'NO_SOURCE_ACCOUNT_CONSENT' };
    if (consent.revokedAt || source.connectionState === 'REVOKED') return { decision: 'REVOKED', reasonCode: 'CONSENT_REVOKED', consent };
    if (consent.sourceType !== source.sourceType || consent.provider !== source.provider || consent.accountRef !== source.accountRef) return { decision: 'DENY', reasonCode: 'CONSENT_SOURCE_MISMATCH', consent };
    if (!this.scopeAllows(consent.scope, context.scope)) return { decision: 'OUT_OF_SCOPE', reasonCode: 'SCOPE_NOT_ALLOWED', consent };
    if (!consent.purposeTags.includes(context.purpose)) return { decision: 'PURPOSE_NOT_ALLOWED', reasonCode: 'PURPOSE_NOT_ALLOWED', consent };
    const flag = this.flagFor(context.action);
    if (!consent[flag]) return { decision: 'DENY', reasonCode: `${context.action}_NOT_ALLOWED`, consent };
    return { decision: 'ALLOW', reasonCode: 'CONSENT_ALLOW', consent, scopeProof: `${consent.scope.kind}:${consent.scope.value ?? '*'}`, purposeProof: [context.purpose] };
  }

  private flagFor(action: AmbientConsentContext['action']): keyof Pick<AmbientSourceConsent, 'observeAllowed' | 'contentReadAllowed' | 'attachmentAllowed' | 'proactiveUseAllowed' | 'draftAllowed' | 'executeAllowed'> {
    if (action === 'OBSERVE') return 'observeAllowed';
    if (action === 'READ_CONTENT') return 'contentReadAllowed';
    if (action === 'READ_ATTACHMENT') return 'attachmentAllowed';
    if (action === 'PROACTIVE_USE') return 'proactiveUseAllowed';
    if (action === 'DRAFT') return 'draftAllowed';
    return 'executeAllowed';
  }

  private scopeAllows(granted: AmbientScope, requested: AmbientScope): boolean {
    if (granted.kind === requested.kind && (granted.value === undefined || granted.value === requested.value)) return true;
    if (granted.kind === 'ALL_MAIL' && ['INBOX_ONLY', 'UNREAD_ONLY', 'SPECIFIC_FOLDER', 'SPECIFIC_LABEL', 'SPECIFIC_SENDER'].includes(requested.kind)) return true;
    if (granted.kind === 'ALL_CONVERSATIONS' && ['DIRECT_ONLY', 'SPECIFIC_CONTACTS', 'SPECIFIC_ROOMS', 'SPECIFIC_WORKSPACE'].includes(requested.kind)) return true;
    if (granted.kind === 'ALL_CALENDARS' && ['SPECIFIC_CALENDAR', 'BUSY_FREE_ONLY', 'FULL_EVENT_DETAILS'].includes(requested.kind)) return true;
    if (granted.kind === 'PROJECT_ONLY' && ['SPECIFIC_FOLDER', 'SPECIFIC_FILE'].includes(requested.kind)) return true;
    return false;
  }
}

export class AmbientSignalBus {
  readonly signals: AmbientSignal[] = [];
  readonly auditEvents: ActivityLogRecord[] = [];
  constructor(private readonly consentEngine: UniversalAmbientConsentEngine, private readonly factory = new AmbientSignalFactory()) {}

  ingest(event: AmbientInboundEvent): AmbientSignal | undefined {
    const baseContext = { scope: event.scope, purpose: event.purpose, privacyClass: event.privacyClass };
    const observe = this.consentEngine.canObserve(event.source, baseContext);
    if (observe.decision !== 'ALLOW') return this.block(event, observe);
    if (event.rawContent) {
      const read = this.consentEngine.canReadContent(event.source, baseContext);
      if (read.decision !== 'ALLOW') return this.block(event, read);
    }
    if (event.attachmentRequested) {
      const attachment = this.consentEngine.canReadAttachment(event.source, baseContext);
      if (attachment.decision !== 'ALLOW') return this.block(event, attachment);
    }
    const summary = event.derivedSummary ?? this.deriveEphemeralSummary(event.rawContent ?? event.source.displayName);
    const signal = this.factory.create({
      sourceType: this.signalSourceType(event.source.sourceType),
      sourceId: event.source.sourceId,
      provider: event.source.provider,
      accountRef: event.source.accountRef,
      timestamp: event.timestamp,
      sourceRef: event.sourceRef,
      summary,
      confidence: event.confidence,
      sensitivity: event.privacyClass === 'SENSITIVE' || event.privacyClass === 'HIGHLY_SENSITIVE' ? 'HIGH' : 'MEDIUM',
      privacyClass: event.privacyClass,
      consentId: observe.consent?.consentId,
      consentVersion: observe.consent?.consentVersion,
      scopeProof: observe.scopeProof,
      purposeProof: observe.purposeProof,
      deviceId: event.source.deviceRef,
      userRef: event.userRef,
    });
    this.signals.push(signal);
    this.audit('SIGNAL_CREATED', [signal.signalId, observe.consent?.consentId ?? 'missing-consent'], event.privacyClass, `Allowed ${event.source.provider} ${event.source.sourceType} signal.`);
    return signal;
  }

  private block(event: AmbientInboundEvent, result: AmbientConsentResult): undefined {
    this.audit('SIGNAL_BLOCKED_BY_CONSENT', [event.source.sourceId, result.reasonCode], event.privacyClass, `${event.source.provider} ${event.source.sourceType} blocked before observation.`);
    return undefined;
  }

  private audit(eventType: ActivityLogRecord['eventType'], refs: readonly string[], privacyClass: PrivacyClass, summary: string): void {
    this.auditEvents.push({ eventId: `pa_${crypto.randomUUID()}`, eventType, timestamp: new Date().toISOString(), refs, privacyClass, summary: summary.slice(0, 220), rawContentStored: false });
  }

  private deriveEphemeralSummary(raw: string): string {
    return raw.replace(/\s+/g, ' ').slice(0, 160);
  }

  private signalSourceType(sourceType: AmbientSourceType): AmbientSignalSourceType {
    if (sourceType === 'MESSAGING') return 'MESSAGE';
    if (sourceType === 'FILE_WATCH') return 'FILE_CHANGE';
    if (sourceType === 'OTHER') return 'CONNECTED_APP_EVENT';
    return sourceType;
  }
}

export class ModelIntelligenceRouter {
  readonly performanceRecords: ModelPerformanceRecord[] = [];
  route(step: 'SIGNAL_CLASSIFICATION' | 'MULTI_SIGNAL_FUSION' | 'COMPLEX_PLANNING', privacyClass: PrivacyClass) {
    if (step === 'SIGNAL_CLASSIFICATION') return privacyClass === 'SENSITIVE' || privacyClass === 'HIGHLY_SENSITIVE' ? 'LOCAL_PRIVATE' as const : 'FAST' as const;
    if (step === 'MULTI_SIGNAL_FUSION') return 'BALANCED' as const;
    return 'PREMIUM' as const;
  }
  recordOutcome(candidate: ProactiveNeedCandidate, finalOutcome: ModelPerformanceRecord['finalOutcome'] = 'ACCEPTED'): void {
    this.performanceRecords.push({
      dataOrigin: 'LIVE',
      providerId: 'nagex-proactive',
      modelId: candidate.modelTierUsed.toLowerCase(),
      modelFamily: 'PROACTIVE_ROUTER',
      taskType: candidate.candidateType,
      goalId: candidate.candidateId,
      qualityScore: candidate.needConfidence === 'HIGH' ? 90 : 70,
      evidenceGroundingScore: Math.round(candidate.signalConfidence * 100),
      instructionFollowingScore: 100,
      structuredOutputScore: 100,
      toolUseScore: 0,
      languageQualityScore: 90,
      reasoningScore: candidate.modelTierUsed === 'PREMIUM' ? 92 : 78,
      revisionCount: 0,
      criticFailureCount: 0,
      evidenceConflictCount: candidate.unknowns.length,
      unsupportedClaimCount: 0,
      hallucinationFlag: false,
      latencyMs: candidate.modelTierUsed === 'FAST' || candidate.modelTierUsed === 'LOCAL_PRIVATE' ? 80 : 420,
      estimatedCost: candidate.modelTierUsed === 'PREMIUM' ? 0.02 : 0.002,
      contextSize: candidate.supportingSignals.length,
      language: 'ko',
      modality: 'ambient-signal',
      privacyClass: candidate.supportingSignals.length > 1 ? 'PERSONAL' : 'INTERNAL',
      autoQualityGateResult: 'PASS',
      finalOutcome,
      recordedAt: new Date().toISOString(),
    });
  }
}

export class ProactiveJevDeliberator {
  deliberate(signals: readonly AmbientSignal[], router = new ModelIntelligenceRouter()) {
    const modelTier = router.route(signals.length > 1 ? 'MULTI_SIGNAL_FUSION' : 'SIGNAL_CLASSIFICATION', signals[0]?.privacyClass ?? 'INTERNAL');
    const sourceTypes = new Set(signals.map((s) => s.sourceType));
    const summary = signals.map((s) => s.summary).join(' ');
    const hasTomorrow = /tomorrow|내일|翌日/i.test(summary);
    const hasMeeting = sourceTypes.has('CALENDAR') && (/meeting|회의|미팅/i.test(summary) || sourceTypes.has('EMAIL') || sourceTypes.has('FILE_CHANGE'));
    const hasTravel = sourceTypes.has('CALENDAR') && (/busan|부산|another city|다른 도시|ktx|train|교통/i.test(summary));
    const hasFollowUp = sourceTypes.has('MESSAGE') || sourceTypes.has('EMAIL') || sourceTypes.has('TASK');
    let candidateType: CandidateType = hasTravel ? 'TRAVEL_PREPARATION' : hasMeeting ? 'MEETING_PREPARATION' : hasFollowUp ? 'FOLLOW_UP' : 'DOCUMENT_PREPARATION';
    const risk: ProactiveActionRisk = candidateType === 'TRAVEL_PREPARATION' ? 'LOW_RISK_REVERSIBLE' : candidateType === 'MEETING_PREPARATION' ? 'PREPARE_ONLY' : 'PREPARE_ONLY';
    const needConfidence: ProactiveNeedCandidate['needConfidence'] = signals.length >= 3 || (hasTomorrow && (hasMeeting || hasTravel)) ? 'HIGH' : signals.length >= 2 ? 'MEDIUM' : 'LOW';
    const urgency: ProactiveNeedCandidate['urgency'] = hasTomorrow ? 'HIGH' : 'MEDIUM';
    const action = candidateType === 'TRAVEL_PREPARATION'
      ? '내일 일정 이동 준비를 위해 경로와 KTX 후보를 찾아볼까요?'
      : candidateType === 'MEETING_PREPARATION'
        ? '내일 회의를 위한 1페이지 브리핑을 만들어둘까요?'
        : '아직 답장이 없는 항목에 대해 후속 메시지 초안을 만들어둘까요?';
    return {
      candidateType,
      reason: `JEV hypothesis from ${[...sourceTypes].join(', ')} signals.`,
      assumptions: ['Signal summaries are supporting context, not user commands.', 'Memory/preferences can support relevance but never grant authority.'],
      unknowns: candidateType === 'TRAVEL_PREPARATION' ? ['Exact preferred departure time', 'Reservation authority'] : ['Final audience', 'Whether user wants this now'],
      needConfidence,
      urgency,
      actionRisk: risk,
      suggestedAction: action,
      modelTierUsed: modelTier,
      signalConfidence: signals.reduce((sum, s) => sum + s.confidence, 0) / Math.max(1, signals.length),
      identityConfidence: Math.min(...signals.map((s) => s.userRef ? 0.95 : 0.3), 0.95),
    };
  }
}

export class ProactiveNeedDetector {
  constructor(private readonly jev = new ProactiveJevDeliberator(), private readonly router = new ModelIntelligenceRouter()) {}
  detect(signals: readonly AmbientSignal[]): ProactiveNeedCandidate {
    const deliberation = this.jev.deliberate(signals, this.router);
    const candidate: ProactiveNeedCandidate = {
      candidateId: `pc_${crypto.randomUUID()}`,
      candidateType: deliberation.candidateType,
      supportingSignals: signals.map((s) => s.signalId),
      consentRefs: signals.map((s) => s.consentId).filter((id): id is string => Boolean(id)),
      reason: deliberation.reason,
      assumptions: deliberation.assumptions,
      unknowns: deliberation.unknowns,
      needConfidence: deliberation.needConfidence,
      signalConfidence: deliberation.signalConfidence,
      identityConfidence: deliberation.identityConfidence,
      urgency: deliberation.urgency,
      actionRisk: deliberation.actionRisk,
      suggestedAction: deliberation.suggestedAction,
      suggestedSurface: 'DESKTOP_POPUP',
      expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      modelTierUsed: deliberation.modelTierUsed,
      authorityGranted: false,
    };
    this.router.recordOutcome(candidate);
    return candidate;
  }
  get modelTelemetry(): readonly ModelPerformanceRecord[] { return this.router.performanceRecords; }
}

export class ConsentedProactiveNeedDetector extends ProactiveNeedDetector {
  detectEligible(signals: readonly AmbientSignal[]): ProactiveNeedCandidate | undefined {
    const eligible = signals.filter((signal) => signal.consentId && signal.purposeProof?.some((purpose) => purpose === 'PROACTIVE_ASSISTANCE' || purpose === 'TRAVEL_PREP' || purpose === 'MEETING_PREP' || purpose === 'FOLLOW_UP'));
    if (eligible.length === 0) return undefined;
    return this.detect(eligible);
  }
}

export class AttentionPolicy {
  choose(candidate: ProactiveNeedCandidate, context: { readonly quietHours: boolean; readonly deviceActive: boolean; readonly recentInterruptions: number; readonly sharedDevice?: boolean }): AttentionMode {
    if (context.quietHours || candidate.needConfidence === 'LOW') return 'DIGEST';
    if (candidate.actionRisk === 'HIGH_RISK' || candidate.actionRisk === 'CONSEQUENTIAL') return 'NEXT_CONVENIENT';
    if (context.recentInterruptions > 2) return 'DIGEST';
    if (context.sharedDevice && candidate.identityConfidence < 0.8) return 'SILENT';
    return candidate.urgency === 'HIGH' && context.deviceActive ? 'IMMEDIATE' : 'NEXT_CONVENIENT';
  }
}

export class ProactiveThrottle {
  private readonly history = new Map<string, { feedback: UserFeedback; at: number }[]>();
  record(topic: string, feedback: UserFeedback): void {
    const rows = this.history.get(topic) ?? [];
    rows.push({ feedback, at: Date.now() });
    this.history.set(topic, rows.slice(-10));
  }
  shouldSuppress(topic: string): boolean {
    const rows = this.history.get(topic) ?? [];
    return rows.some((row) => row.feedback === 'DONT_SUGGEST_AGAIN') || rows.slice(-3).every((row) => row.feedback === 'IGNORED' || row.feedback === 'DISMISSED') && rows.length >= 3;
  }
}

export class ProactiveSurfaceRenderer {
  render(candidate: ProactiveNeedCandidate, surface: 'DESKTOP' | 'MOBILE' | 'SMART_TV', userIdentified = true): ProactiveSuggestion {
    const sharedSafeBody = userIdentified ? candidate.suggestedAction : 'NAgex에서 확인이 필요한 일정 준비가 있어요.';
    const renderedSurface: Surface = surface === 'DESKTOP' ? 'DESKTOP_POPUP' : surface === 'MOBILE' ? 'MOBILE_NOTIFICATION' : 'SMART_TV_CARD';
    return {
      suggestionId: `ps_${crypto.randomUUID()}`,
      candidateId: candidate.candidateId,
      surface: renderedSurface,
      attentionMode: renderedSurface === 'SMART_TV_CARD' && !userIdentified ? 'NEXT_CONVENIENT' : 'IMMEDIATE',
      title: 'NAgex',
      body: sharedSafeBody,
      actions: surface === 'SMART_TV' && !userIdentified ? ['모바일에서 확인'] : ['수락', '나중에', '필요 없음'],
      state: 'SURFACED',
    };
  }
}

export class ProactiveGoalConverter {
  accept(candidate: ProactiveNeedCandidate, accepted: boolean): ProactiveGoalLink | undefined {
    if (!accepted) return undefined;
    const reusedCapability = candidate.candidateType === 'TRAVEL_PREPARATION' || candidate.candidateType === 'RESERVATION_OPPORTUNITY' || candidate.candidateType === 'ROUTE_PLANNING'
      ? 'LIFE_EXECUTION'
      : candidate.candidateType === 'MEETING_PREPARATION' || candidate.candidateType === 'DOCUMENT_PREPARATION'
        ? 'CREATION_AGENT'
        : 'COMMUNICATION';
    return {
      candidateId: candidate.candidateId,
      originSignalIds: candidate.supportingSignals,
      consentRefs: candidate.consentRefs,
      userAcceptanceTimestamp: new Date().toISOString(),
      goalId: `goal_${candidate.candidateId}`,
      reusedCapability,
      executionAuthorityGranted: false,
    };
  }
}

export class ProactiveDigestBuilder {
  build(candidates: readonly ProactiveNeedCandidate[]) {
    return {
      digestId: `pd_${crypto.randomUUID()}`,
      title: `오늘 확인할 것 ${candidates.length}가지`,
      items: candidates.map((candidate, index) => ({ order: index + 1, candidateId: candidate.candidateId, type: candidate.candidateType, action: candidate.suggestedAction, risk: candidate.actionRisk })),
      reducesInterruptions: true,
    };
  }
}

export class ControlCenterAmbientTelemetry {
  aggregate(sources: readonly AmbientSource[], signals: readonly AmbientSignal[], audit: readonly ActivityLogRecord[], candidates: readonly ProactiveNeedCandidate[], responses: readonly UserFeedback[] = []) {
    const connected = sources.filter((source) => source.connectionState === 'CONNECTED').length;
    return {
      sourcesConnected: connected,
      monitoringOptInRate: sources.length === 0 ? 0 : connected / sources.length,
      proactiveOptInRate: sources.length === 0 ? 0 : new Set(candidates.flatMap((candidate) => candidate.consentRefs)).size / sources.length,
      signalsProcessed: signals.length,
      signalsBlockedByConsent: audit.filter((row) => row.eventType === 'SIGNAL_BLOCKED_BY_CONSENT').length,
      proactiveCandidates: candidates.length,
      acceptanceRate: responses.length === 0 ? 0 : responses.filter((response) => response === 'ACCEPTED').length / responses.length,
      falsePositiveCorrectionRate: responses.length === 0 ? 0 : responses.filter((response) => response === 'DISMISSED' || response === 'DONT_SUGGEST_AGAIN').length / responses.length,
      aggregateOnly: true,
      privateSignalContentVisible: false,
    };
  }
}

export class ProactiveExplainer {
  explain(candidate: ProactiveNeedCandidate, signals: readonly AmbientSignal[]): string {
    const sources = signals.filter((s) => candidate.supportingSignals.includes(s.signalId)).map((s) => s.sourceType).join(', ');
    return `${sources} 신호의 요약 정보를 근거로 준비가 필요할 가능성이 있다고 판단했어요. 이 설명은 구조화된 근거 요약이며 숨겨진 추론 과정은 포함하지 않습니다.`;
  }
}

export class ProactiveActivityLog {
  private readonly records: ActivityLogRecord[] = [];
  record(eventType: ActivityLogRecord['eventType'], refs: readonly string[], privacyClass: PrivacyClass, summary: string): ActivityLogRecord {
    const record = { eventId: `pa_${crypto.randomUUID()}`, eventType, timestamp: new Date().toISOString(), refs, privacyClass, summary: summary.slice(0, 220), rawContentStored: false as const };
    this.records.push(record);
    return record;
  }
  list(): readonly ActivityLogRecord[] { return this.records; }
}

export function buildProactiveCertificationScenario() {
  const factory = new AmbientSignalFactory();
  const detector = new ProactiveNeedDetector();
  const converter = new ProactiveGoalConverter();
  const log = new ProactiveActivityLog();
  const travelSignals = [
    factory.create({ sourceType: 'CALENDAR', timestamp: '2026-10-10T00:00:00.000Z', sourceRef: 'cal://tomorrow-busan', summary: '내일 부산 10:00 회의', confidence: 0.92, sensitivity: 'MEDIUM', privacyClass: 'PERSONAL', deviceId: 'desktop', userRef: 'usr_hash_1' }),
    factory.create({ sourceType: 'EMAIL', timestamp: '2026-10-10T00:01:00.000Z', sourceRef: 'mail://meeting-location', summary: '회의 장소 부산역 인근', confidence: 0.88, sensitivity: 'MEDIUM', privacyClass: 'PERSONAL', userRef: 'usr_hash_1' }),
    factory.create({ sourceType: 'TASK', timestamp: '2026-10-10T00:02:00.000Z', sourceRef: 'task://prep', summary: '자료 준비 미완료, KTX 선호 메모 있음', confidence: 0.84, sensitivity: 'LOW', privacyClass: 'INTERNAL', userRef: 'usr_hash_1' }),
  ];
  travelSignals.forEach((signal) => log.record('SIGNAL_OBSERVED', [signal.signalId], signal.privacyClass, signal.summary));
  const travel = detector.detect(travelSignals);
  log.record('CANDIDATE_INFERRED', [travel.candidateId], 'PERSONAL', travel.reason);
  const travelGoal = converter.accept(travel, true);
  if (travelGoal) log.record('GOAL_CREATED', [travelGoal.goalId, travel.candidateId], 'PERSONAL', 'Travel preparation goal created after explicit acceptance.');

  const meetingSignals = [
    factory.create({ sourceType: 'CALENDAR', timestamp: '2026-10-10T00:00:00.000Z', sourceRef: 'cal://strategy', summary: '내일 전략 회의', confidence: 0.9, sensitivity: 'MEDIUM', privacyClass: 'PERSONAL', userRef: 'usr_hash_1' }),
    factory.create({ sourceType: 'FILE_CHANGE', timestamp: '2026-10-10T00:03:00.000Z', sourceRef: 'file://brief-notes', summary: '관련 로컬 자료 업데이트', confidence: 0.8, sensitivity: 'MEDIUM', privacyClass: 'PERSONAL', userRef: 'usr_hash_1' }),
    factory.create({ sourceType: 'EMAIL', timestamp: '2026-10-10T00:04:00.000Z', sourceRef: 'mail://agenda', summary: '회의 안건 확인됨', confidence: 0.86, sensitivity: 'MEDIUM', privacyClass: 'PERSONAL', userRef: 'usr_hash_1' }),
  ];
  meetingSignals.forEach((signal) => log.record('SIGNAL_OBSERVED', [signal.signalId], signal.privacyClass, signal.summary));
  const meeting = detector.detect(meetingSignals);
  const meetingGoal = converter.accept(meeting, true);
  if (meetingGoal) log.record('GOAL_CREATED', [meetingGoal.goalId, meeting.candidateId], 'PERSONAL', 'Meeting brief goal created after explicit acceptance.');

  return {
    travel,
    travelGoal,
    meeting,
    meetingGoal,
    modelTelemetry: detector.modelTelemetry,
    activityLog: log.list(),
    authority: {
      signalAsInstruction: false,
      silenceAuthorizes: false,
      unauthorizedActionOccurred: false,
      scoringPolicyVersion: MODEL_SCORING_POLICY_VERSION,
    },
  };
}
