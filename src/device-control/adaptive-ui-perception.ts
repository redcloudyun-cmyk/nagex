import type { CapabilityRisk } from '../capabilities/capability.types.js';

export type UiPosture = 'FOLDED' | 'UNFOLDED' | 'TABLET' | 'UNKNOWN';
export type UiOrientation = 'PORTRAIT' | 'LANDSCAPE';
export type UiWindowMode = 'FULLSCREEN' | 'SPLIT_SCREEN' | 'FLOATING' | 'DESKTOP_MODE' | 'UNKNOWN';
export type ScreenCaptureCapability = 'AVAILABLE' | 'BLOCKED_BY_APP' | 'BLOCKED_BY_OS' | 'SECURE_SURFACE' | 'FAILED' | 'UNKNOWN';
export type DevicePlatform = 'ANDROID' | 'IOS' | 'WINDOWS' | 'MACOS' | 'UNKNOWN';
export type PerceptionMode =
  | 'STRUCTURED_ONLY'
  | 'STRUCTURED_PLUS_VISION'
  | 'VISION_ASSISTED'
  | 'PROTECTED_SURFACE'
  | 'API_NATIVE'
  | 'BROWSER_ALTERNATE'
  | 'HUMAN_ASSISTED';

export type SemanticScreenType =
  | 'UNKNOWN'
  | 'APP_MAIN'
  | 'SEARCH'
  | 'SEARCH_RESULTS'
  | 'CHAT'
  | 'HOME'
  | 'JOURNEY_SEARCH'
  | 'STATION_SELECTION'
  | 'DATE_TIME_SELECTION'
  | 'TRAIN_RESULTS'
  | 'TRAIN_DETAIL'
  | 'SEAT_CLASS_SELECTION'
  | 'RESERVATION_REVIEW'
  | 'BOOKING_CONFIRMATION'
  | 'PAYMENT'
  | 'SYSTEM_DIALOG'
  | 'LOCKSCREEN';

export type SemanticObjectKind =
  | 'SEARCH_CONTROL'
  | 'SEARCH_INPUT'
  | 'RECENT_QUERY'
  | 'DIRECT_CONVERSATION'
  | 'GROUP_CONVERSATION'
  | 'CHAT_HEADER'
  | 'COMPOSER'
  | 'SEND_CONTROL'
  | 'DEPARTURE_STATION'
  | 'ARRIVAL_STATION'
  | 'DEPARTURE_DATE'
  | 'DEPARTURE_TIME'
  | 'SEARCH_TRAINS'
  | 'TRAIN_RESULT'
  | 'TRAIN_NUMBER'
  | 'DEPARTURE_TIME_VALUE'
  | 'ARRIVAL_TIME_VALUE'
  | 'DURATION'
  | 'SEAT_CLASS'
  | 'FARE'
  | 'RESERVE_CONTROL'
  | 'BOOKING_SUMMARY'
  | 'PAYMENT_CONTROL'
  | 'CONFIRMATION_REFERENCE'
  | 'NAVIGATION_CONTROL'
  | 'SYSTEM_BLOCKER'
  | 'UNKNOWN';

export type AdaptiveActionMethod =
  | 'ACCESSIBILITY_SEMANTIC_ACTION'
  | 'ACCESSIBILITY_SET_TEXT'
  | 'ACCESSIBILITY_CLICK'
  | 'IME_ACTION'
  | 'APP_LAUNCH'
  | 'TREE_VISION_MAPPED_ACTIVATION'
  | 'FRESH_SCREENSHOT_BOUNDED_ACTIVATION'
  | 'HUMAN_INTERACTION';

export interface DisplayContext {
  widthPx: number;
  heightPx: number;
  density: number;
  posture: UiPosture;
  orientation: UiOrientation;
  windowMode: UiWindowMode;
  splitScreen: boolean;
  rotation?: number;
  safeArea?: { left: number; top: number; right: number; bottom: number };
}

export interface DeviceCapabilityProfile {
  platform: DevicePlatform;
  modelMetadata?: string | null;
  display: DisplayContext;
  perception: {
    accessibilityTreeAvailable: boolean;
    screenshotAvailable: boolean;
    visionAvailable: boolean;
    semanticTextAvailable: boolean;
    structuredUiAvailable: boolean;
  };
  interaction: {
    semanticClickAvailable: boolean;
    textInputAvailable: boolean;
    imeActionAvailable: boolean;
    appLaunchAvailable: boolean;
    deepLinkAvailable: boolean;
    backNavigationAvailable: boolean;
  };
  execution: {
    foregroundControlAvailable: boolean;
    backgroundExecutionAvailable: boolean;
    browserControlAvailable: boolean;
    nativeAppControlAvailable: boolean;
  };
  restrictions: {
    protectedSurface: boolean;
    biometricRequired: boolean;
    osPermissionGate: boolean;
    screenshotBlocked: boolean;
    accessibilityLimited: boolean;
  };
}

export interface DeviceCapabilityDiscoveryInput {
  platform: DevicePlatform;
  modelMetadata?: string | null;
  display: DisplayContext;
  accessibilityTreeAvailable: boolean;
  screenCaptureCapability: ScreenCaptureCapability;
  visionRuntimeAvailable: boolean;
  semanticTextAvailable: boolean;
  structuredUiAvailable: boolean;
  semanticClickAvailable: boolean;
  textInputAvailable: boolean;
  imeActionAvailable: boolean;
  appLaunchAvailable: boolean;
  deepLinkAvailable: boolean;
  backNavigationAvailable: boolean;
  foregroundControlAvailable: boolean;
  backgroundExecutionAvailable: boolean;
  browserControlAvailable: boolean;
  nativeAppControlAvailable: boolean;
  biometricRequired?: boolean;
  osPermissionGate?: boolean;
}

export interface UiBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SemanticUiObject {
  id: string;
  kind: SemanticObjectKind;
  label?: string;
  resourceId?: string;
  bounds?: UiBounds;
  clickable?: boolean;
  editable?: boolean;
  confidence: number;
}

export interface UiObservationInput {
  packageName: string | null;
  activityName: string | null;
  visibleText: string[];
  resourceIds: string[];
  objects: SemanticUiObject[];
  screenshotArtifact?: string | null;
  visionInterpretation?: string | null;
  screenCaptureCapability?: ScreenCaptureCapability;
  displayContext: DisplayContext;
  keyboardVisible: boolean;
  overlayState: 'NONE' | 'NOTIFICATION_SHADE' | 'SYSTEM_DIALOG' | 'UNKNOWN';
  keyguardState: 'CLEAR' | 'LOCKED' | 'AOD' | 'UNKNOWN';
}

export interface SemanticUiSnapshot extends UiObservationInput {
  screenType: SemanticScreenType;
  candidateTargets: SemanticUiObject[];
  candidateControls: SemanticUiObject[];
  confidence: number;
  ambiguity: 'NONE' | 'LOW' | 'HIGH';
  visionUsed: boolean;
  visionRequired: boolean;
  perceptionMode: PerceptionMode;
  protectedSurfaceMode: boolean;
  invalidatesPriorPhysicalHandles: boolean;
  recommendedNextActions: AdaptiveActionMethod[];
  generation: number;
}

export interface PreviousObservation {
  displayContext: DisplayContext;
  screenType: SemanticScreenType;
  generation: number;
}

export interface PreviousAction {
  method: AdaptiveActionMethod;
  expectedScreenType?: SemanticScreenType;
  transitionExpected?: boolean;
  reportedSuccess?: boolean;
}

export interface AppProfile {
  appId: string;
  screenTypes: readonly SemanticScreenType[];
  semanticObjects: readonly SemanticObjectKind[];
  actions: readonly string[];
  highRiskActions: readonly string[];
}

export const KAKAO_APP_PROFILE: AppProfile = {
  appId: 'KAKAOTALK',
  screenTypes: ['APP_MAIN', 'SEARCH', 'SEARCH_RESULTS', 'CHAT'],
  semanticObjects: [
    'SEARCH_CONTROL',
    'SEARCH_INPUT',
    'RECENT_QUERY',
    'DIRECT_CONVERSATION',
    'GROUP_CONVERSATION',
    'CHAT_HEADER',
    'COMPOSER',
    'SEND_CONTROL',
  ],
  actions: ['OPEN_SEARCH', 'ENTER_QUERY', 'OPEN_CONVERSATION', 'TYPE_MESSAGE', 'SEND_MESSAGE', 'NAVIGATE_BACK'],
  highRiskActions: ['SEND_MESSAGE'],
};

export const KORAIL_APP_PROFILE: AppProfile = {
  appId: 'KORAIL',
  screenTypes: [
    'HOME',
    'JOURNEY_SEARCH',
    'STATION_SELECTION',
    'DATE_TIME_SELECTION',
    'TRAIN_RESULTS',
    'TRAIN_DETAIL',
    'SEAT_CLASS_SELECTION',
    'RESERVATION_REVIEW',
    'BOOKING_CONFIRMATION',
    'PAYMENT',
  ],
  semanticObjects: [
    'DEPARTURE_STATION',
    'ARRIVAL_STATION',
    'DEPARTURE_DATE',
    'DEPARTURE_TIME',
    'SEARCH_TRAINS',
    'TRAIN_RESULT',
    'TRAIN_NUMBER',
    'DEPARTURE_TIME_VALUE',
    'ARRIVAL_TIME_VALUE',
    'DURATION',
    'SEAT_CLASS',
    'FARE',
    'RESERVE_CONTROL',
    'BOOKING_SUMMARY',
    'PAYMENT_CONTROL',
    'CONFIRMATION_REFERENCE',
  ],
  actions: ['OPEN_APP', 'SET_STATION', 'SET_DATE_TIME', 'SEARCH_TRAINS', 'OPEN_TRAIN_DETAIL', 'SELECT_SEAT_CLASS', 'PREPARE_RESERVATION'],
  highRiskActions: ['BOOK', 'PAY'],
};

function sameDisplay(a: DisplayContext, b: DisplayContext): boolean {
  return (
    a.widthPx === b.widthPx &&
    a.heightPx === b.heightPx &&
    a.density === b.density &&
    a.posture === b.posture &&
    a.orientation === b.orientation &&
    a.windowMode === b.windowMode &&
    a.splitScreen === b.splitScreen
  );
}

export function hasMeaningfulDisplayChange(previous: PreviousObservation | null, next: DisplayContext): boolean {
  if (!previous) return true;
  return !sameDisplay(previous.displayContext, next);
}

function inferScreenType(input: UiObservationInput): SemanticScreenType {
  if (input.keyguardState !== 'CLEAR') return 'LOCKSCREEN';
  if (input.overlayState === 'SYSTEM_DIALOG' || input.overlayState === 'NOTIFICATION_SHADE') return 'SYSTEM_DIALOG';
  if (input.objects.some((o) => o.kind === 'COMPOSER') && input.objects.some((o) => o.kind === 'CHAT_HEADER')) return 'CHAT';
  if (input.objects.some((o) => o.kind === 'DIRECT_CONVERSATION' || o.kind === 'GROUP_CONVERSATION' || o.kind === 'RECENT_QUERY')) return 'SEARCH_RESULTS';
  if (input.objects.some((o) => o.kind === 'SEARCH_INPUT')) return 'SEARCH';
  if (input.objects.some((o) => o.kind === 'SEARCH_CONTROL')) return 'APP_MAIN';
  return 'UNKNOWN';
}

function isTarget(o: SemanticUiObject): boolean {
  return o.kind === 'DIRECT_CONVERSATION' || o.kind === 'GROUP_CONVERSATION' || o.kind === 'RECENT_QUERY' || o.kind === 'CHAT_HEADER';
}

function isControl(o: SemanticUiObject): boolean {
  return o.clickable === true || o.editable === true || o.kind === 'SEARCH_CONTROL' || o.kind === 'COMPOSER' || o.kind === 'SEND_CONTROL';
}

export interface BuildSemanticSnapshotInput {
  observation: UiObservationInput;
  previousObservation?: PreviousObservation | null;
  previousAction?: PreviousAction | null;
}

export function buildSemanticUiSnapshot(input: BuildSemanticSnapshotInput): SemanticUiSnapshot {
  const { observation, previousObservation = null, previousAction = null } = input;
  const screenType = inferScreenType(observation);
  const displayChanged = hasMeaningfulDisplayChange(previousObservation, observation.displayContext);
  const ambiguousCandidates = observation.objects.filter(isTarget);
  const actionSucceededWithoutTransition = Boolean(
    previousAction?.reportedSuccess &&
    previousAction.transitionExpected &&
    previousAction.expectedScreenType &&
    previousAction.expectedScreenType !== screenType,
  );
  const treeAmbiguous = ambiguousCandidates.length > 1;
  const treeWeak = screenType === 'UNKNOWN' || observation.objects.some((o) => o.kind === 'UNKNOWN' || o.confidence < 0.6);
  const visionRequired = displayChanged || treeAmbiguous || treeWeak || actionSucceededWithoutTransition;
  const visionUsed = Boolean(observation.screenshotArtifact || observation.visionInterpretation);
  const screenCaptureCapability = observation.screenCaptureCapability ?? (visionUsed ? 'AVAILABLE' : 'UNKNOWN');
  const strategy = resolvePerceptionStrategy({
    screenCaptureCapability,
    treeConfidence: treeWeak ? 'WEAK' : treeAmbiguous ? 'AMBIGUOUS' : 'STRONG',
    layoutChangeDetected: displayChanged,
    previousActionOutcome: actionSucceededWithoutTransition ? 'NO_TRANSITION' : 'OK',
    riskLevel: 'LOW',
    availableRoutes: [],
  });
  const ambiguity = treeAmbiguous ? 'HIGH' : treeWeak ? 'LOW' : 'NONE';
  const confidence = observation.objects.length === 0 ? 0 : Math.min(1, observation.objects.reduce((sum, o) => sum + o.confidence, 0) / observation.objects.length);
  const generation = previousObservation && !displayChanged ? previousObservation.generation + 1 : 1;

  const recommendedNextActions: AdaptiveActionMethod[] = [];
  if (screenType === 'LOCKSCREEN' || screenType === 'SYSTEM_DIALOG') {
    recommendedNextActions.push('HUMAN_INTERACTION');
  } else {
    recommendedNextActions.push('ACCESSIBILITY_SEMANTIC_ACTION');
    if (visionRequired) recommendedNextActions.push('TREE_VISION_MAPPED_ACTIVATION', 'FRESH_SCREENSHOT_BOUNDED_ACTIVATION');
    if (observation.objects.some((o) => o.editable)) recommendedNextActions.push('ACCESSIBILITY_SET_TEXT', 'IME_ACTION');
  }

  return {
    ...observation,
    screenType,
    candidateTargets: observation.objects.filter(isTarget),
    candidateControls: observation.objects.filter(isControl),
    confidence,
    ambiguity,
    visionUsed,
    visionRequired,
    perceptionMode: strategy.perceptionMode,
    protectedSurfaceMode: strategy.protectedSurfaceMode,
    invalidatesPriorPhysicalHandles: displayChanged || screenType !== previousObservation?.screenType,
    recommendedNextActions,
    generation,
  };
}

export interface PerceptionStrategyInput {
  screenCaptureCapability: ScreenCaptureCapability;
  treeConfidence: 'STRONG' | 'WEAK' | 'AMBIGUOUS';
  layoutChangeDetected: boolean;
  previousActionOutcome: 'OK' | 'NO_TRANSITION' | 'FAILED' | 'UNKNOWN';
  riskLevel: CapabilityRisk;
  availableRoutes: Array<'API_NATIVE' | 'STRUCTURED_NATIVE' | 'BROWSER' | 'DEEPLINK' | 'TRUSTED_DEVICE' | 'HUMAN'>;
}

export function discoverDeviceCapabilityProfile(input: DeviceCapabilityDiscoveryInput): DeviceCapabilityProfile {
  const screenshotBlocked = input.screenCaptureCapability === 'BLOCKED_BY_APP' ||
    input.screenCaptureCapability === 'BLOCKED_BY_OS' ||
    input.screenCaptureCapability === 'SECURE_SURFACE';
  return {
    platform: input.platform,
    modelMetadata: input.modelMetadata ?? null,
    display: input.display,
    perception: {
      accessibilityTreeAvailable: input.accessibilityTreeAvailable,
      screenshotAvailable: input.screenCaptureCapability === 'AVAILABLE',
      visionAvailable: input.visionRuntimeAvailable && input.screenCaptureCapability === 'AVAILABLE',
      semanticTextAvailable: input.semanticTextAvailable,
      structuredUiAvailable: input.structuredUiAvailable,
    },
    interaction: {
      semanticClickAvailable: input.semanticClickAvailable,
      textInputAvailable: input.textInputAvailable,
      imeActionAvailable: input.imeActionAvailable,
      appLaunchAvailable: input.appLaunchAvailable,
      deepLinkAvailable: input.deepLinkAvailable,
      backNavigationAvailable: input.backNavigationAvailable,
    },
    execution: {
      foregroundControlAvailable: input.foregroundControlAvailable,
      backgroundExecutionAvailable: input.backgroundExecutionAvailable,
      browserControlAvailable: input.browserControlAvailable,
      nativeAppControlAvailable: input.nativeAppControlAvailable,
    },
    restrictions: {
      protectedSurface: input.screenCaptureCapability === 'SECURE_SURFACE' || input.screenCaptureCapability === 'BLOCKED_BY_APP',
      biometricRequired: input.biometricRequired ?? false,
      osPermissionGate: input.osPermissionGate ?? false,
      screenshotBlocked,
      accessibilityLimited: !input.accessibilityTreeAvailable || !input.structuredUiAvailable,
    },
  };
}

export function capabilitiesChanged(previous: DeviceCapabilityProfile, next: DeviceCapabilityProfile): boolean {
  return JSON.stringify({
    display: previous.display,
    perception: previous.perception,
    interaction: previous.interaction,
    execution: previous.execution,
    restrictions: previous.restrictions,
  }) !== JSON.stringify({
    display: next.display,
    perception: next.perception,
    interaction: next.interaction,
    execution: next.execution,
    restrictions: next.restrictions,
  });
}

export function strategyInputFromCapabilityProfile(
  profile: DeviceCapabilityProfile,
  treeConfidence: PerceptionStrategyInput['treeConfidence'],
  previousActionOutcome: PerceptionStrategyInput['previousActionOutcome'],
): PerceptionStrategyInput {
  const screenCaptureCapability: ScreenCaptureCapability = profile.restrictions.protectedSurface
    ? 'SECURE_SURFACE'
    : profile.perception.screenshotAvailable
      ? 'AVAILABLE'
      : profile.restrictions.screenshotBlocked
        ? 'BLOCKED_BY_APP'
        : 'UNKNOWN';
  const availableRoutes: PerceptionStrategyInput['availableRoutes'] = [];
  if (profile.execution.nativeAppControlAvailable) availableRoutes.push('STRUCTURED_NATIVE');
  if (profile.execution.browserControlAvailable) availableRoutes.push('BROWSER');
  if (profile.interaction.deepLinkAvailable) availableRoutes.push('DEEPLINK');
  if (!profile.execution.nativeAppControlAvailable && !profile.execution.browserControlAvailable) availableRoutes.push('HUMAN');
  return {
    screenCaptureCapability,
    treeConfidence,
    layoutChangeDetected: false,
    previousActionOutcome,
    riskLevel: 'LOW',
    availableRoutes,
  };
}

export interface PerceptionStrategy {
  perceptionMode: PerceptionMode;
  protectedSurfaceMode: boolean;
  screenCaptureUnavailable: boolean;
  useVision: boolean;
  continueStructured: boolean;
  routeSwitchRequired: boolean;
  forbiddenBypassUsed: false;
}

export function resolvePerceptionStrategy(input: PerceptionStrategyInput): PerceptionStrategy {
  if (input.availableRoutes.includes('API_NATIVE')) {
    return strategy('API_NATIVE', false, input.screenCaptureCapability !== 'AVAILABLE', false, true, false);
  }

  const blocked = input.screenCaptureCapability === 'BLOCKED_BY_APP' ||
    input.screenCaptureCapability === 'BLOCKED_BY_OS' ||
    input.screenCaptureCapability === 'SECURE_SURFACE';

  if (blocked) {
    const strongEnough = input.treeConfidence === 'STRONG';
    if (strongEnough) return strategy('PROTECTED_SURFACE', true, true, false, true, false);
    if (input.availableRoutes.includes('BROWSER')) return strategy('BROWSER_ALTERNATE', true, true, false, false, true);
    return strategy('HUMAN_ASSISTED', true, true, false, false, true);
  }

  if (input.screenCaptureCapability === 'AVAILABLE') {
    const shouldUseVision = input.treeConfidence !== 'STRONG' || input.layoutChangeDetected || input.previousActionOutcome !== 'OK';
    return strategy(shouldUseVision ? 'STRUCTURED_PLUS_VISION' : 'STRUCTURED_ONLY', false, false, shouldUseVision, true, false);
  }

  if (input.screenCaptureCapability === 'FAILED') {
    return strategy(input.treeConfidence === 'STRONG' ? 'STRUCTURED_ONLY' : 'HUMAN_ASSISTED', false, true, false, input.treeConfidence === 'STRONG', input.treeConfidence !== 'STRONG');
  }

  return strategy(input.treeConfidence === 'STRONG' ? 'STRUCTURED_ONLY' : 'VISION_ASSISTED', false, false, input.treeConfidence !== 'STRONG', true, false);
}

function strategy(
  perceptionMode: PerceptionMode,
  protectedSurfaceMode: boolean,
  screenCaptureUnavailable: boolean,
  useVision: boolean,
  continueStructured: boolean,
  routeSwitchRequired: boolean,
): PerceptionStrategy {
  return {
    perceptionMode,
    protectedSurfaceMode,
    screenCaptureUnavailable,
    useVision,
    continueStructured,
    routeSwitchRequired,
    forbiddenBypassUsed: false,
  };
}

export interface CachedPhysicalHandle {
  objectId: string;
  bounds: UiBounds;
  displayContext: DisplayContext;
  screenType: SemanticScreenType;
  generation: number;
}

export function canReusePhysicalHandle(handle: CachedPhysicalHandle, snapshot: SemanticUiSnapshot): boolean {
  return (
    handle.generation === snapshot.generation &&
    handle.screenType === snapshot.screenType &&
    sameDisplay(handle.displayContext, snapshot.displayContext) &&
    !snapshot.invalidatesPriorPhysicalHandles
  );
}

export function shouldCaptureScreenshotBeforeAction(snapshot: SemanticUiSnapshot): boolean {
  return snapshot.visionRequired && !snapshot.visionUsed && snapshot.screenCaptureCapability === 'AVAILABLE';
}

export interface CandidateAction {
  action: string;
  method: AdaptiveActionMethod;
  targetKind?: SemanticObjectKind;
  risk: CapabilityRisk;
}

export function chooseBestSafeAction(snapshot: SemanticUiSnapshot, candidates: CandidateAction[]): CandidateAction | null {
  const lowRisk = candidates.filter((c) => c.risk === 'READ_ONLY' || c.risk === 'LOW');
  const pool = lowRisk.length > 0 ? lowRisk : candidates.filter((c) => c.risk !== 'RESTRICTED');
  return pool.find((c) => snapshot.recommendedNextActions.includes(c.method)) ?? pool[0] ?? null;
}

export interface SendAuthorityInput {
  targetVerified: boolean;
  payloadVerified: boolean;
  approvalValid: boolean;
  routeVerified: boolean;
  duplicateRiskAbsent: boolean;
}

export function canExecuteHighRiskSend(input: SendAuthorityInput): boolean {
  return input.targetVerified && input.payloadVerified && input.approvalValid && input.routeVerified && input.duplicateRiskAbsent;
}

export interface BookingAuthorityInput {
  selectedTrainVerified: boolean;
  dateTimeVerified: boolean;
  seatClassVerified: boolean;
  fareVerified: boolean;
  approvalValid: boolean;
  finalAvailabilityRevalidated: boolean;
  duplicateRiskAbsent: boolean;
}

export function canExecuteHighRiskBooking(input: BookingAuthorityInput): boolean {
  return input.selectedTrainVerified &&
    input.dateTimeVerified &&
    input.seatClassVerified &&
    input.fareVerified &&
    input.approvalValid &&
    input.finalAvailabilityRevalidated &&
    input.duplicateRiskAbsent;
}

export interface BookingMaterialState {
  train: string;
  departureTime: string;
  arrivalTime: string;
  seatClass: string;
  fare: string | null;
}

export function requiresBookingRevalidation(previous: BookingMaterialState, next: BookingMaterialState): boolean {
  return previous.train !== next.train ||
    previous.departureTime !== next.departureTime ||
    previous.arrivalTime !== next.arrivalTime ||
    previous.seatClass !== next.seatClass ||
    previous.fare !== next.fare;
}
