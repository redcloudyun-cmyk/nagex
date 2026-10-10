package com.nagex.mobile

object AdaptiveUiPerception {
    enum class Posture { FOLDED, UNFOLDED, TABLET, UNKNOWN }
    enum class Orientation { PORTRAIT, LANDSCAPE }
    enum class WindowMode { FULLSCREEN, SPLIT_SCREEN, FLOATING, DESKTOP_MODE, UNKNOWN }
    enum class ScreenCaptureCapability { AVAILABLE, BLOCKED_BY_APP, BLOCKED_BY_OS, SECURE_SURFACE, FAILED, UNKNOWN }
    enum class PerceptionMode {
        STRUCTURED_ONLY,
        STRUCTURED_PLUS_VISION,
        VISION_ASSISTED,
        PROTECTED_SURFACE,
        API_NATIVE,
        BROWSER_ALTERNATE,
        HUMAN_ASSISTED,
    }
    enum class ScreenType { UNKNOWN, APP_MAIN, SEARCH, SEARCH_RESULTS, CHAT, SYSTEM_DIALOG, LOCKSCREEN }
    enum class ObjectKind {
        SEARCH_CONTROL,
        SEARCH_INPUT,
        RECENT_QUERY,
        DIRECT_CONVERSATION,
        GROUP_CONVERSATION,
        CHAT_HEADER,
        COMPOSER,
        SEND_CONTROL,
        NAVIGATION_CONTROL,
        SYSTEM_BLOCKER,
        UNKNOWN,
    }
    enum class ActionMethod {
        ACCESSIBILITY_SEMANTIC_ACTION,
        ACCESSIBILITY_SET_TEXT,
        ACCESSIBILITY_CLICK,
        IME_ACTION,
        APP_LAUNCH,
        TREE_VISION_MAPPED_ACTIVATION,
        FRESH_SCREENSHOT_BOUNDED_ACTIVATION,
        HUMAN_INTERACTION,
    }
    enum class Risk { READ_ONLY, LOW, MEDIUM, HIGH }

    data class DisplayContext(
        val widthPx: Int,
        val heightPx: Int,
        val density: Float,
        val posture: Posture,
        val orientation: Orientation,
        val windowMode: WindowMode,
        val splitScreen: Boolean,
    )

    data class SemanticObject(
        val id: String,
        val kind: ObjectKind,
        val label: String = "",
        val clickable: Boolean = false,
        val editable: Boolean = false,
        val confidence: Double = 1.0,
    )

    data class PreviousAction(
        val method: ActionMethod,
        val expectedScreenType: ScreenType? = null,
        val transitionExpected: Boolean = false,
        val reportedSuccess: Boolean = false,
    )

    data class SemanticUiSnapshot(
        val packageName: String?,
        val activityName: String?,
        val displayContext: DisplayContext,
        val objects: List<SemanticObject>,
        val screenType: ScreenType,
        val candidateTargets: List<SemanticObject>,
        val candidateControls: List<SemanticObject>,
        val confidence: Double,
        val ambiguity: Boolean,
        val visionRequired: Boolean,
        val visionUsed: Boolean,
        val screenCaptureCapability: ScreenCaptureCapability,
        val perceptionMode: PerceptionMode,
        val protectedSurfaceMode: Boolean,
        val invalidatesPriorPhysicalHandles: Boolean,
        val recommendedNextActions: List<ActionMethod>,
        val generation: Int,
    )

    data class PerceptionStrategy(
        val perceptionMode: PerceptionMode,
        val protectedSurfaceMode: Boolean,
        val screenCaptureUnavailable: Boolean,
        val useVision: Boolean,
        val continueStructured: Boolean,
        val routeSwitchRequired: Boolean,
        val forbiddenBypassUsed: Boolean = false,
    )

    data class CandidateAction(
        val action: String,
        val method: ActionMethod,
        val risk: Risk,
    )

    data class SendAuthority(
        val targetVerified: Boolean,
        val payloadVerified: Boolean,
        val approvalValid: Boolean,
        val routeVerified: Boolean,
        val duplicateRiskAbsent: Boolean,
    )

    fun buildSnapshot(
        packageName: String?,
        activityName: String?,
        displayContext: DisplayContext,
        objects: List<SemanticObject>,
        previous: SemanticUiSnapshot? = null,
        previousAction: PreviousAction? = null,
        visionUsed: Boolean = false,
        screenCaptureCapability: ScreenCaptureCapability = ScreenCaptureCapability.UNKNOWN,
        keyguardBlocked: Boolean = false,
        overlayBlocked: Boolean = false,
    ): SemanticUiSnapshot {
        val screenType = inferScreenType(objects, keyguardBlocked, overlayBlocked)
        val displayChanged = previous == null || previous.displayContext != displayContext
        val screenChanged = previous != null && previous.screenType != screenType
        val targets = objects.filter { it.kind in TARGET_KINDS }
        val controls = objects.filter { it.clickable || it.editable || it.kind in CONTROL_KINDS }
        val treeWeak = screenType == ScreenType.UNKNOWN || objects.any { it.kind == ObjectKind.UNKNOWN || it.confidence < 0.6 }
        val treeAmbiguous = targets.count { it.kind == ObjectKind.DIRECT_CONVERSATION } > 1
        val noTransition = previousAction?.let {
            it.reportedSuccess && it.transitionExpected && it.expectedScreenType != null && it.expectedScreenType != screenType
        } ?: false
        val visionRequired = displayChanged || treeWeak || treeAmbiguous || noTransition
        val strategy = resolveStrategy(
            screenCaptureCapability = screenCaptureCapability,
            treeConfidence = when {
                treeAmbiguous -> TreeConfidence.AMBIGUOUS
                treeWeak -> TreeConfidence.WEAK
                else -> TreeConfidence.STRONG
            },
            layoutChangeDetected = displayChanged || screenChanged,
            previousActionFailedToTransition = noTransition,
        )
        val confidence = if (objects.isEmpty()) 0.0 else objects.map { it.confidence }.average().coerceIn(0.0, 1.0)
        val recommended = if (keyguardBlocked || overlayBlocked) {
            listOf(ActionMethod.HUMAN_INTERACTION)
        } else {
            buildList {
                add(ActionMethod.ACCESSIBILITY_SEMANTIC_ACTION)
                if (objects.any { it.editable }) add(ActionMethod.ACCESSIBILITY_SET_TEXT)
                if (visionRequired && strategy.useVision) {
                    add(ActionMethod.TREE_VISION_MAPPED_ACTIVATION)
                    add(ActionMethod.FRESH_SCREENSHOT_BOUNDED_ACTIVATION)
                }
                if (strategy.routeSwitchRequired) add(ActionMethod.HUMAN_INTERACTION)
            }
        }
        return SemanticUiSnapshot(
            packageName = packageName,
            activityName = activityName,
            displayContext = displayContext,
            objects = objects,
            screenType = screenType,
            candidateTargets = targets,
            candidateControls = controls,
            confidence = confidence,
            ambiguity = treeAmbiguous,
            visionRequired = visionRequired,
            visionUsed = visionUsed,
            screenCaptureCapability = screenCaptureCapability,
            perceptionMode = strategy.perceptionMode,
            protectedSurfaceMode = strategy.protectedSurfaceMode,
            invalidatesPriorPhysicalHandles = displayChanged || screenChanged,
            recommendedNextActions = recommended,
            generation = if (displayChanged || previous == null) 1 else previous.generation + 1,
        )
    }

    fun resolveStrategy(
        screenCaptureCapability: ScreenCaptureCapability,
        treeConfidence: TreeConfidence,
        layoutChangeDetected: Boolean,
        previousActionFailedToTransition: Boolean,
        browserAlternateAvailable: Boolean = false,
        apiNativeAvailable: Boolean = false,
    ): PerceptionStrategy {
        if (apiNativeAvailable) {
            return PerceptionStrategy(
                perceptionMode = PerceptionMode.API_NATIVE,
                protectedSurfaceMode = false,
                screenCaptureUnavailable = screenCaptureCapability != ScreenCaptureCapability.AVAILABLE,
                useVision = false,
                continueStructured = true,
                routeSwitchRequired = false,
            )
        }

        val blocked = screenCaptureCapability == ScreenCaptureCapability.BLOCKED_BY_APP ||
            screenCaptureCapability == ScreenCaptureCapability.BLOCKED_BY_OS ||
            screenCaptureCapability == ScreenCaptureCapability.SECURE_SURFACE
        if (blocked) {
            if (treeConfidence == TreeConfidence.STRONG) {
                return PerceptionStrategy(
                    perceptionMode = PerceptionMode.PROTECTED_SURFACE,
                    protectedSurfaceMode = true,
                    screenCaptureUnavailable = true,
                    useVision = false,
                    continueStructured = true,
                    routeSwitchRequired = false,
                )
            }
            return PerceptionStrategy(
                perceptionMode = if (browserAlternateAvailable) PerceptionMode.BROWSER_ALTERNATE else PerceptionMode.HUMAN_ASSISTED,
                protectedSurfaceMode = true,
                screenCaptureUnavailable = true,
                useVision = false,
                continueStructured = false,
                routeSwitchRequired = true,
            )
        }

        if (screenCaptureCapability == ScreenCaptureCapability.AVAILABLE) {
            val useVision = treeConfidence != TreeConfidence.STRONG || layoutChangeDetected || previousActionFailedToTransition
            return PerceptionStrategy(
                perceptionMode = if (useVision) PerceptionMode.STRUCTURED_PLUS_VISION else PerceptionMode.STRUCTURED_ONLY,
                protectedSurfaceMode = false,
                screenCaptureUnavailable = false,
                useVision = useVision,
                continueStructured = true,
                routeSwitchRequired = false,
            )
        }

        if (screenCaptureCapability == ScreenCaptureCapability.FAILED) {
            val strong = treeConfidence == TreeConfidence.STRONG
            return PerceptionStrategy(
                perceptionMode = if (strong) PerceptionMode.STRUCTURED_ONLY else PerceptionMode.HUMAN_ASSISTED,
                protectedSurfaceMode = false,
                screenCaptureUnavailable = true,
                useVision = false,
                continueStructured = strong,
                routeSwitchRequired = !strong,
            )
        }

        return PerceptionStrategy(
            perceptionMode = if (treeConfidence == TreeConfidence.STRONG) PerceptionMode.STRUCTURED_ONLY else PerceptionMode.VISION_ASSISTED,
            protectedSurfaceMode = false,
            screenCaptureUnavailable = false,
            useVision = treeConfidence != TreeConfidence.STRONG,
            continueStructured = true,
            routeSwitchRequired = false,
        )
    }

    fun chooseBestSafeAction(snapshot: SemanticUiSnapshot, candidates: List<CandidateAction>): CandidateAction? {
        val preferredPool = candidates.filter { it.risk == Risk.READ_ONLY || it.risk == Risk.LOW }
            .ifEmpty { candidates.filter { it.risk != Risk.HIGH } }
        return preferredPool.firstOrNull { snapshot.recommendedNextActions.contains(it.method) } ?: preferredPool.firstOrNull()
    }

    fun canExecuteHighRiskSend(authority: SendAuthority): Boolean =
        authority.targetVerified &&
            authority.payloadVerified &&
            authority.approvalValid &&
            authority.routeVerified &&
            authority.duplicateRiskAbsent

    private fun inferScreenType(objects: List<SemanticObject>, keyguardBlocked: Boolean, overlayBlocked: Boolean): ScreenType {
        if (keyguardBlocked) return ScreenType.LOCKSCREEN
        if (overlayBlocked) return ScreenType.SYSTEM_DIALOG
        if (objects.any { it.kind == ObjectKind.CHAT_HEADER } && objects.any { it.kind == ObjectKind.COMPOSER }) return ScreenType.CHAT
        if (objects.any { it.kind == ObjectKind.DIRECT_CONVERSATION || it.kind == ObjectKind.GROUP_CONVERSATION || it.kind == ObjectKind.RECENT_QUERY }) return ScreenType.SEARCH_RESULTS
        if (objects.any { it.kind == ObjectKind.SEARCH_INPUT }) return ScreenType.SEARCH
        if (objects.any { it.kind == ObjectKind.SEARCH_CONTROL }) return ScreenType.APP_MAIN
        return ScreenType.UNKNOWN
    }

    enum class TreeConfidence { STRONG, WEAK, AMBIGUOUS }

    private val TARGET_KINDS = setOf(
        ObjectKind.RECENT_QUERY,
        ObjectKind.DIRECT_CONVERSATION,
        ObjectKind.GROUP_CONVERSATION,
        ObjectKind.CHAT_HEADER,
    )

    private val CONTROL_KINDS = setOf(
        ObjectKind.SEARCH_CONTROL,
        ObjectKind.SEARCH_INPUT,
        ObjectKind.COMPOSER,
        ObjectKind.SEND_CONTROL,
        ObjectKind.NAVIGATION_CONTROL,
    )
}
