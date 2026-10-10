package com.nagex.mobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityService.TakeScreenshotCallback
import android.content.res.Configuration
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.Rect
import android.hardware.HardwareBuffer
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Bounded Android Accessibility executor for the M4C KakaoTalk draft route.
 *
 * Android/user settings control whether this service is enabled. NAgex does
 * not self-enable it, does not execute raw coordinates, and never presses send.
 */
class NagexAccessibilityExecutionService : AccessibilityService() {
    @Volatile
    private var interruptedByUser = false
    private lateinit var deviceAgentPollingOwner: DeviceAgentPollingOwner
    private var previousUiSnapshot: AdaptiveUiPerception.SemanticUiSnapshot? = null
    private var latestScreenCaptureCapability: AdaptiveUiPerception.ScreenCaptureCapability = AdaptiveUiPerception.ScreenCaptureCapability.UNKNOWN

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        deviceAgentPollingOwnerOrNull()?.watchdogTick()
        val packageName = event?.packageName?.toString() ?: return
        if (!ALLOWED_PACKAGES.contains(packageName)) return
        if (event.eventType == AccessibilityEvent.TYPE_TOUCH_INTERACTION_START) {
            interruptedByUser = true
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        activeService = this
        interruptedByUser = false
        deviceAgentPollingOwner = DeviceAgentPollingOwner(
            transportFactory = { createDeviceAgentTransportOrNull() },
            dispatcher = AccessibilityExecutionPlanDispatcher(),
        )
        deviceAgentPollingOwner.ensureDeviceAgentRunning("accessibility_service_connected")
    }

    override fun onDestroy() {
        deviceAgentPollingOwnerOrNull()?.stop("accessibility_service_destroyed")
        if (activeService === this) activeService = null
        previousUiSnapshot = null
        super.onDestroy()
    }

    override fun onInterrupt() {
        interruptedByUser = true
        deviceAgentPollingOwnerOrNull()?.watchdogTick()
    }

    fun isInterruptedByUser(): Boolean = interruptedByUser

    fun currentPackageName(): String? = rootInActiveWindow?.packageName?.toString()

    fun executeBoundedAction(action: String, target: NodeSelector, approvedText: String? = null, expectedProviderDisplayName: String? = null, expectedMessageHash: String? = null, searchQuery: String? = null): ActionResult {
        if (interruptedByUser) return ActionResult(false, "USER_INTERRUPTED")
        if (!ALLOWED_ACTIONS.contains(action)) return ActionResult(false, "ACTION_NOT_ALLOWLISTED")
        if (action == "PRESS_SEND" || action == "REQUEST_SEND_APPROVAL") return ActionResult(false, "SEND_ACTION_DISABLED_IN_M4C")

        if (requiresKakaoForegroundRecovery(action)) {
            val foreground = ensureTargetAppForeground("com.kakao.talk")
            if (!foreground.ok) return foreground
        }

        val root = activeRootWithRetry() ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
        val packageName = root.packageName?.toString() ?: return ActionResult(false, "UNKNOWN_PACKAGE")
        if (!ALLOWED_PACKAGES.contains(packageName)) {
            if (action == "KAKAOTALK_GOVERNED_SEND" && packageName == "com.android.systemui") {
                if (!performGlobalAction(GLOBAL_ACTION_BACK)) return ActionResult(false, "SAFE_RECOVERY_BACK_FAILED")
                SystemClock.sleep(600)
                val recoveredPackageName = activeRootWithRetry()?.packageName?.toString() ?: return ActionResult(false, "WAITING_FOR_PRECONDITION")
                if (!ALLOWED_PACKAGES.contains(recoveredPackageName)) return ActionResult(false, "WAITING_FOR_PRECONDITION")
                if (expectedProviderDisplayName.isNullOrBlank()) return ActionResult(false, "KAKAO_DIRECT_TARGET_IDENTITY_REQUIRED")
                if (approvedText == null || expectedMessageHash.isNullOrBlank()) return ActionResult(false, "KAKAO_SEND_MESSAGE_REQUIRED")
                return executeGovernedKakaoSend(expectedProviderDisplayName, approvedText, expectedMessageHash)
            }
            return ActionResult(false, "WAITING_FOR_PRECONDITION")
        }
        observeAdaptiveUi(root, expectedProviderDisplayName)

        return when (action) {
            "FIND_ELEMENT", "OBSERVE_RESULT" -> {
                val node = findFirstWithRetry(target)
                ActionResult(node != null, if (node != null) "FOUND" else "NODE_NOT_FOUND")
            }
            "FOCUS_INPUT", "CLICK_ALLOWED_NODE" -> {
                val node = if (target.requireSelectedAfterClick || target.requireUnique) {
                    findUniqueWithRetry(target)
                } else {
                    findFirstWithRetry(target)
                } ?: return ActionResult(false, if (target.lastMatchCount > 1) "AMBIGUOUS_NODE" else "NODE_NOT_FOUND")

                if (action == "CLICK_ALLOWED_NODE" && target.requireSelectedAfterClick && node.isSelected) {
                    return ActionResult(true, "NAV_ALREADY_SELECTED")
                }

                val clickableTarget = if (action == "CLICK_ALLOWED_NODE") firstClickableSelfOrAncestor(node) else node
                val accessibilityAction = if (action == "FOCUS_INPUT") AccessibilityNodeInfo.ACTION_FOCUS else AccessibilityNodeInfo.ACTION_CLICK
                val clicked = clickableTarget.performAction(accessibilityAction)
                if (!clicked) return ActionResult(false, action)

                if (action == "CLICK_ALLOWED_NODE" && target.requireSelectedAfterClick) {
                    SystemClock.sleep(250)
                    val selectedTarget = target.copy(selected = true)
                    val selectedNode = findUniqueWithRetry(selectedTarget)
                    return ActionResult(selectedNode != null, if (selectedNode != null) "NAV_SELECTED_AFTER_CLICK" else "NAV_SELECTION_VERIFY_FAILED")
                }
                ActionResult(true, action)
            }
            "SELECT_KAKAO_DIRECT_CONVERSATION" -> {
                if (expectedProviderDisplayName.isNullOrBlank()) return ActionResult(false, "KAKAO_DIRECT_TARGET_IDENTITY_REQUIRED")
                selectUniqueKakaoDirectConversation(expectedProviderDisplayName)
            }
            "DRY_RUN_SELECT_KAKAO_DIRECT_CONVERSATION" -> {
                if (expectedProviderDisplayName.isNullOrBlank()) return ActionResult(false, "KAKAO_DIRECT_TARGET_IDENTITY_REQUIRED")
                dryRunSelectUniqueKakaoDirectConversation(expectedProviderDisplayName)
            }
            "KAKAOTALK_GOVERNED_SEND" -> {
                if (expectedProviderDisplayName.isNullOrBlank()) return ActionResult(false, "KAKAO_DIRECT_TARGET_IDENTITY_REQUIRED")
                if (approvedText == null || expectedMessageHash.isNullOrBlank()) return ActionResult(false, "KAKAO_SEND_MESSAGE_REQUIRED")
                executeGovernedKakaoSend(expectedProviderDisplayName, approvedText, expectedMessageHash)
            }
            "KAKAOTALK_PREPARE_MESSAGE" -> {
                if (expectedProviderDisplayName.isNullOrBlank()) return ActionResult(false, "KAKAO_DIRECT_TARGET_IDENTITY_REQUIRED")
                if (approvedText == null || expectedMessageHash.isNullOrBlank()) return ActionResult(false, "KAKAO_SEND_MESSAGE_REQUIRED")
                prepareKakaoMessage(expectedProviderDisplayName, approvedText, expectedMessageHash)
            }
            "KAKAOTALK_SEARCH_TO_PREPARE_MESSAGE" -> {
                if (expectedProviderDisplayName.isNullOrBlank()) return ActionResult(false, "KAKAO_DIRECT_TARGET_IDENTITY_REQUIRED")
                if (approvedText == null || expectedMessageHash.isNullOrBlank()) return ActionResult(false, "KAKAO_SEND_MESSAGE_REQUIRED")
                if (searchQuery.isNullOrBlank()) return ActionResult(false, "KAKAO_SEARCH_QUERY_REQUIRED")
                prepareKakaoSearchToMessage(searchQuery, expectedProviderDisplayName, approvedText, expectedMessageHash)
            }
            "KAKAOTALK_SEARCH_TO_SEND" -> {
                if (expectedProviderDisplayName.isNullOrBlank()) return ActionResult(false, "KAKAO_DIRECT_TARGET_IDENTITY_REQUIRED")
                if (approvedText == null || expectedMessageHash.isNullOrBlank()) return ActionResult(false, "KAKAO_SEND_MESSAGE_REQUIRED")
                if (searchQuery.isNullOrBlank()) return ActionResult(false, "KAKAO_SEARCH_QUERY_REQUIRED")
                executeKakaoSearchToSend(searchQuery, expectedProviderDisplayName, approvedText, expectedMessageHash)
            }
            "TYPE_APPROVED_TEXT", "TYPE_APPROVED_RECIPIENT_QUERY" -> {
                val node = findFirstWithRetry(target) ?: return ActionResult(false, "NODE_NOT_FOUND")
                if (!node.isEditable || approvedText == null) return ActionResult(false, "TEXT_INPUT_NOT_ALLOWED")
                val args = Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, approvedText)
                }
                ActionResult(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args), action)
            }
            "SCROLL_BOUNDED" -> {
                val node = findFirstWithRetry(target) ?: return ActionResult(false, "NODE_NOT_FOUND")
                ActionResult(node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD), "SCROLL_BOUNDED")
            }
            "NAVIGATE_BACK", "BACK" -> ActionResult(performGlobalAction(GLOBAL_ACTION_BACK), "NAVIGATE_BACK")
            else -> ActionResult(false, "ACTION_NOT_IMPLEMENTED")
        }
    }

    fun ensureTargetAppForeground(targetPackage: String): ActionResult {
        repeat(2) { attempt ->
            val root = activeRootWithRetry()
            var packageName = root?.packageName?.toString()
            if (packageName == targetPackage) return ActionResult(true, "TARGET_APP_FOREGROUND")
            if (packageName == "com.android.systemui") {
                performGlobalAction(GLOBAL_ACTION_BACK)
                SystemClock.sleep(500)
                val recovered = activeRootWithRetry()
                packageName = recovered?.packageName?.toString()
                if (packageName == targetPackage) return ActionResult(true, "TARGET_APP_FOREGROUND")
                if (packageName == "com.android.systemui") {
                    return ActionResult(false, "WAITING_FOR_PRECONDITION")
                }
            }
            if (packageName == null || packageName in RECOVERABLE_FOREGROUND_PACKAGES || packageName !in FATAL_FOREGROUND_PACKAGES) {
                val launchIntent = packageManager.getLaunchIntentForPackage(targetPackage)
                    ?: return ActionResult(false, "TARGET_APP_LAUNCH_UNAVAILABLE")
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                startActivity(launchIntent)
                val launchedRoot = waitForTargetRoot(targetPackage)
                if (launchedRoot != null) return ActionResult(true, "RECOVERABLE_FOREGROUND_CONTEXT")
            }
            if (attempt < 1) SystemClock.sleep(500)
        }
        return ActionResult(false, "WAITING_FOR_PRECONDITION")
    }

    private fun requiresKakaoForegroundRecovery(action: String): Boolean =
        action == "SELECT_KAKAO_DIRECT_CONVERSATION" ||
            action == "DRY_RUN_SELECT_KAKAO_DIRECT_CONVERSATION" ||
            action == "KAKAOTALK_PREPARE_MESSAGE" ||
            action == "KAKAOTALK_SEARCH_TO_PREPARE_MESSAGE" ||
            action == "KAKAOTALK_GOVERNED_SEND" ||
            action == "KAKAOTALK_SEARCH_TO_SEND"

    private fun activeRootWithRetry(maxAttempts: Int = 5, delayMs: Long = 200): AccessibilityNodeInfo? {
        repeat(maxAttempts) { attempt ->
            rootInActiveWindow?.let { return it }
            if (attempt < maxAttempts - 1) SystemClock.sleep(delayMs)
        }
        return null
    }

    private fun waitForTargetRoot(targetPackage: String): AccessibilityNodeInfo? {
        repeat(12) { attempt ->
            activeRootWithRetry(maxAttempts = 2, delayMs = 150)?.let { root ->
                if (root.packageName?.toString() == targetPackage) return root
            }
            if (attempt < 11) SystemClock.sleep(250)
        }
        return null
    }

    fun selectUniqueKakaoDirectConversation(expectedProviderDisplayName: String): ActionResult {
        if (interruptedByUser) return ActionResult(false, "USER_INTERRUPTED")
        val root = rootInActiveWindow ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
        val packageName = root.packageName?.toString() ?: return ActionResult(false, "UNKNOWN_PACKAGE")
        if (packageName != "com.kakao.talk") return ActionResult(false, "WAITING_FOR_PRECONDITION")

        val classifier = KakaoTalkConversationClassifier()
        val resolution = classifier.resolveDirect(root, expectedProviderDisplayName)
        Log.i(TAG, "r2g_select_enter marker=$R2G_REACQUIRE_IMPL_VERSION expected=${safeLogIdentity(expectedProviderDisplayName)} status=${resolution.status} direct=${resolution.directCandidates.size}")
        if (resolution.status == KakaoTalkConversationClassifier.Resolution.NOT_FOUND) {
            if (!isFinderSearchSurface(root)) {
                val exactActivated = activateExactVisibleIdentityButton(root, expectedProviderDisplayName)
                if (exactActivated != null) return exactActivated
            }
            return ActionResult(false, "WAITING_FOR_PRECONDITION")
        }
        if (resolution.status == KakaoTalkConversationClassifier.Resolution.AMBIGUOUS || resolution.directCandidates.size != 1) {
            return ActionResult(false, "KAKAO_DIRECT_TARGET_AMBIGUOUS")
        }

        val candidate = resolution.directCandidates.single()
        if (candidate.targetType != KakaoTalkConversationClassifier.TargetType.DIRECT) {
            return ActionResult(false, "WAITING_FOR_PRECONDITION")
        }
        if (normalizeIdentity(candidate.providerDisplayName) != normalizeIdentity(expectedProviderDisplayName)) {
            return ActionResult(false, "KAKAO_DIRECT_TARGET_NOT_FOUND")
        }
        if (candidate.reason != "NORMAL_CHATROOM_LEADING_DIRECT_IDENTITY") {
            return ActionResult(false, "KAKAO_DIRECT_TARGET_NOT_FOUND")
        }
        val triedActivationFingerprints = mutableSetOf<String>()
        repeat(2) { attempt ->
            val freshRoot = rootInActiveWindow ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
            val freshResolution = classifier.resolveDirect(freshRoot, expectedProviderDisplayName)
            Log.i(TAG, "r2g_reacquire marker=$R2G_REACQUIRE_IMPL_VERSION expected=${safeLogIdentity(expectedProviderDisplayName)} status=${freshResolution.status} direct=${freshResolution.directCandidates.size}")
            if (freshResolution.status != KakaoTalkConversationClassifier.Resolution.CANDIDATE_FOUND || freshResolution.directCandidates.size != 1) {
                return ActionResult(false, if (freshResolution.status == KakaoTalkConversationClassifier.Resolution.AMBIGUOUS) "KAKAO_DIRECT_TARGET_AMBIGUOUS" else "KAKAO_DIRECT_REACQUIRE_NOT_FOUND")
            }
            val freshCandidate = freshResolution.directCandidates.single()
            val expectedNormalized = KakaoTalkConversationClassifier.normalizeIdentity(expectedProviderDisplayName)
            if (freshCandidate.targetEvidence.normalizedIdentity != expectedNormalized) {
                return ActionResult(false, "KAKAO_DIRECT_TARGET_NOT_FOUND")
            }
            val activationNode = resolveKakaoActivationNode(freshCandidate, expectedProviderDisplayName, triedActivationFingerprints)
                ?: return ActionResult(false, "KAKAO_DIRECT_ACTIVATION_NODE_NOT_FOUND")
            if (interruptedByUser) return ActionResult(false, "USER_INTERRUPTED")
            Log.i(TAG, "r2g_click marker=$R2G_REACQUIRE_IMPL_VERSION node=${activationNode.policy.role} identity=${safeLogIdentity(freshCandidate.providerDisplayName)}")
            activationNode.node.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
            activationNode.node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            activationNode.node.performAction(AccessibilityNodeInfo.ACTION_SELECT)
            SystemClock.sleep(80)
            val clicked = activationNode.node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            triedActivationFingerprints.add(activationNode.fingerprint)
            if (!clicked) return ActionResult(false, "KAKAO_DIRECT_TARGET_CLICK_FAILED")
            val verified = waitForKakaoChatHeader(expectedProviderDisplayName)
            if (verified) return ActionResult(true, "TARGET_VERIFIED")
            rootInActiveWindow?.let {
                observeAdaptiveUi(
                    it,
                    expectedProviderDisplayName,
                    AdaptiveUiPerception.PreviousAction(
                        method = AdaptiveUiPerception.ActionMethod.ACCESSIBILITY_CLICK,
                        expectedScreenType = AdaptiveUiPerception.ScreenType.CHAT,
                        transitionExpected = true,
                        reportedSuccess = clicked,
                    ),
                )
            }
            if (attempt == 0) SystemClock.sleep(300)
        }
        return ActionResult(false, "KAKAO_DIRECT_CLICK_NO_NAVIGATION")
    }

    private fun activateExactVisibleIdentityButton(root: AccessibilityNodeInfo, expectedProviderDisplayName: String): ActionResult? {
        val expected = normalizeIdentity(expectedProviderDisplayName)
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        val matches = mutableListOf<AccessibilityNodeInfo>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val node = stack.removeFirst()
            val text = node.text?.toString().orEmpty()
            val description = node.contentDescription?.toString().orEmpty()
            if (normalizeIdentity(text) == expected || normalizeIdentity(description) == expected) {
                val clickable = firstClickableSelfOrAncestor(node)
                if (clickable.isEnabled && (clickable.isClickable || clickable.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK })) {
                    matches.add(clickable)
                }
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.add(it) }
        }
        val distinctMatches = matches.distinctBy { activationFingerprint(it, KakaoRowActivationPolicy.Role.CLASSIFIED_NODE) }
        if (distinctMatches.isEmpty()) return null
        if (distinctMatches.size > 1) return ActionResult(false, "KAKAO_DIRECT_TARGET_AMBIGUOUS")
        val node = distinctMatches.single()
        if (interruptedByUser) return ActionResult(false, "USER_INTERRUPTED")
        Log.i(TAG, "r2g_exact_visible_identity_click marker=$R2G_REACQUIRE_IMPL_VERSION expected=${safeLogIdentity(expectedProviderDisplayName)}")
        node.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS)
        node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        if (!node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return ActionResult(false, "KAKAO_DIRECT_TARGET_CLICK_FAILED")
        rootInActiveWindow?.let {
            observeAdaptiveUi(
                it,
                expectedProviderDisplayName,
                AdaptiveUiPerception.PreviousAction(
                    method = AdaptiveUiPerception.ActionMethod.ACCESSIBILITY_CLICK,
                    expectedScreenType = AdaptiveUiPerception.ScreenType.CHAT,
                    transitionExpected = true,
                    reportedSuccess = true,
                ),
            )
        }
        return if (waitForKakaoChatHeader(expectedProviderDisplayName)) {
            ActionResult(true, "TARGET_VERIFIED")
        } else {
            ActionResult(false, "R2H_IDENTITY_MISMATCH")
        }
    }

    fun dryRunSelectUniqueKakaoDirectConversation(expectedProviderDisplayName: String): ActionResult {
        val root = rootInActiveWindow ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
        val packageName = root.packageName?.toString() ?: return ActionResult(false, "UNKNOWN_PACKAGE")
        if (packageName != "com.kakao.talk") return ActionResult(false, "WAITING_FOR_PRECONDITION")
        val classifier = KakaoTalkConversationClassifier()
        val resolution = classifier.resolveDirect(root, expectedProviderDisplayName)
        Log.i(TAG, "r2g_dry_run marker=$R2G_REACQUIRE_IMPL_VERSION expected=${safeLogIdentity(expectedProviderDisplayName)} status=${resolution.status} direct=${resolution.directCandidates.size}")
        if (resolution.status != KakaoTalkConversationClassifier.Resolution.CANDIDATE_FOUND || resolution.directCandidates.size != 1) {
            return ActionResult(false, if (resolution.status == KakaoTalkConversationClassifier.Resolution.AMBIGUOUS) "KAKAO_DIRECT_TARGET_AMBIGUOUS" else "KAKAO_DIRECT_REACQUIRE_NOT_FOUND")
        }
        val candidate = resolution.directCandidates.single()
        if (candidate.targetEvidence.normalizedIdentity != KakaoTalkConversationClassifier.normalizeIdentity(expectedProviderDisplayName)) {
            return ActionResult(false, "KAKAO_DIRECT_TARGET_NOT_FOUND")
        }
        val activationNode = resolveKakaoActivationNode(candidate, expectedProviderDisplayName, emptySet())
            ?: return ActionResult(false, "KAKAO_DIRECT_ACTIVATION_NODE_NOT_FOUND")
        Log.i(TAG, "r2g_dry_run_found marker=$R2G_REACQUIRE_IMPL_VERSION node=${activationNode.policy.role} class=${activationNode.node.className} enabled=${activationNode.node.isEnabled} clickable=${activationNode.node.isClickable} fingerprint=${candidate.targetEvidence.rowFingerprint} identity=${safeLogIdentity(candidate.providerDisplayName)}")
        return ActionResult(true, "DRY_RUN_DIRECT_COUNT_1_REACQUIRE_FOUND")
    }

    private fun resolveKakaoActivationNode(
        candidate: KakaoTalkConversationClassifier.ConversationCandidate,
        expectedProviderDisplayName: String,
        alreadyTried: Set<String>,
    ): ActivationNode? {
        val classifiedNode = candidate.clickableNode ?: return null
        val rowBounds = classifiedNode.boundsInScreenRect()
        val rawCandidates = mutableListOf<ActivationNode>()
        rawCandidates.add(activationNode(classifiedNode, KakaoRowActivationPolicy.Role.CLASSIFIED_NODE, expectedProviderDisplayName, alreadyTried, candidate.evidence))

        var current = classifiedNode.parent
        while (current != null) {
            val role = when {
                current.className?.toString() == "android.webkit.WebView" -> KakaoRowActivationPolicy.Role.WEBVIEW_ROW_PROXY
                current.boundsInScreenRect() == rowBounds -> KakaoRowActivationPolicy.Role.ROW_SAME_BOUNDS
                current.boundsInScreenRect().contains(rowBounds) -> KakaoRowActivationPolicy.Role.ROW_ANCESTOR
                else -> null
            }
            if (role != null) rawCandidates.add(activationNode(current, role, expectedProviderDisplayName, alreadyTried, candidate.evidence))
            current = current.parent
        }

        val rankedPolicies = KakaoRowActivationPolicy.rank(rawCandidates.map { it.policy })
        val selected = rankedPolicies.firstOrNull() ?: return null
        return rawCandidates.firstOrNull { it.policy == selected }
    }

    private fun activationNode(
        node: AccessibilityNodeInfo,
        role: KakaoRowActivationPolicy.Role,
        expectedProviderDisplayName: String,
        alreadyTried: Set<String>,
        rowEvidence: String = "",
    ): ActivationNode {
        val fingerprint = activationFingerprint(node, role)
        val semanticText = listOf(rowEvidence, semanticSubtreeText(node))
            .filter { it.isNotBlank() }
            .joinToString(" ")
        return ActivationNode(
            node = node,
            fingerprint = fingerprint,
            policy = KakaoRowActivationPolicy.Candidate(
                role = if (isProfileOrAvatarLike(node)) KakaoRowActivationPolicy.Role.PROFILE_OR_AVATAR else role,
                hasClickAction = node.isClickable || node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK },
                semanticText = semanticText,
                expectedProviderDisplayName = expectedProviderDisplayName,
                alreadyTried = alreadyTried.contains(fingerprint),
            ),
        )
    }

    private fun activationFingerprint(node: AccessibilityNodeInfo, role: KakaoRowActivationPolicy.Role): String {
        val rect = node.boundsInScreenRect()
        return "${role.name}|${node.className}|${node.viewIdResourceName}|${rect.flattenToString()}|${semanticSelfText(node)}"
    }

    private fun semanticSubtreeText(node: AccessibilityNodeInfo): String {
        val parts = mutableListOf<String>()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(node)
        while (stack.isNotEmpty()) {
            val current = stack.removeFirst()
            val text = semanticSelfText(current)
            if (text.isNotBlank()) parts.add(text)
            for (i in 0 until current.childCount) current.getChild(i)?.let { stack.add(it) }
        }
        return parts.joinToString(" ")
    }

    private fun semanticSelfText(node: AccessibilityNodeInfo): String {
        return listOf(node.text?.toString().orEmpty(), node.contentDescription?.toString().orEmpty())
            .filter { it.isNotBlank() }
            .joinToString(" ")
    }

    private fun isProfileOrAvatarLike(node: AccessibilityNodeInfo): Boolean {
        val value = normalizeIdentity(semanticSubtreeText(node))
        return value.contains("\uD504\uB85C\uD544") || value.contains("profile") || value.contains("avatar")
    }

    private fun waitForKakaoChatHeader(expectedProviderDisplayName: String): Boolean {
        repeat(12) { attempt ->
            if (interruptedByUser) return false
            val root = rootInActiveWindow ?: return false
            val packageName = root.packageName?.toString() ?: return false
            if (packageName != "com.kakao.talk") return false
            if (!isFinderSearchSurface(root) && hasHeaderIdentity(root, expectedProviderDisplayName)) {
                return true
            }
            if (attempt < 11) SystemClock.sleep(250)
        }
        return false
    }

    private fun isFinderSearchSurface(root: AccessibilityNodeInfo): Boolean {
        var hasSearchInput = false
        var hasFinderTabs = false
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val node = stack.removeFirst()
            val text = node.text?.toString().orEmpty()
            val className = node.className?.toString().orEmpty()
            if (className == "android.widget.EditText") hasSearchInput = true
            if (text == "\uCC44\uD305\uBC29" || text == "\uCE5C\uAD6C" || text == "\uD504\uB85C\uD544" || text == "\uC624\uD508\uCC44\uD305") hasFinderTabs = true
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.add(it) }
        }
        return hasSearchInput && hasFinderTabs
    }
    private fun hasHeaderIdentity(root: AccessibilityNodeInfo, expectedProviderDisplayName: String): Boolean {
        val normalizedExpected = normalizeIdentity(expectedProviderDisplayName)
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val node = stack.removeFirst()
            val text = node.text?.toString().orEmpty()
            val description = node.contentDescription?.toString().orEmpty()
            val topEnough = node.boundsInScreenTop() <= 360
            if (topEnough && (normalizeIdentity(text) == normalizedExpected || normalizeIdentity(description) == normalizedExpected)) {
                return true
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.add(it) }
        }
        return false
    }

    private fun executeGovernedKakaoSend(expectedProviderDisplayName: String, approvedText: String, expectedMessageHash: String): ActionResult {
        val activeRoot = rootInActiveWindow ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
        if (activeRoot.packageName?.toString() != "com.kakao.talk") return ActionResult(false, "WAITING_FOR_PRECONDITION")

        val prepared = prepareKakaoMessage(expectedProviderDisplayName, approvedText, expectedMessageHash)
        if (!prepared.ok) return prepared

        val finalRoot = rootInActiveWindow ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
        if (!hasHeaderIdentity(finalRoot, expectedProviderDisplayName)) return ActionResult(false, "FINAL_TARGET_REVALIDATION_FAILED")

        val sendNode = findSendNode(finalRoot) ?: return ActionResult(false, "SEND_CONTROL_NOT_FOUND")
        if (interruptedByUser) return ActionResult(false, "USER_INTERRUPTED")
        if (!sendNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return ActionResult(false, "SEND_CLICK_FAILED")

        val verified = waitForOutboundBubbleAndClearComposer(expectedProviderDisplayName, approvedText)
        return if (verified) ActionResult(true, "SENT_VERIFIED") else ActionResult(false, "SEND_RESULT_UNVERIFIED")
    }

    private fun prepareKakaoMessage(expectedProviderDisplayName: String, approvedText: String, expectedMessageHash: String): ActionResult {
        val activeRoot = rootInActiveWindow ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
        if (activeRoot.packageName?.toString() != "com.kakao.talk") return ActionResult(false, "WAITING_FOR_PRECONDITION")

        if (!hasHeaderIdentity(activeRoot, expectedProviderDisplayName)) {
            val selected = selectUniqueKakaoDirectConversation(expectedProviderDisplayName)
            if (!selected.ok) return selected
        }

        val verifiedRoot = rootInActiveWindow ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
        if (!hasHeaderIdentity(verifiedRoot, expectedProviderDisplayName)) {
            return ActionResult(false, "R2H_IDENTITY_MISMATCH")
        }

        val input = findKakaoMessageComposer()
            ?: return ActionResult(false, "COMPOSER_NOT_FOUND")
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, approvedText)
        }
        if (!input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            return ActionResult(false, "TEXT_INPUT_NOT_ALLOWED")
        }
        SystemClock.sleep(300)

        val readback = findKakaoMessageComposer()
            ?.text?.toString().orEmpty()
        if (readback != approvedText) return ActionResult(false, "COMPOSER_TEXT_MISMATCH")
        if (messageHash(readback) != expectedMessageHash) return ActionResult(false, "COMPOSER_HASH_MISMATCH")
        return ActionResult(true, "MESSAGE_PREPARED")
    }

    private fun executeKakaoSearchToSend(searchQuery: String, expectedProviderDisplayName: String, approvedText: String, expectedMessageHash: String): ActionResult {
        val prepared = prepareKakaoSearchToMessage(searchQuery, expectedProviderDisplayName, approvedText, expectedMessageHash)
        if (!prepared.ok) return prepared
        return executeGovernedKakaoSend(expectedProviderDisplayName, approvedText, expectedMessageHash)
    }

    private fun prepareKakaoSearchToMessage(searchQuery: String, expectedProviderDisplayName: String, approvedText: String, expectedMessageHash: String): ActionResult {
        val root = rootInActiveWindow ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
        if (root.packageName?.toString() != "com.kakao.talk") return ActionResult(false, "WAITING_FOR_PRECONDITION")

        if (findKakaoFinderSearchInput() == null) {
            val searchButton = findFirst(root, NodeSelector(contentDescription = "\uAC80\uC0C9"))
                ?: findFirst(root, NodeSelector(contentDescriptionContains = "\uAC80\uC0C9"))
                ?: return ActionResult(false, "SEARCH_ENTRY_NOT_FOUND")
            val clickable = firstClickableSelfOrAncestor(searchButton)
            if (!clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return ActionResult(false, "SEARCH_ENTRY_CLICK_FAILED")
            }
            SystemClock.sleep(700)
            rootInActiveWindow?.let {
                observeAdaptiveUi(
                    it,
                    expectedProviderDisplayName,
                    AdaptiveUiPerception.PreviousAction(
                        method = AdaptiveUiPerception.ActionMethod.ACCESSIBILITY_CLICK,
                        expectedScreenType = AdaptiveUiPerception.ScreenType.SEARCH,
                        transitionExpected = true,
                        reportedSuccess = true,
                    ),
                )
            }
        }

        val searchInput = findKakaoFinderSearchInput()
            ?: return ActionResult(false, "SEARCH_INPUT_NOT_FOUND")
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, searchQuery)
        }
        if (!searchInput.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            return ActionResult(false, "SEARCH_QUERY_INPUT_FAILED")
        }
        SystemClock.sleep(900)
        rootInActiveWindow?.let {
            observeAdaptiveUi(
                it,
                expectedProviderDisplayName,
                AdaptiveUiPerception.PreviousAction(
                    method = AdaptiveUiPerception.ActionMethod.ACCESSIBILITY_SET_TEXT,
                    expectedScreenType = AdaptiveUiPerception.ScreenType.SEARCH_RESULTS,
                    transitionExpected = true,
                    reportedSuccess = true,
                ),
            )
        }

        val readback = findKakaoFinderSearchInput()?.text?.toString().orEmpty()
        if (readback != searchQuery) return ActionResult(false, "SEARCH_QUERY_MISMATCH")

        val selected = selectUniqueKakaoDirectConversation(expectedProviderDisplayName)
        if (!selected.ok) return selected
        SystemClock.sleep(900)

        val chatRoot = rootInActiveWindow ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
        if (chatRoot.packageName?.toString() != "com.kakao.talk") return ActionResult(false, "WAITING_FOR_PRECONDITION")
        if (!hasHeaderIdentity(chatRoot, expectedProviderDisplayName)) {
            return ActionResult(false, "R2H_IDENTITY_MISMATCH")
        }
        return prepareKakaoMessage(expectedProviderDisplayName, approvedText, expectedMessageHash)
    }

    private fun findSendNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        findFirst(root, NodeSelector(resourceViewId = "com.kakao.talk:id/send_button_layout"))?.let { node ->
            if (node.isEnabled && (node.isClickable || node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK })) return node
        }
        findFirst(root, NodeSelector(contentDescription = "\uC804\uC1A1"))?.let { node ->
            if (node.isEnabled && (node.isClickable || node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK })) return node
        }
        val direct = findFirst(root, NodeSelector(resourceViewId = "com.kakao.talk:id/send_layout"))
        direct?.let { node ->
            val clickable = firstClickableSelfOrAncestor(node)
            if (clickable.isEnabled) return clickable
        }
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val node = stack.removeFirst()
            val semantic = semanticSelfText(node)
            if (node.isEnabled && (node.isClickable || node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_CLICK }) && (semantic.contains("\uC804\uC1A1") || semantic.contains("\uBCF4\uB0B4\uAE30") || semantic.contains("send", ignoreCase = true))) {
                return node
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.add(it) }
        }
        return null
    }

    private fun waitForOutboundBubbleAndClearComposer(expectedProviderDisplayName: String, approvedText: String): Boolean {
        repeat(16) { attempt ->
            val root = rootInActiveWindow ?: return false
            if (root.packageName?.toString() != "com.kakao.talk") return false
            if (!hasHeaderIdentity(root, expectedProviderDisplayName)) return false
            val composerText = findKakaoMessageComposer(root)
                ?.text?.toString().orEmpty()
            val bubbleObserved = hasVisibleText(root, approvedText)
            if (composerText.isBlank() && bubbleObserved) return true
            if (attempt < 15) SystemClock.sleep(250)
        }
        return false
    }

    private fun hasVisibleText(root: AccessibilityNodeInfo, expectedText: String): Boolean {
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val node = stack.removeFirst()
            if (node.text?.toString() == expectedText || node.contentDescription?.toString() == expectedText) return true
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.add(it) }
        }
        return false
    }

    private fun findKakaoMessageComposer(): AccessibilityNodeInfo? {
        return findFirstWithRetry(NodeSelector(resourceViewId = "com.kakao.talk:id/message_edit_text", className = "android.widget.EditText"))
            ?: findFirstWithRetry(NodeSelector(resourceViewId = "com.kakao.talk:id/message_edit_text"))
    }

    private fun findKakaoMessageComposer(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        return findFirst(root, NodeSelector(resourceViewId = "com.kakao.talk:id/message_edit_text", className = "android.widget.EditText"))
            ?: findFirst(root, NodeSelector(resourceViewId = "com.kakao.talk:id/message_edit_text"))
    }

    private fun findKakaoFinderSearchInput(): AccessibilityNodeInfo? {
        return rootInActiveWindow?.let { root ->
            findFirst(root, NodeSelector(resourceViewId = "com.kakao.talk.finder:id/input_focus", className = "android.widget.EditText"))
                ?: findFirst(root, NodeSelector(className = "android.widget.EditText"))
        }
    }

    private fun messageHash(value: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        return "sha256:" + digest.joinToString("") { "%02x".format(it) }
    }

    private fun observeAdaptiveUi(
        root: AccessibilityNodeInfo,
        expectedProviderDisplayName: String?,
        previousAction: AdaptiveUiPerception.PreviousAction? = null,
    ): AdaptiveUiPerception.SemanticUiSnapshot {
        val screenCapture = attemptAuthorizedScreenCapture()
        val semanticObjects = collectKakaoSemanticObjects(root, expectedProviderDisplayName)
        val snapshot = AdaptiveUiPerception.buildSnapshot(
            packageName = root.packageName?.toString(),
            activityName = null,
            displayContext = currentDisplayContext(root),
            objects = semanticObjects,
            previous = previousUiSnapshot,
            previousAction = previousAction,
            visionUsed = screenCapture.artifactPath != null,
            screenCaptureCapability = screenCapture.capability,
            keyguardBlocked = false,
            overlayBlocked = root.packageName?.toString() == "com.android.systemui",
        )
        previousUiSnapshot = snapshot
        latestScreenCaptureCapability = screenCapture.capability
        val tempDeleted = deleteEphemeralScreenArtifact(screenCapture.artifactPath)
        Log.i(
            TAG,
            "adaptive_observe marker=$ADAPTIVE_PERCEPTION_IMPL_VERSION capture=${snapshot.screenCaptureCapability} perception=${snapshot.perceptionMode} protected=${snapshot.protectedSurfaceMode} screen=${snapshot.screenType} posture=${snapshot.displayContext.posture} orientation=${snapshot.displayContext.orientation} window=${snapshot.displayContext.windowMode} objects=${snapshot.objects.size} targets=${snapshot.candidateTargets.size} ambiguous=${snapshot.ambiguity} visionRequired=${snapshot.visionRequired} invalidates=${snapshot.invalidatesPriorPhysicalHandles} tempDeleted=$tempDeleted",
        )
        return snapshot
    }

    private data class ScreenCaptureObservation(
        val capability: AdaptiveUiPerception.ScreenCaptureCapability,
        val artifactPath: String?,
    )

    private fun attemptAuthorizedScreenCapture(): ScreenCaptureObservation {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            Log.i(TAG, "adaptive_screenshot marker=$ADAPTIVE_PERCEPTION_IMPL_VERSION capability=BLOCKED_BY_OS status=UNAVAILABLE_API")
            return ScreenCaptureObservation(AdaptiveUiPerception.ScreenCaptureCapability.BLOCKED_BY_OS, null)
        }
        val dir = File(cacheDir, "nagex-ephemeral-ui").apply { mkdirs() }
        dir.listFiles()?.forEach { file ->
            if (file.name.startsWith("current-screen-") && file.extension == "png") file.delete()
        }
        val outFile = File(dir, "current-screen-${SystemClock.elapsedRealtime()}.png")
        val latch = CountDownLatch(1)
        var artifact: String? = null
        var capability = AdaptiveUiPerception.ScreenCaptureCapability.UNKNOWN
        val executor = Executors.newSingleThreadExecutor()
        try {
            takeScreenshot(
                Display.DEFAULT_DISPLAY,
                executor,
                object : TakeScreenshotCallback {
                    override fun onSuccess(screenshot: ScreenshotResult) {
                        try {
                            val buffer: HardwareBuffer = screenshot.hardwareBuffer
                            val colorSpace: ColorSpace = screenshot.colorSpace
                            val bitmap = Bitmap.wrapHardwareBuffer(buffer, colorSpace)
                            if (bitmap != null) {
                                FileOutputStream(outFile).use { stream ->
                                bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
                                }
                                bitmap.recycle()
                                artifact = outFile.absolutePath
                                capability = AdaptiveUiPerception.ScreenCaptureCapability.AVAILABLE
                            } else {
                                capability = AdaptiveUiPerception.ScreenCaptureCapability.SECURE_SURFACE
                            }
                            buffer.close()
                        } catch (error: Exception) {
                            capability = AdaptiveUiPerception.ScreenCaptureCapability.FAILED
                            Log.w(TAG, "adaptive_screenshot marker=$ADAPTIVE_PERCEPTION_IMPL_VERSION capability=$capability status=CAPTURE_SAVE_FAILED reason=${error.javaClass.simpleName}")
                        } finally {
                            latch.countDown()
                        }
                    }

                    override fun onFailure(errorCode: Int) {
                        capability = mapScreenshotFailure(errorCode)
                        Log.i(TAG, "adaptive_screenshot marker=$ADAPTIVE_PERCEPTION_IMPL_VERSION capability=$capability status=CAPTURE_FAILED code=$errorCode")
                        latch.countDown()
                    }
                },
            )
            if (!latch.await(900, TimeUnit.MILLISECONDS) && capability == AdaptiveUiPerception.ScreenCaptureCapability.UNKNOWN) {
                capability = AdaptiveUiPerception.ScreenCaptureCapability.FAILED
            }
        } catch (error: Exception) {
            capability = AdaptiveUiPerception.ScreenCaptureCapability.FAILED
            Log.w(TAG, "adaptive_screenshot marker=$ADAPTIVE_PERCEPTION_IMPL_VERSION capability=$capability status=REQUEST_FAILED reason=${error.javaClass.simpleName}")
        } finally {
            executor.shutdown()
        }
        if (artifact == null && capability == AdaptiveUiPerception.ScreenCaptureCapability.UNKNOWN) {
            capability = AdaptiveUiPerception.ScreenCaptureCapability.FAILED
        }
        Log.i(TAG, "adaptive_screenshot marker=$ADAPTIVE_PERCEPTION_IMPL_VERSION capability=$capability status=${if (artifact != null) "CAPTURED_EPHEMERAL" else "NO_ARTIFACT"}")
        return ScreenCaptureObservation(capability, artifact)
    }

    private fun mapScreenshotFailure(errorCode: Int): AdaptiveUiPerception.ScreenCaptureCapability {
        val platformErrorCode = errorCode
        return if (platformErrorCode == Int.MIN_VALUE) {
            AdaptiveUiPerception.ScreenCaptureCapability.UNKNOWN
        } else {
            AdaptiveUiPerception.ScreenCaptureCapability.FAILED
        }
    }

    private fun deleteEphemeralScreenArtifact(path: String?): Boolean {
        if (path.isNullOrBlank()) return true
        return try {
            val file = File(path)
            !file.exists() || file.delete()
        } catch (_: Exception) {
            false
        }
    }

    private fun collectKakaoSemanticObjects(root: AccessibilityNodeInfo, expectedProviderDisplayName: String?): List<AdaptiveUiPerception.SemanticObject> {
        val objects = mutableListOf<AdaptiveUiPerception.SemanticObject>()
        if (findFirst(root, NodeSelector(contentDescription = "\uAC80\uC0C9")) != null ||
            findFirst(root, NodeSelector(contentDescriptionContains = "\uAC80\uC0C9")) != null
        ) {
            objects.add(semanticObject("kakao-search-control", AdaptiveUiPerception.ObjectKind.SEARCH_CONTROL, "\uAC80\uC0C9", clickable = true))
        }
        findFirst(root, NodeSelector(resourceViewId = "com.kakao.talk.finder:id/input_focus", className = "android.widget.EditText"))
            ?.let { objects.add(semanticObject("kakao-search-input", AdaptiveUiPerception.ObjectKind.SEARCH_INPUT, it.text?.toString().orEmpty(), editable = true)) }
        findKakaoMessageComposer(root)
            ?.let { objects.add(semanticObject("kakao-composer", AdaptiveUiPerception.ObjectKind.COMPOSER, it.text?.toString().orEmpty(), editable = true)) }
        findSendNode(root)
            ?.let { objects.add(semanticObject("kakao-send-control", AdaptiveUiPerception.ObjectKind.SEND_CONTROL, semanticSelfText(it), clickable = true)) }

        if (!expectedProviderDisplayName.isNullOrBlank()) {
            if (hasHeaderIdentity(root, expectedProviderDisplayName)) {
                objects.add(semanticObject("kakao-chat-header", AdaptiveUiPerception.ObjectKind.CHAT_HEADER, expectedProviderDisplayName, confidence = 0.98))
            }
            val resolution = KakaoTalkConversationClassifier().resolveDirect(root, expectedProviderDisplayName)
            resolution.directCandidates.forEachIndexed { index, candidate ->
                objects.add(semanticObject("kakao-direct-$index", AdaptiveUiPerception.ObjectKind.DIRECT_CONVERSATION, candidate.providerDisplayName, clickable = candidate.clickableNode != null, confidence = 0.98))
            }
            resolution.blockedCandidates.filter { it.targetType == KakaoTalkConversationClassifier.TargetType.GROUP }.forEachIndexed { index, candidate ->
                objects.add(semanticObject("kakao-group-$index", AdaptiveUiPerception.ObjectKind.GROUP_CONVERSATION, candidate.conversationTitle, clickable = candidate.clickableNode != null, confidence = 0.8))
            }
            if (isFinderSearchSurface(root) && resolution.directCandidates.isEmpty() && hasVisibleText(root, expectedProviderDisplayName.substringBefore("(").trim())) {
                objects.add(semanticObject("kakao-recent-query", AdaptiveUiPerception.ObjectKind.RECENT_QUERY, expectedProviderDisplayName, clickable = true, confidence = 0.75))
            }
        }
        return objects
    }

    private fun semanticObject(
        id: String,
        kind: AdaptiveUiPerception.ObjectKind,
        label: String,
        clickable: Boolean = false,
        editable: Boolean = false,
        confidence: Double = 0.9,
    ): AdaptiveUiPerception.SemanticObject =
        AdaptiveUiPerception.SemanticObject(
            id = id,
            kind = kind,
            label = label,
            clickable = clickable,
            editable = editable,
            confidence = confidence,
        )

    private fun currentDisplayContext(root: AccessibilityNodeInfo): AdaptiveUiPerception.DisplayContext {
        val metrics = resources.displayMetrics
        val orientation = if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE || metrics.widthPixels > metrics.heightPixels) {
            AdaptiveUiPerception.Orientation.LANDSCAPE
        } else {
            AdaptiveUiPerception.Orientation.PORTRAIT
        }
        val rootRect = root.boundsInScreenRect()
        val splitScreen = rootRect.width() in 1 until (metrics.widthPixels * 8 / 10)
        val posture = when {
            metrics.widthPixels >= 1600 -> AdaptiveUiPerception.Posture.UNFOLDED
            metrics.widthPixels >= 1000 -> AdaptiveUiPerception.Posture.TABLET
            metrics.widthPixels > 0 -> AdaptiveUiPerception.Posture.FOLDED
            else -> AdaptiveUiPerception.Posture.UNKNOWN
        }
        val windowMode = if (splitScreen) AdaptiveUiPerception.WindowMode.SPLIT_SCREEN else AdaptiveUiPerception.WindowMode.FULLSCREEN
        return AdaptiveUiPerception.DisplayContext(
            widthPx = metrics.widthPixels,
            heightPx = metrics.heightPixels,
            density = metrics.density,
            posture = posture,
            orientation = orientation,
            windowMode = windowMode,
            splitScreen = splitScreen,
        )
    }

    private fun AccessibilityNodeInfo.boundsInScreenTop(): Int {
        val rect = Rect()
        getBoundsInScreen(rect)
        return rect.top
    }

    private fun AccessibilityNodeInfo.boundsInScreenRect(): Rect {
        val rect = Rect()
        getBoundsInScreen(rect)
        return rect
    }

    fun ensureDeviceAgentRunning(): DeviceAgentHealthSnapshot =
        deviceAgentPollingOwner.ensureDeviceAgentRunning("explicit_ensure")

    fun deviceAgentHealth(): DeviceAgentHealthSnapshot =
        deviceAgentPollingOwner.snapshot()

    private fun deviceAgentPollingOwnerOrNull(): DeviceAgentPollingOwner? =
        if (::deviceAgentPollingOwner.isInitialized) deviceAgentPollingOwner else null

    private fun createDeviceAgentTransportOrNull(): DeviceAgentPollTransport? {
        val config = NagexServerConfig(this)
        val deviceId = config.deviceId ?: return null
        val tenantId = config.tenantId ?: return null
        val ownerId = config.principalId ?: return null
        val keyManager = DeviceKeyManager(this)
        val apiClient = NagexApiClient(config)
        return object : DeviceAgentPollTransport {
            override fun heartbeat(): org.json.JSONObject = apiClient.sendDeviceMessage(
                deviceId,
                tenantId,
                ownerId,
                keyManager,
                DeviceAgentPayload.heartbeat(
                    agentVersion = "0.1.0-r23.6m-phase-m4c (Android ${android.os.Build.VERSION.RELEASE})",
                    capabilityInventory = runtimeCapabilityInventory(),
                ),
            )

            override fun ack(commandId: String, stage: String, resultCode: String?) {
                apiClient.sendDeviceMessage(deviceId, tenantId, ownerId, keyManager, DeviceAgentPayload.ack(commandId, stage, resultCode))
            }
        }
    }

    private fun runtimeCapabilityInventory(): List<String> =
        listOf(
            "VOICE_CAPTURE",
            "CONTACT_READ",
            "SMS_SEND",
            "DEEP_LINK_OPEN",
            "ANDROID_ACCESSIBILITY",
            "permission:ACCESSIBILITY_SERVICE:ENABLED",
            "capabilityDiscovery:RUNTIME",
            "deviceModelRequiredForExecution:NO",
        ) + AndroidDeviceCapabilityDiscovery.discover(this, latestScreenCaptureCapability).toInventory()

    private fun findFirst(root: AccessibilityNodeInfo, selector: NodeSelector): AccessibilityNodeInfo? {
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val node = stack.removeFirst()
            if (selector.matches(node)) return node
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.add(it) }
        }
        return null
    }

    private fun findFirstWithRetry(selector: NodeSelector): AccessibilityNodeInfo? {
        repeat(6) { attempt ->
            rootInActiveWindow?.let { findFirst(it, selector)?.let { node -> return node } }
            if (attempt < 5) SystemClock.sleep(250)
        }
        return null
    }

    private fun findUniqueWithRetry(selector: NodeSelector): AccessibilityNodeInfo? {
        repeat(6) { attempt ->
            rootInActiveWindow?.let {
                val matches = findMatches(it, selector, 2)
                selector.lastMatchCount = matches.size
                if (matches.size == 1) return matches.first()
                if (matches.size > 1) return null
            }
            if (attempt < 5) SystemClock.sleep(250)
        }
        return null
    }

    private fun findMatches(root: AccessibilityNodeInfo, selector: NodeSelector, limit: Int): List<AccessibilityNodeInfo> {
        val matches = mutableListOf<AccessibilityNodeInfo>()
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(root)
        while (stack.isNotEmpty() && matches.size < limit) {
            val node = stack.removeFirst()
            if (selector.matches(node)) matches.add(node)
            for (i in 0 until node.childCount) node.getChild(i)?.let { stack.add(it) }
        }
        return matches
    }

    private fun firstClickableSelfOrAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo {
        var current: AccessibilityNodeInfo? = node
        while (current != null) {
            if (current.isClickable) return current
            current = current.parent
        }
        return node
    }

    companion object {
        @Volatile
        private var activeService: NagexAccessibilityExecutionService? = null
        private const val TAG = "NAgexAccessibility"
        const val R2G_REACQUIRE_IMPL_VERSION = "r2g-reacquire-contract-v3"
        const val ADAPTIVE_PERCEPTION_IMPL_VERSION = "adaptive-perception-first-v1"

        fun active(): NagexAccessibilityExecutionService? = activeService

        val ALLOWED_PACKAGES = setOf("com.kakao.talk")
        val RECOVERABLE_FOREGROUND_PACKAGES = setOf(
            "com.sec.android.app.launcher",
            "com.google.android.apps.nexuslauncher",
            "com.android.launcher",
            "com.android.settings",
            "com.google.android.apps.messaging",
            "com.sec.android.app.sbrowser",
            "com.android.chrome",
        )
        val FATAL_FOREGROUND_PACKAGES = emptySet<String>()
        val ALLOWED_ACTIONS = setOf(
            "FIND_ELEMENT",
            "FOCUS_INPUT",
            "CLICK_ALLOWED_NODE",
            "SELECT_KAKAO_DIRECT_CONVERSATION",
            "DRY_RUN_SELECT_KAKAO_DIRECT_CONVERSATION",
            "KAKAOTALK_PREPARE_MESSAGE",
            "KAKAOTALK_SEARCH_TO_PREPARE_MESSAGE",
            "TYPE_APPROVED_RECIPIENT_QUERY",
            "TYPE_APPROVED_TEXT",
            "SCROLL_BOUNDED",
            "NAVIGATE_BACK",
            "OBSERVE_RESULT",
            "BACK",
            "KAKAOTALK_GOVERNED_SEND",
            "KAKAOTALK_SEARCH_TO_SEND",
        )
    }

    data class NodeSelector(
        val resourceViewId: String? = null,
        val contentDescription: String? = null,
        val contentDescriptionContains: String? = null,
        val className: String? = null,
        val visibleText: String? = null,
        val visibleTextContains: String? = null,
        val ancestorResourceViewId: String? = null,
        val selected: Boolean? = null,
        val editable: Boolean? = null,
        val clickable: Boolean? = null,
        val requireSelectedAfterClick: Boolean = false,
        val requireUnique: Boolean = false,
    ) {
        @Transient
        var lastMatchCount: Int = 0

        fun matches(node: AccessibilityNodeInfo): Boolean {
            if (resourceViewId != null && node.viewIdResourceName != resourceViewId) return false
            if (contentDescription != null && node.contentDescription?.toString() != contentDescription) return false
            if (contentDescriptionContains != null && node.contentDescription?.toString()?.contains(contentDescriptionContains) != true) return false
            if (className != null && node.className?.toString() != className) return false
            if (visibleText != null && node.text?.toString() != visibleText) return false
            if (visibleTextContains != null && node.text?.toString()?.contains(visibleTextContains) != true) return false
            if (ancestorResourceViewId != null && !hasAncestorResource(node, ancestorResourceViewId)) return false
            if (selected != null && node.isSelected != selected) return false
            if (editable != null && node.isEditable != editable) return false
            if (clickable != null && !matchesClickability(node, clickable)) return false
            return true
        }

        private fun matchesClickability(node: AccessibilityNodeInfo, expected: Boolean): Boolean {
            if (!expected) return !node.isClickable
            var current: AccessibilityNodeInfo? = node
            while (current != null) {
                if (current.isClickable) return true
                current = current.parent
            }
            return false
        }

        private fun hasAncestorResource(node: AccessibilityNodeInfo, resourceViewId: String): Boolean {
            var parent = node.parent
            while (parent != null) {
                if (parent.viewIdResourceName == resourceViewId) return true
                parent = parent.parent
            }
            return false
        }
    }

    private fun normalizeIdentity(value: String): String {
        return KakaoTalkConversationClassifier.normalizeIdentity(value)
    }

    private fun safeLogIdentity(value: String): String {
        val normalized = normalizeIdentity(value)
        return "${normalized.take(64)}#${normalized.hashCode().toUInt().toString(16)}"
    }

    data class ActionResult(val ok: Boolean, val reasonCode: String)

    private data class ActivationNode(
        val node: AccessibilityNodeInfo,
        val fingerprint: String,
        val policy: KakaoRowActivationPolicy.Candidate,
    )
}
