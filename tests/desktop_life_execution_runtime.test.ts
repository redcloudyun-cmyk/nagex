import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertDesktopUsesSharedProposal,
  buildCrossDeviceHandoff,
  buildDesktopVoiceRuntimeContract,
  buildExecutionSurfaceCapabilityProfile,
  buildSchedulingProposalFromReservation,
  DesktopCompactPopupRuntime,
  DesktopMultimodalSessionManager,
  DesktopNotificationCenter,
  ExecutionOutcomeVerifier,
  ExecutionRouteResolver,
  LifeExecutionApprovalBinder,
  MaterialTermsEngine,
  type ReservationCandidate,
  type ReservationIntent,
  type ReservationProposal,
  type RouteResolutionEvidence,
} from '../src/life-execution/index.js';

const intent: ReservationIntent = {
  kind: 'RESERVATION',
  intentId: 'desktop-life-intent-1',
  category: 'GOLF_OR_LEISURE',
  modalities: ['TEXT'],
  sourceDevice: 'desktop',
  executionDevice: 'desktop',
  executionSurface: 'DESKTOP_APP',
  createdAt: '2026-10-10T00:00:00.000Z',
  locale: 'ko-KR',
  naturalLanguage: 'Find a safe golf booking option.',
  location: 'Seoul',
  date: '2026-10-12',
  timeWindow: '08:00-09:00',
  partySize: 4,
  preferences: ['prepare-only'],
  paymentRequirement: 'NONE',
  approvalRequirement: 'JIT_REQUIRED',
};

function evidence(overrides: Partial<RouteResolutionEvidence> = {}): RouteResolutionEvidence {
  return {
    officialApiAvailable: false,
    officialApiAuthenticated: false,
    surfaceProfile: buildExecutionSurfaceCapabilityProfile('DESKTOP_BROWSER'),
    installedApps: [],
    webSurfaces: [{
      url: 'https://www.xgolf.com',
      trustClass: 'TRUSTED_BOOKING_PLATFORM',
      identityVerified: true,
      canSearch: true,
      canPrepareReservation: true,
      acceptsPersonalData: false,
      acceptsPaymentData: false,
    }],
    crossDeviceAvailable: true,
    manualFallbackAvailable: true,
    ...overrides,
  };
}

function candidate(): ReservationCandidate {
  return {
    candidateId: 'desktop-candidate-1',
    providerId: 'xgolf',
    providerName: 'XGOLF',
    trustClass: 'TRUSTED_BOOKING_PLATFORM',
    title: 'Visible desktop golf candidate',
    location: 'Korea',
    date: intent.date,
    timeWindow: intent.timeWindow,
    partySize: intent.partySize,
    price: { currency: 'KRW', amount: 185000 },
    availability: {
      source: 'desktop-browser-surface',
      observedAt: intent.createdAt,
      trustClass: 'TRUSTED_BOOKING_PLATFORM',
      identityVerified: true,
      dateTimeVerified: true,
      availabilityVerified: true,
      priceVerified: true,
      termsVerified: false,
      rawEvidenceRef: 'desktop://provider-surface',
    },
  };
}

function proposal(): ReservationProposal {
  const route = new ExecutionRouteResolver().resolve(intent, evidence());
  const materialTerms = new MaterialTermsEngine().normalize(intent, candidate());
  return {
    proposalId: 'desktop-proposal-1',
    intentId: intent.intentId,
    candidate: candidate(),
    route,
    materialTerms,
    lifecycleState: 'AWAITING_APPROVAL',
    missingCriticalFields: [],
    visibleAssumptions: [],
  };
}

test('desktop life execution reuses shared core and has no desktop-specific goal core', () => {
  const source = readFileSync('src/life-execution/desktop-life-runtime.ts', 'utf8');
  assert.doesNotMatch(source, /DesktopReservationIntent|DesktopReservationStateMachine/);
  assert.equal(assertDesktopUsesSharedProposal(proposal()).intentId, intent.intentId);
});

test('desktop browser route is selected from capability profile without forcing desktop app UI', () => {
  const route = new ExecutionRouteResolver().resolve(intent, evidence());
  assert.equal(route.routeKind, 'GENERAL_BROWSER');
  assert.equal(route.surface, 'DESKTOP_BROWSER');
  assert.equal(route.goalContinued, true);
});

test('desktop multimodal session survives text, voice, screen, file, and multimodal changes', () => {
  const manager = new DesktopMultimodalSessionManager();
  const text = manager.create({ goalId: 'goal-1', intentId: intent.intentId, mode: 'TEXT' });
  const voice = manager.continueWith(text, 'VOICE');
  const screen = manager.continueWith(voice, 'SCREEN_CONTEXT');
  const file = manager.continueWith(screen, 'FILE_CONTEXT');
  const multi = manager.continueWith(file, 'MULTIMODAL');
  assert.equal(multi.goalId, text.goalId);
  assert.equal(multi.intentId, text.intentId);
  assert.deepEqual(new Set(multi.lifeModalities), new Set(['TEXT', 'VOICE', 'SCREEN', 'SHARE', 'MULTIMODAL']));
  assert.equal(multi.foregroundPreservationRequired, true);
});

test('desktop voice runtime uses shared brand voice policy hooks', () => {
  const voice = buildDesktopVoiceRuntimeContract();
  assert.equal(voice.pushToTalkHook, true);
  assert.equal(voice.wakeWordHook, true);
  assert.equal(voice.spokenResponsePlayback, 'BRAND_VOICE_RESOLVER');
  assert.equal(voice.audioOutput, 'DESKTOP_VOICE_AUDIO_OUTPUT');
  assert.equal(voice.backgroundOperation, true);
});

test('compact popup is non-blocking, foreground preserving, and defaults to 30 seconds for approvals', () => {
  const center = new DesktopNotificationCenter();
  const popup = new DesktopCompactPopupRuntime(center).show({
    popupId: 'popup-1',
    goalId: 'goal-1',
    executionId: 'exec-1',
    type: 'APPROVAL_REQUIRED',
    summary: '185,000 KRW condition ready.',
    approvalId: 'approval-1',
    sensitiveDetailsRedacted: false,
  });
  assert.equal(popup.visibleSeconds, 30);
  assert.equal(popup.nonBlocking, true);
  assert.equal(popup.foregroundStealing, false);
  assert.equal(center.get('notification-popup-1')?.approvalStatus, 'PENDING');
});

test('popup auto-dismiss and close preserve approval record in notification center', () => {
  const center = new DesktopNotificationCenter();
  const runtime = new DesktopCompactPopupRuntime(center);
  const popup = runtime.show({
    popupId: 'popup-approval',
    goalId: 'goal-approval',
    executionId: 'exec-approval',
    type: 'APPROVAL_REQUIRED',
    summary: 'Approval required.',
    approvalId: 'approval-approval',
    sensitiveDetailsRedacted: true,
  });
  const dismissed = runtime.autoDismiss(popup);
  assert.equal(dismissed.status, 'PERSISTED');
  assert.equal(dismissed.approvalStatus, 'PENDING');
  const closed = runtime.close(popup);
  assert.equal(closed.status, 'PERSISTED');
  assert.equal(closed.approvalStatus, 'PENDING');
  assert.match(closed.summary, /confirmation required/i);
});

test('voice and popup operate on the same goal and approval state', () => {
  const session = new DesktopMultimodalSessionManager().create({ goalId: 'goal-shared', intentId: intent.intentId, mode: 'VOICE' });
  const binding = new LifeExecutionApprovalBinder().bind(proposal(), { expiresAt: '2026-10-10T01:00:00.000Z', nonce: 'desktop-nonce' });
  const center = new DesktopNotificationCenter();
  const popup = new DesktopCompactPopupRuntime(center).show({
    popupId: 'popup-shared',
    goalId: session.goalId,
    executionId: 'exec-shared',
    type: 'APPROVAL_REQUIRED',
    summary: 'Candidate ready.',
    approvalId: binding.approvalId,
    sensitiveDetailsRedacted: false,
  });
  assert.equal(popup.goalId, session.goalId);
  assert.equal(center.get('notification-popup-shared')?.approvalId, binding.approvalId);
});

test('desktop mobile handoff preserves goal id, approval binding, and smart tv compatibility', () => {
  const binding = new LifeExecutionApprovalBinder().bind(proposal(), { expiresAt: '2026-10-10T01:00:00.000Z', nonce: 'handoff-nonce' });
  const handoff = buildCrossDeviceHandoff({
    handoffId: 'handoff-1',
    fromSurface: 'DESKTOP_APP',
    toSurface: 'MOBILE',
    goalId: 'goal-handoff',
    approvalBinding: binding,
    route: proposal().route,
  });
  assert.equal(handoff.goalId, 'goal-handoff');
  assert.equal(handoff.approvalPayloadHash, binding.payloadHash);
  assert.equal(handoff.outcomeSync, 'REQUIRED');
  assert.equal(handoff.smartTvCompatible, true);
});

test('approval and outcome verification remain separated on desktop browser execution', () => {
  const binding = new LifeExecutionApprovalBinder().bind(proposal(), { expiresAt: '2026-10-10T01:00:00.000Z', nonce: 'verify-nonce' });
  assert.equal(binding.bookingAuthority, 'GRANTED');
  const outcome = new ExecutionOutcomeVerifier().verify({
    actionSubmitted: true,
    providerAccepted: false,
    outcomeObserved: false,
    confirmationVerified: false,
    evidenceRefs: ['desktop://clicked'],
  }, 'NONE');
  assert.equal(outcome.status, 'ACTION_TRIGGERED');
  assert.equal(outcome.bookingState, 'UNCERTAIN');
});

test('verified reservation can propose scheduling without calendar write ownership', () => {
  const schedule = buildSchedulingProposalFromReservation(proposal(), {
    status: 'BOOKED_VERIFIED',
    lifecycleState: 'CONFIRMATION_VERIFIED',
    approvalConsumed: true,
    bookingState: 'VERIFIED',
    paymentState: 'NOT_REQUIRED',
    evidenceRefs: ['desktop://confirmation'],
    reason: 'verified',
  }, {
    kind: 'SCHEDULING',
    intentId: 'schedule-1',
    category: 'SCHEDULING',
    modalities: ['TEXT'],
    sourceDevice: 'desktop',
    createdAt: intent.createdAt,
    naturalLanguage: 'Add to calendar',
    title: 'Golf reservation',
    linkedReservationId: proposal().proposalId,
    approvalRequirement: 'JIT_REQUIRED',
  });
  assert.equal(schedule.calendarWriteState, 'PROPOSED_ONLY');
  assert.equal(schedule.reservationId, proposal().proposalId);
});
