export type LifeExecutionModality =
  | 'TEXT'
  | 'VOICE'
  | 'SCREEN'
  | 'SHARE'
  | 'IMAGE'
  | 'EVENT'
  | 'MULTIMODAL';

export type LifeExecutionCategory =
  | 'TRANSPORT'
  | 'RESTAURANT'
  | 'GOLF_OR_LEISURE'
  | 'SERVICE_APPOINTMENT'
  | 'LODGING'
  | 'GENERAL_RESERVATION'
  | 'SCHEDULING';

export type LifeExecutionLifecycleState =
  | 'INTENT_RECEIVED'
  | 'REQUIREMENTS_INTERPRETED'
  | 'NEEDS_INFORMATION'
  | 'ROUTE_RESOLUTION'
  | 'SEARCHING'
  | 'CANDIDATES_FOUND'
  | 'AVAILABILITY_VERIFIED'
  | 'OPTION_SELECTED'
  | 'MATERIAL_TERMS_VERIFIED'
  | 'PREPARED'
  | 'AWAITING_APPROVAL'
  | 'FINAL_REVALIDATION'
  | 'EXECUTING'
  | 'OUTCOME_OBSERVED'
  | 'CONFIRMATION_VERIFIED'
  | 'CLEANUP'
  | 'COMPLETE'
  | 'NEEDS_AUTHENTICATION'
  | 'FAILED_RECOVERABLE'
  | 'FAILED_TERMINAL'
  | 'OUTCOME_UNCERTAIN'
  | 'USER_HANDOFF_REQUIRED';

export type ExecutionRouteKind =
  | 'OFFICIAL_API'
  | 'INSTALLED_APP'
  | 'DEEP_LINK'
  | 'MOBILE_WEB'
  | 'GENERAL_BROWSER'
  | 'CROSS_DEVICE'
  | 'CALL_OR_MANUAL'
  | 'UNAVAILABLE';

export type ExecutionSurface =
  | 'MOBILE'
  | 'DESKTOP_APP'
  | 'DESKTOP_BROWSER'
  | 'SMART_TV'
  | 'TABLET'
  | 'WEARABLE'
  | 'CAR'
  | 'OTHER'
  | 'SERVER'
  | 'ANDROID'
  | 'IOS'
  | 'WEB'
  | 'BROWSER'
  | 'DESKTOP'
  | 'EXTERNAL_API'
  | 'HUMAN_HANDOFF';

export type ExecutionSurfaceCapability =
  | 'VOICE_INPUT'
  | 'TEXT_INPUT'
  | 'REMOTE_CONTROL_INPUT'
  | 'SCREEN_OUTPUT'
  | 'COMPACT_OVERLAY'
  | 'BROWSER_AUTOMATION'
  | 'INSTALLED_APP_CONTROL'
  | 'DEEP_LINK'
  | 'FILE_ACCESS'
  | 'LOCAL_AUTH'
  | 'BIOMETRIC_AUTH'
  | 'PAYMENT_CONFIRMATION'
  | 'NOTIFICATION'
  | 'AUDIO_OUTPUT'
  | 'CAMERA'
  | 'MICROPHONE'
  | 'CROSS_DEVICE_HANDOFF';

export type SharedDeviceAuthorityState =
  | 'DEVICE_PRESENT'
  | 'USER_IDENTIFIED'
  | 'USER_AUTHORIZED';

export interface SmartTvAuthorityBoundary {
  readonly userProfileResolution: 'REQUIRED' | 'RESOLVED' | 'UNAVAILABLE';
  readonly voiceIdentity: 'REQUIRED' | 'MATCHED' | 'UNAVAILABLE';
  readonly mobileConfirmation: 'REQUIRED' | 'COMPLETED' | 'UNAVAILABLE';
  readonly privateDataDisplayPolicy: 'REDACT' | 'LIMITED' | 'ALLOW';
  readonly paymentHandoff: 'REQUIRED' | 'COMPLETED' | 'NOT_ALLOWED';
}

export interface ExecutionSurfaceCapabilityProfile {
  readonly surface: ExecutionSurface;
  readonly deviceType: 'MOBILE' | 'DESKTOP_APP' | 'DESKTOP_BROWSER' | 'SMART_TV' | 'TABLET' | 'WEARABLE' | 'CAR' | 'OTHER';
  readonly capabilities: readonly ExecutionSurfaceCapability[];
  readonly sharedDevice: boolean;
  readonly authorityState: readonly SharedDeviceAuthorityState[];
  readonly smartTvAuthorityBoundary?: SmartTvAuthorityBoundary;
}

export type ProviderTrustClass =
  | 'OFFICIAL_PROVIDER'
  | 'TRUSTED_BOOKING_PLATFORM'
  | 'SEARCH_RESULT_ONLY'
  | 'UNKNOWN';

export type AuthState =
  | 'KNOWN_AUTHENTICATED'
  | 'KNOWN_UNAUTHENTICATED'
  | 'UNKNOWN'
  | 'LOGIN_REQUIRED'
  | 'USER_ACTION_REQUIRED';

export type MaterialTermStatus = 'VERIFIED' | 'PARTIAL' | 'UNKNOWN' | 'CHANGED';

export type PaymentRequirement = 'NONE' | 'PAY_LATER' | 'DEPOSIT' | 'PREPAYMENT' | 'UNKNOWN';
export type ApprovalRequirement = 'NONE' | 'JIT_REQUIRED' | 'REAPPROVAL_REQUIRED';

export interface LifeExecutionIntent {
  readonly intentId: string;
  readonly category: LifeExecutionCategory;
  readonly modalities: readonly LifeExecutionModality[];
  readonly sourceDevice: string;
  readonly executionDevice?: string;
  readonly executionSurface?: ExecutionSurface;
  readonly createdAt: string;
  readonly locale?: string;
  readonly naturalLanguage: string;
}

export interface ReservationIntent extends LifeExecutionIntent {
  readonly kind: 'RESERVATION';
  readonly location?: string;
  readonly date?: string;
  readonly timeWindow?: string;
  readonly partySize?: number;
  readonly quantity?: number;
  readonly budget?: MoneyRange;
  readonly preferences: readonly string[];
  readonly providerPreference?: string;
  readonly paymentRequirement: PaymentRequirement;
  readonly approvalRequirement: ApprovalRequirement;
}

export interface SchedulingIntent extends LifeExecutionIntent {
  readonly kind: 'SCHEDULING';
  readonly title: string;
  readonly attendees?: readonly string[];
  readonly date?: string;
  readonly timeWindow?: string;
  readonly durationMinutes?: number;
  readonly calendarProviderPreference?: string;
  readonly linkedReservationId?: string;
  readonly approvalRequirement: ApprovalRequirement;
}

export interface Money {
  readonly currency: string;
  readonly amount: number;
}

export interface MoneyRange {
  readonly currency: string;
  readonly min?: number;
  readonly max?: number;
}

export interface AvailabilityEvidence {
  readonly source: string;
  readonly observedAt: string;
  readonly trustClass: ProviderTrustClass;
  readonly identityVerified: boolean;
  readonly dateTimeVerified: boolean;
  readonly availabilityVerified: boolean;
  readonly priceVerified: boolean;
  readonly termsVerified: boolean;
  readonly rawEvidenceRef?: string;
}

export interface ReservationCandidate {
  readonly candidateId: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly trustClass: ProviderTrustClass;
  readonly title: string;
  readonly location?: string;
  readonly date?: string;
  readonly timeWindow?: string;
  readonly partySize?: number;
  readonly quantity?: number;
  readonly price?: Money;
  readonly availability: AvailabilityEvidence;
}

export interface MaterialTerms {
  readonly target: string;
  readonly provider: string;
  readonly date?: string;
  readonly timeWindow?: string;
  readonly partySize?: number;
  readonly quantity?: number;
  readonly price?: Money;
  readonly cancellationPolicy?: string;
  readonly refundPolicy?: string;
  readonly depositRequired?: boolean;
  readonly paymentRequirement: PaymentRequirement;
  readonly personalDataRequired: readonly string[];
  readonly status: MaterialTermStatus;
  readonly evidenceRefs: readonly string[];
  readonly version: string;
}

export interface ReservationProposal {
  readonly proposalId: string;
  readonly intentId: string;
  readonly candidate: ReservationCandidate;
  readonly route: ExecutionRoute;
  readonly materialTerms: MaterialTerms;
  readonly lifecycleState: LifeExecutionLifecycleState;
  readonly missingCriticalFields: readonly string[];
  readonly visibleAssumptions: readonly string[];
}

export interface InstalledAppEvidence {
  readonly appId: string;
  readonly appInstalled: boolean;
  readonly appLaunchable: boolean;
  readonly appAuthState: AuthState;
  readonly deepLinkAvailable: boolean;
  readonly storeListingObserved?: boolean;
  readonly installationRequired?: boolean;
  readonly observedAt: string;
}

export interface WebSurfaceEvidence {
  readonly url: string;
  readonly trustClass: ProviderTrustClass;
  readonly identityVerified: boolean;
  readonly canSearch: boolean;
  readonly canPrepareReservation: boolean;
  readonly acceptsPersonalData: boolean;
  readonly acceptsPaymentData: boolean;
}

export interface RouteResolutionEvidence {
  readonly officialApiAvailable: boolean;
  readonly officialApiAuthenticated: boolean;
  readonly surfaceProfile?: ExecutionSurfaceCapabilityProfile;
  readonly installedApps: readonly InstalledAppEvidence[];
  readonly webSurfaces: readonly WebSurfaceEvidence[];
  readonly crossDeviceAvailable: boolean;
  readonly manualFallbackAvailable: boolean;
}

export interface ExecutionRoute {
  readonly routeKind: ExecutionRouteKind;
  readonly surface: ExecutionSurface;
  readonly providerId: string;
  readonly trustClass: ProviderTrustClass;
  readonly authState: AuthState;
  readonly evidence: readonly string[];
  readonly reason: string;
  readonly appMissingHandled: boolean;
  readonly webFallbackSelected: boolean;
  readonly goalContinued: boolean;
  readonly canReceivePersonalData: boolean;
  readonly canReceivePaymentData: boolean;
  readonly installProposalAllowed: boolean;
  readonly installWithoutExplicitApproval: false;
}

export interface ExecutionEvidence {
  readonly actionSubmitted: boolean;
  readonly outcomeObserved: boolean;
  readonly confirmationVerified: boolean;
  readonly confirmationId?: string;
  readonly providerAccepted?: boolean;
  readonly visibleState?: string;
  readonly evidenceRefs: readonly string[];
}

export type ExecutionOutcomeStatus =
  | 'PREPARED_ONLY'
  | 'ACTION_TRIGGERED'
  | 'SESSION_ALREADY_AUTHENTICATED'
  | 'LOGIN_REQUIRED'
  | 'USER_ACTION_REQUIRED'
  | 'ALTERNATE_ROUTE_AVAILABLE'
  | 'BOOKED_UNVERIFIED'
  | 'BOOKED_VERIFIED'
  | 'OUTCOME_UNCERTAIN'
  | 'FAILED_RECOVERABLE'
  | 'FAILED_TERMINAL';

export interface ExecutionOutcome {
  readonly status: ExecutionOutcomeStatus;
  readonly lifecycleState: LifeExecutionLifecycleState;
  readonly approvalConsumed: boolean;
  readonly bookingState: 'NONE' | 'PREPARED' | 'SUBMITTED' | 'VERIFIED' | 'UNCERTAIN' | 'FAILED';
  readonly paymentState: 'NONE' | 'NOT_REQUIRED' | 'REQUIRED_NOT_PAID' | 'AUTHORIZED' | 'CAPTURED' | 'UNKNOWN';
  readonly evidenceRefs: readonly string[];
  readonly reason: string;
}
