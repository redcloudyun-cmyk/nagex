import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KAKAO_APP_PROFILE,
  KORAIL_APP_PROFILE,
  buildSemanticUiSnapshot,
  canExecuteHighRiskBooking,
  canExecuteHighRiskSend,
  canReusePhysicalHandle,
  chooseBestSafeAction,
  capabilitiesChanged,
  discoverDeviceCapabilityProfile,
  hasMeaningfulDisplayChange,
  requiresBookingRevalidation,
  resolvePerceptionStrategy,
  shouldCaptureScreenshotBeforeAction,
  strategyInputFromCapabilityProfile,
  type DisplayContext,
  type SemanticUiObject,
  type UiObservationInput,
} from '../src/device-control/adaptive-ui-perception.js';

const folded: DisplayContext = {
  widthPx: 904,
  heightPx: 2316,
  density: 3,
  posture: 'FOLDED',
  orientation: 'PORTRAIT',
  windowMode: 'FULLSCREEN',
  splitScreen: false,
};

const unfolded: DisplayContext = {
  widthPx: 1768,
  heightPx: 2208,
  density: 2.5,
  posture: 'UNFOLDED',
  orientation: 'PORTRAIT',
  windowMode: 'SPLIT_SCREEN',
  splitScreen: true,
};

const searchInput: SemanticUiObject = {
  id: 'search-input',
  kind: 'SEARCH_INPUT',
  label: 'Search',
  resourceId: 'com.kakao.talk:id/search_input',
  editable: true,
  confidence: 0.95,
};

const directConversation: SemanticUiObject = {
  id: 'direct-1',
  kind: 'DIRECT_CONVERSATION',
  label: '조민형 (Blue Dia/Mini)',
  clickable: true,
  confidence: 0.98,
};

const recentChip: SemanticUiObject = {
  id: 'recent-chip',
  kind: 'RECENT_QUERY',
  label: '조민형',
  clickable: true,
  confidence: 0.86,
};

function observation(overrides: Partial<UiObservationInput> = {}): UiObservationInput {
  return {
    packageName: 'com.kakao.talk',
    activityName: 'com.kakao.talk.activity.main.MainActivity',
    visibleText: [],
    resourceIds: [],
    objects: [searchInput],
    screenshotArtifact: null,
    visionInterpretation: null,
    displayContext: folded,
    keyboardVisible: false,
    overlayState: 'NONE',
    keyguardState: 'CLEAR',
    ...overrides,
  };
}

test('A. folded vs unfolded dimensions produce different observations and invalidate handles', () => {
  const first = buildSemanticUiSnapshot({ observation: observation({ displayContext: folded }) });
  const second = buildSemanticUiSnapshot({
    observation: observation({ displayContext: unfolded }),
    previousObservation: { displayContext: folded, screenType: first.screenType, generation: first.generation },
  });
  assert.equal(hasMeaningfulDisplayChange({ displayContext: folded, screenType: first.screenType, generation: first.generation }, unfolded), true);
  assert.equal(second.invalidatesPriorPhysicalHandles, true);
  assert.equal(second.displayContext.posture, 'UNFOLDED');
  assert.equal(second.displayContext.windowMode, 'SPLIT_SCREEN');
});

test('B-C. orientation or screen-size change requires fresh screenshot before deciding next action', () => {
  const previous = buildSemanticUiSnapshot({ observation: observation() });
  const landscape: DisplayContext = { ...folded, widthPx: 2316, heightPx: 904, orientation: 'LANDSCAPE' };
  const next = buildSemanticUiSnapshot({
    observation: observation({ displayContext: landscape, screenCaptureCapability: 'AVAILABLE' }),
    previousObservation: { displayContext: folded, screenType: previous.screenType, generation: previous.generation },
  });
  assert.equal(next.visionRequired, true);
  assert.equal(shouldCaptureScreenshotBeforeAction(next), true);
});

test('D. accessibility candidate ambiguity triggers vision', () => {
  const snap = buildSemanticUiSnapshot({
    observation: observation({
      objects: [directConversation, { ...directConversation, id: 'direct-2', label: '조민형 후보', confidence: 0.84 }],
    }),
  });
  assert.equal(snap.ambiguity, 'HIGH');
  assert.equal(snap.visionRequired, true);
  assert.ok(snap.recommendedNextActions.includes('TREE_VISION_MAPPED_ACTIVATION'));
});

test('E. ACTION_CLICK=true with no transition triggers new observation/vision path', () => {
  const previous = buildSemanticUiSnapshot({ observation: observation({ objects: [searchInput] }) });
  const snap = buildSemanticUiSnapshot({
    observation: observation({ objects: [searchInput] }),
    previousObservation: { displayContext: folded, screenType: previous.screenType, generation: previous.generation },
    previousAction: {
      method: 'ACCESSIBILITY_CLICK',
      expectedScreenType: 'SEARCH_RESULTS',
      transitionExpected: true,
      reportedSuccess: true,
    },
  });
  assert.equal(snap.visionRequired, true);
});

test('F. recent-search chip is semantic state, not terminal failure', () => {
  const snap = buildSemanticUiSnapshot({ observation: observation({ objects: [searchInput, recentChip] }) });
  assert.equal(snap.screenType, 'SEARCH_RESULTS');
  assert.equal(snap.candidateTargets[0].kind, 'RECENT_QUERY');
  assert.notEqual(snap.recommendedNextActions[0], 'HUMAN_INTERACTION');
});

test('G. search result layout variation still resolves DIRECT_CONVERSATION semantically', () => {
  const snap = buildSemanticUiSnapshot({
    observation: observation({
      displayContext: unfolded,
      objects: [{ ...directConversation, bounds: { left: 50, top: 620, right: 820, bottom: 760 } }],
      screenshotArtifact: 'tmp_screen_1',
    }),
  });
  assert.equal(snap.screenType, 'SEARCH_RESULTS');
  assert.equal(snap.candidateTargets.length, 1);
  assert.equal(snap.candidateTargets[0].kind, 'DIRECT_CONVERSATION');
});

test('H-I. stale coordinates and vision bounds are rejected after screen transition/change', () => {
  const first = buildSemanticUiSnapshot({
    observation: observation({
      objects: [{ ...directConversation, bounds: { left: 10, top: 10, right: 300, bottom: 80 } }],
      screenshotArtifact: 'tmp_screen_before',
    }),
  });
  const handle = {
    objectId: 'direct-1',
    bounds: first.candidateTargets[0].bounds!,
    displayContext: first.displayContext,
    screenType: first.screenType,
    generation: first.generation,
  };
  const chat = buildSemanticUiSnapshot({
    observation: observation({
      objects: [
        { id: 'header', kind: 'CHAT_HEADER', label: '조민형 (Blue Dia/Mini)', confidence: 0.98 },
        { id: 'composer', kind: 'COMPOSER', editable: true, confidence: 0.98 },
      ],
      displayContext: unfolded,
      screenshotArtifact: 'tmp_screen_after',
    }),
    previousObservation: { displayContext: first.displayContext, screenType: first.screenType, generation: first.generation },
  });
  assert.equal(canReusePhysicalHandle(handle, chat), false);
});

test('J. low-risk navigation can choose adaptive fallback without high-risk authority', () => {
  const snap = buildSemanticUiSnapshot({ observation: observation({ objects: [{ ...searchInput, confidence: 0.4 }] }) });
  const chosen = chooseBestSafeAction(snap, [
    { action: 'SEND_MESSAGE', method: 'ACCESSIBILITY_CLICK', targetKind: 'SEND_CONTROL', risk: 'CONSEQUENTIAL' },
    { action: 'OPEN_SEARCH', method: 'TREE_VISION_MAPPED_ACTIVATION', targetKind: 'SEARCH_CONTROL', risk: 'LOW' },
  ]);
  assert.equal(chosen?.action, 'OPEN_SEARCH');
});

test('K. high-risk SEND still requires deterministic approval and revalidation', () => {
  assert.equal(canExecuteHighRiskSend({
    targetVerified: true,
    payloadVerified: true,
    approvalValid: true,
    routeVerified: true,
    duplicateRiskAbsent: true,
  }), true);
  assert.equal(canExecuteHighRiskSend({
    targetVerified: true,
    payloadVerified: true,
    approvalValid: false,
    routeVerified: true,
    duplicateRiskAbsent: true,
  }), false);
});

test('L. screenshot artifact is an ephemeral reference, not raw pixels/base64', () => {
  const snap = buildSemanticUiSnapshot({
    observation: observation({ screenshotArtifact: 'tmp_ephemeral_screen_1', visionInterpretation: 'search results visible' }),
  });
  assert.equal(snap.visionUsed, true);
  assert.equal(snap.screenshotArtifact?.startsWith('tmp_'), true);
  assert.doesNotMatch(JSON.stringify(snap), /data:image\/png;base64/);
});

test('M. app profile is semantic and not a hard-coded device workflow', () => {
  assert.equal(KAKAO_APP_PROFILE.semanticObjects.includes('DIRECT_CONVERSATION'), true);
  assert.equal(KAKAO_APP_PROFILE.actions.includes('SEND_MESSAGE'), true);
  assert.equal(KORAIL_APP_PROFILE.semanticObjects.includes('DEPARTURE_STATION'), true);
  assert.equal(KORAIL_APP_PROFILE.semanticObjects.includes('TRAIN_RESULT'), true);
  assert.deepEqual(Object.keys(KAKAO_APP_PROFILE).includes('coordinates'), false);
  assert.deepEqual(Object.keys(KAKAO_APP_PROFILE).includes('fixedBounds'), false);
});

test('1. screenshot AVAILABLE makes Vision path eligible only when useful', () => {
  const strategy = resolvePerceptionStrategy({
    screenCaptureCapability: 'AVAILABLE',
    treeConfidence: 'WEAK',
    layoutChangeDetected: true,
    previousActionOutcome: 'OK',
    riskLevel: 'LOW',
    availableRoutes: [],
  });
  assert.equal(strategy.perceptionMode, 'STRUCTURED_PLUS_VISION');
  assert.equal(strategy.useVision, true);
});

test('2-3. screenshot blocked enters Protected Surface Mode and is not task failure', () => {
  const strategy = resolvePerceptionStrategy({
    screenCaptureCapability: 'BLOCKED_BY_APP',
    treeConfidence: 'STRONG',
    layoutChangeDetected: false,
    previousActionOutcome: 'OK',
    riskLevel: 'LOW',
    availableRoutes: [],
  });
  assert.equal(strategy.perceptionMode, 'PROTECTED_SURFACE');
  assert.equal(strategy.protectedSurfaceMode, true);
  assert.equal(strategy.continueStructured, true);
  assert.equal(strategy.forbiddenBypassUsed, false);
});

test('4-5. protected screen strong tree continues; weak tree switches route', () => {
  const strong = resolvePerceptionStrategy({
    screenCaptureCapability: 'SECURE_SURFACE',
    treeConfidence: 'STRONG',
    layoutChangeDetected: false,
    previousActionOutcome: 'OK',
    riskLevel: 'LOW',
    availableRoutes: [],
  });
  const weak = resolvePerceptionStrategy({
    screenCaptureCapability: 'SECURE_SURFACE',
    treeConfidence: 'WEAK',
    layoutChangeDetected: false,
    previousActionOutcome: 'OK',
    riskLevel: 'LOW',
    availableRoutes: ['BROWSER'],
  });
  assert.equal(strong.continueStructured, true);
  assert.equal(weak.perceptionMode, 'BROWSER_ALTERNATE');
  assert.equal(weak.routeSwitchRequired, true);
});

test('6. no forbidden secure-surface bypass is ever represented as available', () => {
  const strategy = resolvePerceptionStrategy({
    screenCaptureCapability: 'SECURE_SURFACE',
    treeConfidence: 'AMBIGUOUS',
    layoutChangeDetected: true,
    previousActionOutcome: 'FAILED',
    riskLevel: 'LOW',
    availableRoutes: ['BROWSER'],
  });
  assert.equal(strategy.forbiddenBypassUsed, false);
  assert.equal(strategy.useVision, false);
});

test('9-10. screen-size change invalidates Vision geometry and stale screenshots are rejected', () => {
  const before = buildSemanticUiSnapshot({ observation: observation({ screenshotArtifact: 'tmp_old', screenCaptureCapability: 'AVAILABLE' }) });
  const after = buildSemanticUiSnapshot({
    observation: observation({ displayContext: unfolded, screenshotArtifact: null, screenCaptureCapability: 'AVAILABLE' }),
    previousObservation: { displayContext: before.displayContext, screenType: before.screenType, generation: before.generation },
  });
  assert.equal(after.invalidatesPriorPhysicalHandles, true);
  assert.equal(shouldCaptureScreenshotBeforeAction(after), true);
});

test('12-13. high-risk booking requires approval and material fare/time changes require revalidation', () => {
  assert.equal(canExecuteHighRiskBooking({
    selectedTrainVerified: true,
    dateTimeVerified: true,
    seatClassVerified: true,
    fareVerified: true,
    approvalValid: true,
    finalAvailabilityRevalidated: true,
    duplicateRiskAbsent: true,
  }), true);
  assert.equal(canExecuteHighRiskBooking({
    selectedTrainVerified: true,
    dateTimeVerified: true,
    seatClassVerified: true,
    fareVerified: true,
    approvalValid: false,
    finalAvailabilityRevalidated: true,
    duplicateRiskAbsent: true,
  }), false);
  assert.equal(requiresBookingRevalidation(
    { train: 'KTX 101', departureTime: '09:00', arrivalTime: '11:40', seatClass: 'Standard', fare: '59800' },
    { train: 'KTX 101', departureTime: '09:10', arrivalTime: '11:50', seatClass: 'Standard', fare: '59800' },
  ), true);
});

test('14-15. route switching preserves same semantic goal across physical layouts', () => {
  const strategy = resolvePerceptionStrategy({
    screenCaptureCapability: 'BLOCKED_BY_OS',
    treeConfidence: 'WEAK',
    layoutChangeDetected: true,
    previousActionOutcome: 'NO_TRANSITION',
    riskLevel: 'LOW',
    availableRoutes: ['BROWSER'],
  });
  const foldedSnap = buildSemanticUiSnapshot({ observation: observation({ objects: [{ id: 'korail-from', kind: 'DEPARTURE_STATION', label: 'Seoul', confidence: 0.9 }] }) });
  const unfoldedSnap = buildSemanticUiSnapshot({ observation: observation({ displayContext: unfolded, objects: [{ id: 'korail-from-wide', kind: 'DEPARTURE_STATION', label: 'Seoul', confidence: 0.9 }] }) });
  assert.equal(strategy.perceptionMode, 'BROWSER_ALTERNATE');
  assert.equal(foldedSnap.objects[0].kind, unfoldedSnap.objects[0].kind);
});

test('16. screenshot artifact remains ephemeral under protected-surface contracts', () => {
  const snap = buildSemanticUiSnapshot({
    observation: observation({ screenshotArtifact: 'tmp_ephemeral_korail_screen', screenCaptureCapability: 'AVAILABLE' }),
  });
  assert.equal(snap.screenshotArtifact?.startsWith('tmp_ephemeral_'), true);
  assert.doesNotMatch(JSON.stringify(snap), /base64|data:image/);
});

test('17. unknown Android model discovers capabilities without model-name dependency', () => {
  const profile = discoverDeviceCapabilityProfile({
    platform: 'ANDROID',
    modelMetadata: 'Unknown Vendor/Prototype',
    display: folded,
    accessibilityTreeAvailable: true,
    screenCaptureCapability: 'AVAILABLE',
    visionRuntimeAvailable: true,
    semanticTextAvailable: true,
    structuredUiAvailable: true,
    semanticClickAvailable: true,
    textInputAvailable: true,
    imeActionAvailable: true,
    appLaunchAvailable: true,
    deepLinkAvailable: true,
    backNavigationAvailable: true,
    foregroundControlAvailable: true,
    backgroundExecutionAvailable: false,
    browserControlAvailable: true,
    nativeAppControlAvailable: true,
  });
  const strategy = resolvePerceptionStrategy(strategyInputFromCapabilityProfile(profile, 'STRONG', 'OK'));
  assert.equal(profile.modelMetadata, 'Unknown Vendor/Prototype');
  assert.equal(profile.perception.accessibilityTreeAvailable, true);
  assert.equal(strategy.continueStructured, true);
});

test('18. resolution density posture and orientation changes force capability re-evaluation', () => {
  const before = discoverDeviceCapabilityProfile({
    platform: 'ANDROID',
    display: folded,
    accessibilityTreeAvailable: true,
    screenCaptureCapability: 'AVAILABLE',
    visionRuntimeAvailable: true,
    semanticTextAvailable: true,
    structuredUiAvailable: true,
    semanticClickAvailable: true,
    textInputAvailable: true,
    imeActionAvailable: true,
    appLaunchAvailable: true,
    deepLinkAvailable: true,
    backNavigationAvailable: true,
    foregroundControlAvailable: true,
    backgroundExecutionAvailable: false,
    browserControlAvailable: true,
    nativeAppControlAvailable: true,
  });
  const after = discoverDeviceCapabilityProfile({
    platform: 'ANDROID',
    display: { ...unfolded, density: 2.25, orientation: 'LANDSCAPE', widthPx: 2208, heightPx: 1768 },
    accessibilityTreeAvailable: true,
    screenCaptureCapability: 'AVAILABLE',
    visionRuntimeAvailable: true,
    semanticTextAvailable: true,
    structuredUiAvailable: true,
    semanticClickAvailable: true,
    textInputAvailable: true,
    imeActionAvailable: true,
    appLaunchAvailable: true,
    deepLinkAvailable: true,
    backNavigationAvailable: true,
    foregroundControlAvailable: true,
    backgroundExecutionAvailable: false,
    browserControlAvailable: true,
    nativeAppControlAvailable: true,
  });
  assert.equal(capabilitiesChanged(before, after), true);
});

test('19. protected screenshot and no Vision can continue on strong Accessibility or switch route when weak', () => {
  const protectedProfile = discoverDeviceCapabilityProfile({
    platform: 'ANDROID',
    display: folded,
    accessibilityTreeAvailable: true,
    screenCaptureCapability: 'SECURE_SURFACE',
    visionRuntimeAvailable: true,
    semanticTextAvailable: true,
    structuredUiAvailable: true,
    semanticClickAvailable: true,
    textInputAvailable: true,
    imeActionAvailable: true,
    appLaunchAvailable: true,
    deepLinkAvailable: true,
    backNavigationAvailable: true,
    foregroundControlAvailable: true,
    backgroundExecutionAvailable: false,
    browserControlAvailable: true,
    nativeAppControlAvailable: true,
  });
  const strong = resolvePerceptionStrategy(strategyInputFromCapabilityProfile(protectedProfile, 'STRONG', 'OK'));
  const weak = resolvePerceptionStrategy(strategyInputFromCapabilityProfile(protectedProfile, 'WEAK', 'OK'));
  assert.equal(strong.perceptionMode, 'PROTECTED_SURFACE');
  assert.equal(strong.continueStructured, true);
  assert.equal(weak.perceptionMode, 'BROWSER_ALTERNATE');
});

test('20. iOS capability profile can differ from Android without planner failure', () => {
  const profile = discoverDeviceCapabilityProfile({
    platform: 'IOS',
    modelMetadata: 'metadata-only',
    display: { ...folded, posture: 'UNKNOWN' },
    accessibilityTreeAvailable: false,
    screenCaptureCapability: 'UNKNOWN',
    visionRuntimeAvailable: false,
    semanticTextAvailable: false,
    structuredUiAvailable: false,
    semanticClickAvailable: false,
    textInputAvailable: false,
    imeActionAvailable: false,
    appLaunchAvailable: false,
    deepLinkAvailable: true,
    backNavigationAvailable: false,
    foregroundControlAvailable: false,
    backgroundExecutionAvailable: false,
    browserControlAvailable: true,
    nativeAppControlAvailable: false,
  });
  const strategyInput = strategyInputFromCapabilityProfile(profile, 'WEAK', 'UNKNOWN');
  assert.equal(profile.platform, 'IOS');
  assert.deepEqual(strategyInput.availableRoutes, ['BROWSER', 'DEEPLINK']);
  assert.equal(resolvePerceptionStrategy(strategyInput).perceptionMode, 'VISION_ASSISTED');
});

test('21. model metadata is never a primary capability or route-selection input', () => {
  const base = {
    platform: 'ANDROID' as const,
    display: folded,
    accessibilityTreeAvailable: true,
    screenCaptureCapability: 'AVAILABLE' as const,
    visionRuntimeAvailable: true,
    semanticTextAvailable: true,
    structuredUiAvailable: true,
    semanticClickAvailable: true,
    textInputAvailable: true,
    imeActionAvailable: true,
    appLaunchAvailable: true,
    deepLinkAvailable: true,
    backNavigationAvailable: true,
    foregroundControlAvailable: true,
    backgroundExecutionAvailable: false,
    browserControlAvailable: true,
    nativeAppControlAvailable: true,
  };
  const knownModel = discoverDeviceCapabilityProfile({ ...base, modelMetadata: 'Samsung/SM-F926N' });
  const unknownModel = discoverDeviceCapabilityProfile({ ...base, modelMetadata: 'New Vendor/Future Device' });

  assert.equal(capabilitiesChanged(knownModel, unknownModel), false);
  assert.deepEqual(
    strategyInputFromCapabilityProfile(knownModel, 'STRONG', 'OK'),
    strategyInputFromCapabilityProfile(unknownModel, 'STRONG', 'OK'),
  );
});
