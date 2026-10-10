import { ExecutionRouteResolver } from './execution-route-resolver.js';
import type { LifeExecutionCategory, ReservationIntent, RouteResolutionEvidence } from './life-execution.types.js';

export interface DomainCertificationResult {
  readonly domain: LifeExecutionCategory;
  readonly sameCoreModel: true;
  readonly sameResolver: true;
  readonly routeKind: string;
  readonly appUnavailableHandled: boolean;
  readonly webFallbackSelected: boolean;
  readonly preparedWithoutTransaction: boolean;
}

const DOMAINS: readonly LifeExecutionCategory[] = [
  'TRANSPORT',
  'RESTAURANT',
  'GOLF_OR_LEISURE',
  'SERVICE_APPOINTMENT',
  'LODGING',
];

export function buildRepresentativeLifeExecutionCertification(): readonly DomainCertificationResult[] {
  const resolver = new ExecutionRouteResolver();
  return DOMAINS.map((domain) => {
    const evidence = evidenceForDomain(domain);
    const route = resolver.resolve(intentForDomain(domain), evidence);
    return {
      domain,
      sameCoreModel: true,
      sameResolver: true,
      routeKind: route.routeKind,
      appUnavailableHandled: route.appMissingHandled,
      webFallbackSelected: route.webFallbackSelected,
      preparedWithoutTransaction: route.routeKind !== 'UNAVAILABLE' && !route.canReceivePaymentData,
    };
  });
}

export function intentForDomain(category: LifeExecutionCategory): ReservationIntent {
  return {
    kind: 'RESERVATION',
    intentId: `intent-${category.toLowerCase()}`,
    category,
    modalities: ['TEXT'],
    sourceDevice: 'fold3',
    executionDevice: 'fold3',
    executionSurface: 'ANDROID',
    createdAt: '2026-10-10T00:00:00.000Z',
    locale: 'ko-KR',
    naturalLanguage: `Prepare a ${category} reservation without final submission.`,
    location: 'Seoul',
    date: '2026-10-20',
    timeWindow: '18:00-20:00',
    partySize: category === 'LODGING' ? 2 : 4,
    quantity: 1,
    preferences: ['official-or-trusted-provider', 'no-payment-during-certification'],
    paymentRequirement: 'UNKNOWN',
    approvalRequirement: 'JIT_REQUIRED',
  };
}

function evidenceForDomain(category: LifeExecutionCategory): RouteResolutionEvidence {
  if (category === 'GOLF_OR_LEISURE') {
    return {
      officialApiAvailable: false,
      officialApiAuthenticated: false,
      installedApps: [{
        appId: 'candidate.leisure.app',
        appInstalled: false,
        appLaunchable: false,
        appAuthState: 'UNKNOWN',
        deepLinkAvailable: false,
        observedAt: '2026-10-10T00:00:00.000Z',
      }],
      webSurfaces: [{
        url: 'https://trusted-booking.example/leisure',
        trustClass: 'TRUSTED_BOOKING_PLATFORM',
        identityVerified: true,
        canSearch: true,
        canPrepareReservation: true,
        acceptsPersonalData: false,
        acceptsPaymentData: false,
      }],
      crossDeviceAvailable: true,
      manualFallbackAvailable: true,
    };
  }

  return {
    officialApiAvailable: false,
    officialApiAuthenticated: false,
    installedApps: [],
    webSurfaces: [{
      url: `https://official.example/${category.toLowerCase()}`,
      trustClass: 'OFFICIAL_PROVIDER',
      identityVerified: true,
      canSearch: true,
      canPrepareReservation: true,
      acceptsPersonalData: false,
      acceptsPaymentData: false,
    }],
    crossDeviceAvailable: true,
    manualFallbackAvailable: true,
  };
}
