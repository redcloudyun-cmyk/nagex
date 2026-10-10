import type {
  AuthState,
  ExecutionRoute,
  ExecutionRouteKind,
  ExecutionSurface,
  ExecutionSurfaceCapability,
  ExecutionSurfaceCapabilityProfile,
  ProviderTrustClass,
  ReservationIntent,
  RouteResolutionEvidence,
  WebSurfaceEvidence,
} from './life-execution.types.js';

interface RouteCandidate {
  readonly routeKind: ExecutionRouteKind;
  readonly surface: ExecutionSurface;
  readonly providerId: string;
  readonly trustClass: ProviderTrustClass;
  readonly authState: AuthState;
  readonly evidence: readonly string[];
  readonly reason: string;
  readonly score: number;
  readonly canReceivePersonalData: boolean;
  readonly canReceivePaymentData: boolean;
  readonly appMissingHandled: boolean;
  readonly webFallbackSelected: boolean;
  readonly installProposalAllowed: boolean;
}

export class ExecutionRouteResolver {
  resolve(intent: ReservationIntent, evidence: RouteResolutionEvidence): ExecutionRoute {
    const candidates = [...this.buildCandidates(intent, evidence)].sort((a: RouteCandidate, b: RouteCandidate) => b.score - a.score);
    const selected = candidates[0] ?? this.unavailable(intent);
    return {
      routeKind: selected.routeKind,
      surface: selected.surface,
      providerId: selected.providerId,
      trustClass: selected.trustClass,
      authState: selected.authState,
      evidence: selected.evidence,
      reason: selected.reason,
      appMissingHandled: selected.appMissingHandled,
      webFallbackSelected: selected.webFallbackSelected,
      goalContinued: selected.routeKind !== 'UNAVAILABLE',
      canReceivePersonalData: selected.canReceivePersonalData,
      canReceivePaymentData: selected.canReceivePaymentData,
      installProposalAllowed: selected.installProposalAllowed,
      installWithoutExplicitApproval: false,
    };
  }

  private buildCandidates(intent: ReservationIntent, evidence: RouteResolutionEvidence): readonly RouteCandidate[] {
    const candidates: RouteCandidate[] = [];
    const profile = evidence.surfaceProfile;
    const installProposalAllowed = evidence.installedApps.some((app) => !app.appInstalled && (app.storeListingObserved || app.installationRequired));
    if (evidence.officialApiAvailable) {
      candidates.push({
        routeKind: 'OFFICIAL_API',
        surface: 'EXTERNAL_API',
        providerId: intent.providerPreference ?? 'official-provider',
        trustClass: 'OFFICIAL_PROVIDER',
        authState: evidence.officialApiAuthenticated ? 'KNOWN_AUTHENTICATED' : 'LOGIN_REQUIRED',
        evidence: ['OFFICIAL_API_AVAILABLE', evidence.officialApiAuthenticated ? 'API_AUTHENTICATED' : 'API_AUTH_REQUIRED'],
        reason: evidence.officialApiAuthenticated ? 'Official authenticated API is available.' : 'Official API exists but needs authentication.',
        score: (evidence.officialApiAuthenticated ? 100 : 55) + this.profileBonus(profile, ['LOCAL_AUTH', 'CROSS_DEVICE_HANDOFF']),
        canReceivePersonalData: evidence.officialApiAuthenticated,
        canReceivePaymentData: evidence.officialApiAuthenticated,
        appMissingHandled: false,
        webFallbackSelected: false,
        installProposalAllowed,
      });
    }

    for (const app of evidence.installedApps) {
      const canControlInstalledApp = this.supports(profile, 'INSTALLED_APP_CONTROL');
      const canUseDeepLink = this.supports(profile, 'DEEP_LINK');
      if (canControlInstalledApp && app.appInstalled && app.appLaunchable && app.deepLinkAvailable && canUseDeepLink) {
        candidates.push({
          routeKind: 'DEEP_LINK',
          surface: profile?.surface ?? 'MOBILE',
          providerId: app.appId,
          trustClass: 'OFFICIAL_PROVIDER',
          authState: app.appAuthState,
          evidence: ['APP_INSTALLED', 'APP_LAUNCHABLE', 'DEEP_LINK_AVAILABLE', `APP_AUTH_STATE_${app.appAuthState}`],
          reason: 'Installed launchable app exposes a route-specific deep link.',
          score: (app.appAuthState === 'KNOWN_AUTHENTICATED' ? 88 : 70) + this.profileBonus(profile, ['BIOMETRIC_AUTH', 'PAYMENT_CONFIRMATION']),
          canReceivePersonalData: app.appAuthState === 'KNOWN_AUTHENTICATED',
          canReceivePaymentData: app.appAuthState === 'KNOWN_AUTHENTICATED',
          appMissingHandled: false,
          webFallbackSelected: false,
          installProposalAllowed,
        });
      } else if (canControlInstalledApp && app.appInstalled && app.appLaunchable) {
        candidates.push({
          routeKind: 'INSTALLED_APP',
          surface: profile?.surface ?? 'MOBILE',
          providerId: app.appId,
          trustClass: 'OFFICIAL_PROVIDER',
          authState: app.appAuthState,
          evidence: ['APP_INSTALLED', 'APP_LAUNCHABLE', `APP_AUTH_STATE_${app.appAuthState}`],
          reason: 'Installed app can be opened but route-specific deep link evidence is unavailable.',
          score: (app.appAuthState === 'KNOWN_AUTHENTICATED' ? 72 : 48) + this.profileBonus(profile, ['LOCAL_AUTH']),
          canReceivePersonalData: app.appAuthState === 'KNOWN_AUTHENTICATED',
          canReceivePaymentData: false,
          appMissingHandled: false,
          webFallbackSelected: false,
          installProposalAllowed,
        });
      }
    }

    const appMissing = evidence.installedApps.length > 0 && evidence.installedApps.every((app) => !app.appInstalled);
    for (const web of this.sortedWebSurfaces(evidence.webSurfaces)) {
      if ((!web.canSearch && !web.canPrepareReservation) || !this.canUseWeb(profile)) continue;
      candidates.push({
        routeKind: this.webRouteKind(profile, web.canPrepareReservation),
        surface: this.webSurface(profile),
        providerId: web.url,
        trustClass: web.trustClass,
        authState: 'UNKNOWN',
        evidence: [
          appMissing ? 'APP_MISSING_HANDLED' : 'WEB_ROUTE_EVALUATED',
          web.trustClass,
          web.identityVerified ? 'WEB_IDENTITY_VERIFIED' : 'WEB_IDENTITY_UNVERIFIED',
        ],
        reason: appMissing ? 'Installed app is unavailable; continuing the same goal through a trusted web surface.' : 'Web route is available for this goal.',
        score: this.webScore(web) + this.profileBonus(profile, ['BROWSER_AUTOMATION', 'SCREEN_OUTPUT']) - this.sharedDeviceAuthorityPenalty(profile),
        canReceivePersonalData: this.canReceivePersonalData(profile, web),
        canReceivePaymentData: this.canReceivePaymentData(profile, web),
        appMissingHandled: appMissing,
        webFallbackSelected: appMissing,
        installProposalAllowed,
      });
    }

    if (evidence.crossDeviceAvailable) {
      candidates.push({
        routeKind: 'CROSS_DEVICE',
        surface: profile?.surface === 'SMART_TV' ? 'SMART_TV' : 'DESKTOP_APP',
        providerId: 'cross-device',
        trustClass: 'UNKNOWN',
        authState: 'UNKNOWN',
        evidence: ['CROSS_DEVICE_AVAILABLE'],
        reason: 'A paired execution device can continue preparation without pretending completion.',
        score: 25 + this.profileBonus(profile, ['CROSS_DEVICE_HANDOFF']) + this.crossDevicePreference(profile),
        canReceivePersonalData: false,
        canReceivePaymentData: false,
        appMissingHandled: appMissing,
        webFallbackSelected: false,
        installProposalAllowed,
      });
    }

    if (evidence.manualFallbackAvailable) {
      candidates.push({
        routeKind: 'CALL_OR_MANUAL',
        surface: 'HUMAN_HANDOFF',
        providerId: 'manual-handoff',
        trustClass: 'UNKNOWN',
        authState: 'USER_ACTION_REQUIRED',
        evidence: ['MANUAL_FALLBACK_AVAILABLE'],
        reason: 'Manual handoff is available as a truthful non-automated route.',
        score: 10,
        canReceivePersonalData: false,
        canReceivePaymentData: false,
        appMissingHandled: appMissing,
        webFallbackSelected: false,
        installProposalAllowed,
      });
    }

    return candidates;
  }

  private sortedWebSurfaces(webSurfaces: readonly WebSurfaceEvidence[]): readonly WebSurfaceEvidence[] {
    return [...webSurfaces].sort((a, b) => this.webScore(b) - this.webScore(a));
  }

  private webScore(web: WebSurfaceEvidence): number {
    const trustScore = web.trustClass === 'OFFICIAL_PROVIDER' ? 65
      : web.trustClass === 'TRUSTED_BOOKING_PLATFORM' ? 52
        : web.trustClass === 'SEARCH_RESULT_ONLY' ? 18
          : 0;
    return trustScore
      + (web.identityVerified ? 12 : -12)
      + (web.canPrepareReservation ? 10 : 0)
      + (web.canSearch ? 4 : 0);
  }

  private supports(profile: ExecutionSurfaceCapabilityProfile | undefined, capability: ExecutionSurfaceCapability): boolean {
    if (!profile) return true;
    return profile.capabilities.includes(capability);
  }

  private profileBonus(profile: ExecutionSurfaceCapabilityProfile | undefined, capabilities: readonly ExecutionSurfaceCapability[]): number {
    if (!profile) return 0;
    return capabilities.filter((capability) => profile.capabilities.includes(capability)).length * 4;
  }

  private canUseWeb(profile: ExecutionSurfaceCapabilityProfile | undefined): boolean {
    return !profile || profile.capabilities.includes('BROWSER_AUTOMATION') || profile.capabilities.includes('CROSS_DEVICE_HANDOFF');
  }

  private webRouteKind(profile: ExecutionSurfaceCapabilityProfile | undefined, canPrepareReservation: boolean): ExecutionRouteKind {
    if (!canPrepareReservation) return 'GENERAL_BROWSER';
    return profile?.surface === 'MOBILE' || profile?.surface === 'TABLET' || profile?.surface === 'ANDROID'
      ? 'MOBILE_WEB'
      : 'GENERAL_BROWSER';
  }

  private webSurface(profile: ExecutionSurfaceCapabilityProfile | undefined): ExecutionSurface {
    if (profile?.surface === 'DESKTOP_APP') return 'DESKTOP_BROWSER';
    if (profile?.surface === 'SMART_TV') return 'SMART_TV';
    if (profile?.surface === 'MOBILE' || profile?.surface === 'TABLET' || profile?.surface === 'ANDROID') return profile.surface;
    return 'DESKTOP_BROWSER';
  }

  private canReceivePersonalData(profile: ExecutionSurfaceCapabilityProfile | undefined, web: WebSurfaceEvidence): boolean {
    if (profile?.sharedDevice && !profile.authorityState.includes('USER_AUTHORIZED')) return false;
    return web.acceptsPersonalData && web.identityVerified && web.trustClass !== 'UNKNOWN';
  }

  private canReceivePaymentData(profile: ExecutionSurfaceCapabilityProfile | undefined, web: WebSurfaceEvidence): boolean {
    if (profile?.sharedDevice) return false;
    if (profile && !profile.capabilities.includes('PAYMENT_CONFIRMATION')) return false;
    return web.acceptsPaymentData && web.identityVerified && web.trustClass === 'OFFICIAL_PROVIDER';
  }

  private sharedDeviceAuthorityPenalty(profile: ExecutionSurfaceCapabilityProfile | undefined): number {
    return profile?.sharedDevice && !profile.authorityState.includes('USER_AUTHORIZED') ? 80 : 0;
  }

  private crossDevicePreference(profile: ExecutionSurfaceCapabilityProfile | undefined): number {
    return profile?.sharedDevice && profile.capabilities.includes('CROSS_DEVICE_HANDOFF') ? 80 : 0;
  }

  private unavailable(intent: ReservationIntent): RouteCandidate {
    return {
      routeKind: 'UNAVAILABLE',
      surface: intent.executionSurface ?? 'HUMAN_HANDOFF',
      providerId: intent.providerPreference ?? 'unknown',
      trustClass: 'UNKNOWN',
      authState: 'UNKNOWN',
      evidence: ['NO_ELIGIBLE_ROUTE'],
      reason: 'No eligible execution route is currently available.',
      score: 0,
      canReceivePersonalData: false,
      canReceivePaymentData: false,
      appMissingHandled: false,
      webFallbackSelected: false,
      installProposalAllowed: false,
    };
  }
}
