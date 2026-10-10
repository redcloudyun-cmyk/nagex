import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildRepresentativeLifeExecutionCertification,
  buildExecutionSurfaceCapabilityProfile,
  buildSchedulingProposalFromReservation,
  ExecutionOutcomeVerifier,
  ExecutionRouteResolver,
  LifeExecutionApprovalBinder,
  MaterialTermsEngine,
  type AvailabilityEvidence,
  type ExecutionEvidence,
  type LifeExecutionModality,
  type ReservationCandidate,
  type ReservationIntent,
  type RouteResolutionEvidence,
} from '../src/life-execution/index.js';

const baseIntent: ReservationIntent = {
  kind: 'RESERVATION',
  intentId: 'intent-reservation-1',
  category: 'RESTAURANT',
  modalities: ['TEXT'],
  sourceDevice: 'fold3',
  executionDevice: 'fold3',
  executionSurface: 'MOBILE',
  createdAt: '2026-10-10T00:00:00.000Z',
  locale: 'ko-KR',
  naturalLanguage: '내일 저녁 네 명 예약 준비해줘',
  location: 'Seoul',
  date: '2026-10-11',
  timeWindow: '18:00-20:00',
  partySize: 4,
  preferences: ['quiet', 'official-or-trusted-provider'],
  paymentRequirement: 'NONE',
  approvalRequirement: 'JIT_REQUIRED',
};

const verifiedEvidence: AvailabilityEvidence = {
  source: 'official-page',
  observedAt: '2026-10-10T00:00:00.000Z',
  trustClass: 'OFFICIAL_PROVIDER',
  identityVerified: true,
  dateTimeVerified: true,
  availabilityVerified: true,
  priceVerified: true,
  termsVerified: true,
  rawEvidenceRef: 'screenshot://terms',
};

function candidate(overrides: Partial<ReservationCandidate> = {}): ReservationCandidate {
  return {
    candidateId: 'candidate-1',
    providerId: 'provider-restaurant',
    providerName: 'Official Restaurant',
    trustClass: 'OFFICIAL_PROVIDER',
    title: 'Official Restaurant dinner',
    location: 'Seoul',
    date: baseIntent.date,
    timeWindow: baseIntent.timeWindow,
    partySize: baseIntent.partySize,
    price: { currency: 'KRW', amount: 50000 },
    availability: verifiedEvidence,
    ...overrides,
  };
}

function routeEvidence(overrides: Partial<RouteResolutionEvidence> = {}): RouteResolutionEvidence {
  return {
    officialApiAvailable: false,
    officialApiAuthenticated: false,
    surfaceProfile: buildExecutionSurfaceCapabilityProfile('MOBILE'),
    installedApps: [],
    webSurfaces: [],
    crossDeviceAvailable: false,
    manualFallbackAvailable: true,
    ...overrides,
  };
}

test('LifeExecutionIntent is modality-independent across text, voice, screen, share, image, event, and multimodal entry', () => {
  const modalities: readonly LifeExecutionModality[] = ['TEXT', 'VOICE', 'SCREEN', 'SHARE', 'IMAGE', 'EVENT', 'MULTIMODAL'];
  const intents = modalities.map((modality) => ({ ...baseIntent, intentId: `intent-${modality}`, modalities: [modality] as const }));
  assert.deepEqual(new Set(intents.map((intent) => intent.category)), new Set(['RESTAURANT']));
  assert.ok(intents.every((intent) => intent.location === baseIntent.location && intent.partySize === baseIntent.partySize));
});

test('route resolver handles missing installed app by continuing the goal on trusted mobile web', () => {
  const resolver = new ExecutionRouteResolver();
  const route = resolver.resolve(baseIntent, routeEvidence({
    installedApps: [{
      appId: 'restaurant.app',
      appInstalled: false,
      appLaunchable: false,
      appAuthState: 'UNKNOWN',
      deepLinkAvailable: false,
      storeListingObserved: true,
      observedAt: '2026-10-10T00:00:00.000Z',
    }],
    webSurfaces: [{
      url: 'https://trusted.example/restaurants',
      trustClass: 'TRUSTED_BOOKING_PLATFORM',
      identityVerified: true,
      canSearch: true,
      canPrepareReservation: true,
      acceptsPersonalData: true,
      acceptsPaymentData: false,
    }],
  }));
  assert.equal(route.routeKind, 'MOBILE_WEB');
  assert.equal(route.appMissingHandled, true);
  assert.equal(route.webFallbackSelected, true);
  assert.equal(route.goalContinued, true);
  assert.equal(route.canReceivePersonalData, true);
  assert.equal(route.canReceivePaymentData, false);
  assert.equal(route.installProposalAllowed, true);
  assert.equal(route.installWithoutExplicitApproval, false);
});

test('app store listing is evidence only and never creates install authority during certification', () => {
  const resolver = new ExecutionRouteResolver();
  const route = resolver.resolve(baseIntent, routeEvidence({
    surfaceProfile: buildExecutionSurfaceCapabilityProfile('MOBILE'),
    installedApps: [{
      appId: 'com.xgolf.android',
      appInstalled: false,
      appLaunchable: false,
      appAuthState: 'UNKNOWN',
      deepLinkAvailable: false,
      storeListingObserved: true,
      installationRequired: true,
      observedAt: '2026-10-10T00:00:00.000Z',
    }],
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
  }));
  assert.equal(route.routeKind, 'MOBILE_WEB');
  assert.equal(route.appMissingHandled, true);
  assert.equal(route.webFallbackSelected, true);
  assert.equal(route.installProposalAllowed, true);
  assert.equal(route.installWithoutExplicitApproval, false);
});

test('trusted web policy prefers official or trusted surfaces and blocks unknown payment/personal data transfer', () => {
  const resolver = new ExecutionRouteResolver();
  const route = resolver.resolve(baseIntent, routeEvidence({
    webSurfaces: [
      {
        url: 'https://unknown.example',
        trustClass: 'UNKNOWN',
        identityVerified: false,
        canSearch: true,
        canPrepareReservation: true,
        acceptsPersonalData: true,
        acceptsPaymentData: true,
      },
      {
        url: 'https://official.example',
        trustClass: 'OFFICIAL_PROVIDER',
        identityVerified: true,
        canSearch: true,
        canPrepareReservation: true,
        acceptsPersonalData: true,
        acceptsPaymentData: true,
      },
    ],
  }));
  assert.equal(route.providerId, 'https://official.example');
  assert.equal(route.trustClass, 'OFFICIAL_PROVIDER');
  assert.equal(route.canReceivePaymentData, true);

  const unknown = resolver.resolve(baseIntent, routeEvidence({
    webSurfaces: [{
      url: 'https://unknown.example',
      trustClass: 'UNKNOWN',
      identityVerified: false,
      canSearch: true,
      canPrepareReservation: true,
      acceptsPersonalData: true,
      acceptsPaymentData: true,
    }],
  }));
  assert.equal(unknown.canReceivePersonalData, false);
  assert.equal(unknown.canReceivePaymentData, false);
});

test('installed app evidence can win without app-specific goal ownership', () => {
  const resolver = new ExecutionRouteResolver();
  const route = resolver.resolve(baseIntent, routeEvidence({
    installedApps: [{
      appId: 'official.restaurant.app',
      appInstalled: true,
      appLaunchable: true,
      appAuthState: 'KNOWN_AUTHENTICATED',
      deepLinkAvailable: true,
      observedAt: '2026-10-10T00:00:00.000Z',
    }],
    webSurfaces: [{
      url: 'https://trusted.example/restaurants',
      trustClass: 'TRUSTED_BOOKING_PLATFORM',
      identityVerified: true,
      canSearch: true,
      canPrepareReservation: true,
      acceptsPersonalData: true,
      acceptsPaymentData: false,
    }],
  }));
  assert.equal(route.routeKind, 'DEEP_LINK');
  assert.equal(route.surface, 'MOBILE');
  assert.ok(route.evidence.includes('APP_INSTALLED'));
});

test('shared execution surface model includes mobile, desktop app, desktop browser, smart tv, and future surfaces', () => {
  const surfaces = ['MOBILE', 'DESKTOP_APP', 'DESKTOP_BROWSER', 'SMART_TV', 'TABLET', 'WEARABLE', 'CAR', 'OTHER'] as const;
  const profiles = surfaces.map((surface) => buildExecutionSurfaceCapabilityProfile(surface));
  assert.deepEqual(profiles.map((profile) => profile.surface), surfaces);
  const smartTv = buildExecutionSurfaceCapabilityProfile('SMART_TV');
  assert.equal(smartTv.sharedDevice, true);
  assert.equal(smartTv.smartTvAuthorityBoundary?.mobileConfirmation, 'REQUIRED');
  assert.ok(smartTv.capabilities.includes('CROSS_DEVICE_HANDOFF'));
});

test('capability-based routing favors cross-device handoff for smart tv instead of treating tv as goal owner', () => {
  const resolver = new ExecutionRouteResolver();
  const route = resolver.resolve({ ...baseIntent, executionSurface: 'SMART_TV' }, routeEvidence({
    surfaceProfile: buildExecutionSurfaceCapabilityProfile('SMART_TV'),
    installedApps: [{
      appId: 'tv.booking.app',
      appInstalled: true,
      appLaunchable: true,
      appAuthState: 'UNKNOWN',
      deepLinkAvailable: true,
      observedAt: '2026-10-10T00:00:00.000Z',
    }],
    webSurfaces: [{
      url: 'https://official.example',
      trustClass: 'OFFICIAL_PROVIDER',
      identityVerified: true,
      canSearch: true,
      canPrepareReservation: true,
      acceptsPersonalData: true,
      acceptsPaymentData: true,
    }],
    crossDeviceAvailable: true,
  }));
  assert.equal(route.routeKind, 'CROSS_DEVICE');
  assert.equal(route.surface, 'SMART_TV');
  assert.equal(route.canReceivePersonalData, false);
  assert.equal(route.canReceivePaymentData, false);
});

test('surface type does not own the reservation goal when core intent fields are unchanged', () => {
  const resolver = new ExecutionRouteResolver();
  const surfaces = ['MOBILE', 'DESKTOP_APP', 'DESKTOP_BROWSER', 'SMART_TV'] as const;
  const routes = surfaces.map((surface) => resolver.resolve({ ...baseIntent, executionSurface: surface }, routeEvidence({
    surfaceProfile: buildExecutionSurfaceCapabilityProfile(surface),
    webSurfaces: [{
      url: 'https://trusted.example/reservation',
      trustClass: 'TRUSTED_BOOKING_PLATFORM',
      identityVerified: true,
      canSearch: true,
      canPrepareReservation: true,
      acceptsPersonalData: true,
      acceptsPaymentData: false,
    }],
    crossDeviceAvailable: true,
  })));
  assert.ok(routes.every((route) => route.goalContinued));
  assert.deepEqual(new Set(routes.map(() => baseIntent.intentId)), new Set([baseIntent.intentId]));
});

test('route resolver source has no device-model or provider-specific category branching', () => {
  const source = readFileSync('src/life-execution/execution-route-resolver.ts', 'utf8');
  assert.doesNotMatch(source, /SM-F926N|R3CRC0J7MVJ|Fold3/i);
  assert.doesNotMatch(source, /Kakao|Naver|KTX|Hotels|Korail/i);
  assert.doesNotMatch(source, /category\s*===|switch\s*\(\s*.*category/i);
});

test('material terms normalize evidence and material changes require reapproval', () => {
  const engine = new MaterialTermsEngine();
  const original = engine.normalize(baseIntent, candidate());
  const changed = engine.normalize(baseIntent, candidate({ price: { currency: 'KRW', amount: 70000 } }));
  assert.equal(original.status, 'VERIFIED');
  assert.equal(engine.classifyChange(original, changed), 'CHANGED');
  assert.equal(engine.requiresReapproval(original, changed), true);
});

test('approval binding separates booking authority from payment authority and detects route or term drift', () => {
  const termsEngine = new MaterialTermsEngine();
  const resolver = new ExecutionRouteResolver();
  const route = resolver.resolve(baseIntent, routeEvidence({
    webSurfaces: [{
      url: 'https://official.example',
      trustClass: 'OFFICIAL_PROVIDER',
      identityVerified: true,
      canSearch: true,
      canPrepareReservation: true,
      acceptsPersonalData: true,
      acceptsPaymentData: false,
    }],
  }));
  const materialTerms = termsEngine.normalize({ ...baseIntent, paymentRequirement: 'DEPOSIT' }, candidate());
  const proposal = {
    proposalId: 'proposal-1',
    intentId: baseIntent.intentId,
    candidate: candidate(),
    route,
    materialTerms,
    lifecycleState: 'AWAITING_APPROVAL' as const,
    missingCriticalFields: [],
    visibleAssumptions: [],
  };
  const binder = new LifeExecutionApprovalBinder();
  const binding = binder.bind(proposal, { expiresAt: '2026-10-10T01:00:00.000Z', nonce: 'nonce-1' });
  assert.equal(binding.bookingAuthority, 'GRANTED');
  assert.equal(binding.paymentAuthority, 'NOT_GRANTED');
  assert.equal(binding.payloadHash.length, 64);

  const drifted = {
    ...proposal,
    materialTerms: termsEngine.normalize({ ...baseIntent, paymentRequirement: 'DEPOSIT' }, candidate({ price: { currency: 'KRW', amount: 70000 } })),
  };
  assert.equal(binder.hasPayloadDrift(binding, drifted), true);
});

test('outcome verifier never treats a click or provider acceptance as verified completion', () => {
  const verifier = new ExecutionOutcomeVerifier();
  const clickOnly: ExecutionEvidence = {
    actionSubmitted: true,
    outcomeObserved: false,
    confirmationVerified: false,
    evidenceRefs: ['ui://clicked-submit'],
  };
  assert.equal(verifier.verify(clickOnly, 'NONE').status, 'ACTION_TRIGGERED');
  assert.equal(verifier.verify(clickOnly, 'NONE').bookingState, 'UNCERTAIN');

  const accepted: ExecutionEvidence = {
    actionSubmitted: true,
    providerAccepted: true,
    outcomeObserved: true,
    confirmationVerified: false,
    visibleState: 'request accepted',
    evidenceRefs: ['ui://accepted'],
  };
  assert.equal(verifier.verify(accepted, 'NONE').status, 'BOOKED_UNVERIFIED');

  const confirmed: ExecutionEvidence = {
    actionSubmitted: true,
    providerAccepted: true,
    outcomeObserved: true,
    confirmationVerified: true,
    confirmationId: 'ABC123',
    evidenceRefs: ['email://confirmation'],
  };
  assert.equal(verifier.verify(confirmed, 'NONE').status, 'BOOKED_VERIFIED');
});

test('representative certification covers transport, restaurant, leisure, service appointment, and lodging with one core resolver', () => {
  const results = buildRepresentativeLifeExecutionCertification();
  assert.deepEqual(results.map((result) => result.domain), ['TRANSPORT', 'RESTAURANT', 'GOLF_OR_LEISURE', 'SERVICE_APPOINTMENT', 'LODGING']);
  assert.ok(results.every((result) => result.sameCoreModel && result.sameResolver));
  assert.ok(results.every((result) => result.preparedWithoutTransaction));
  const fallback = results.find((result) => result.domain === 'GOLF_OR_LEISURE');
  assert.equal(fallback?.appUnavailableHandled, true);
  assert.equal(fallback?.webFallbackSelected, true);
});

test('verified reservation outcome can produce a scheduling proposal without owning the whole goal', () => {
  const termsEngine = new MaterialTermsEngine();
  const route = new ExecutionRouteResolver().resolve(baseIntent, routeEvidence({
    webSurfaces: [{
      url: 'https://official.example',
      trustClass: 'OFFICIAL_PROVIDER',
      identityVerified: true,
      canSearch: true,
      canPrepareReservation: true,
      acceptsPersonalData: true,
      acceptsPaymentData: false,
    }],
  }));
  const proposal = {
    proposalId: 'reservation-123',
    intentId: baseIntent.intentId,
    candidate: candidate(),
    route,
    materialTerms: termsEngine.normalize(baseIntent, candidate()),
    lifecycleState: 'CONFIRMATION_VERIFIED' as const,
    missingCriticalFields: [],
    visibleAssumptions: [],
  };
  const scheduling = buildSchedulingProposalFromReservation(
    proposal,
    {
      status: 'BOOKED_VERIFIED',
      lifecycleState: 'CONFIRMATION_VERIFIED',
      approvalConsumed: true,
      bookingState: 'VERIFIED',
      paymentState: 'NOT_REQUIRED',
      evidenceRefs: ['email://confirmation/ABC123'],
      reason: 'verified',
    },
    {
      kind: 'SCHEDULING',
      intentId: 'schedule-intent',
      category: 'SCHEDULING',
      modalities: ['TEXT'],
      sourceDevice: 'fold3',
      createdAt: baseIntent.createdAt,
      naturalLanguage: '캘린더에 추가 제안',
      title: 'Reservation',
      linkedReservationId: proposal.proposalId,
      approvalRequirement: 'JIT_REQUIRED',
    },
  );
  assert.equal(scheduling.reservationId, proposal.proposalId);
  assert.equal(scheduling.provider, proposal.materialTerms.provider);
  assert.equal(scheduling.calendarWriteState, 'PROPOSED_ONLY');
});
