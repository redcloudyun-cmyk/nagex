package com.nagex.mobile

import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant

/**
 * Validates and dispatches ACCESSIBILITY_EXECUTE_PLAN commands. Two plan shapes reach the device and both pass through the same gate:
 *
 *  - the governed KakaoTalk direct-conversation plan (one KAKAOTALK_* / SELECT_KAKAO_DIRECT_CONVERSATION step, bound to the approved conversation, provider
 *    display name and message hash); and
 *  - the semantic M4C plan (OPEN_APP, SEARCH / SELECT / VERIFY recipient, FOCUS_INPUT, TYPE_APPROVED_TEXT, OBSERVE_RESULT ...) which only ever PREPARES a draft:
 *    PRESS_SEND / SEND_MESSAGE / CLICK_SEND are refused outright and text is typed only after the recipient was verified in the same plan.
 *
 * Before either shape runs, a dispatcher that knows this device's enrollment (context + config) refuses a command that is not addressed to this device, tenant
 * and user. The semantic plan is additionally refused when it has expired or was already seen (replay), when accessibility is not enabled, when the foreground
 * package is not the allow-listed one, when the approved text does not match its hash, and when it exceeds its step budget.
 */
class AccessibilityExecutionPlanDispatcher(
    private val context: Context? = null,
    private val config: NagexServerConfig? = null,
) : DeviceAgentCommandDispatcher {

    override fun dispatch(command: JSONObject): NagexAccessibilityExecutionService.ActionResult {
        if (command.optString("commandType") != "ACCESSIBILITY_EXECUTE_PLAN") {
            return NagexAccessibilityExecutionService.ActionResult(false, "UNKNOWN_COMMAND")
        }
        val data = command.optJSONObject("data") ?: return NagexAccessibilityExecutionService.ActionResult(false, "MALFORMED_PLAN")
        addressingRejection(command)?.let { return NagexAccessibilityExecutionService.ActionResult(false, it) }
        return if (isGovernedKakaoDirectPlan(data)) dispatchGovernedKakaoDirect(data) else dispatchSemanticPlan(command).toActionResult()
    }

    fun dryRunSelectKakaoDirectConversation(expectedProviderDisplayName: String): NagexAccessibilityExecutionService.ActionResult {
        val service = NagexAccessibilityExecutionService.active()
            ?: return NagexAccessibilityExecutionService.ActionResult(false, "ACCESSIBILITY_UNAVAILABLE")
        return service.executeBoundedAction(
            action = "DRY_RUN_SELECT_KAKAO_DIRECT_CONVERSATION",
            target = NagexAccessibilityExecutionService.NodeSelector(),
            expectedProviderDisplayName = expectedProviderDisplayName,
        )
    }

    // ── addressing: the command must be for THIS enrolled device, tenant and user ───────────────────────────────────────────────────────────────────────────────
    private fun addressingRejection(command: JSONObject): String? {
        val config = config ?: return null
        if (command.optString("deviceId") != config.deviceId) return "WRONG_DEVICE"
        if (command.optString("tenantId") != config.tenantId) return "WRONG_TENANT"
        if (command.optString("ownerId") != config.principalId) return "WRONG_USER"
        return null
    }

    // ── governed KakaoTalk direct-conversation plans ─────────────────────────────────────────────────────────────────────────────────────────────────────────
    private fun isGovernedKakaoDirectPlan(data: JSONObject): Boolean {
        val steps = data.optJSONArray("steps") ?: return false
        if (steps.length() != 1) return false
        val action = steps.optJSONObject(0)?.optString("action") ?: return false
        return GOVERNED_KAKAO_ACTIONS.contains(action)
    }

    private fun dispatchGovernedKakaoDirect(data: JSONObject): NagexAccessibilityExecutionService.ActionResult {
        val expectedProviderDisplayName = data.optString("expectedProviderDisplayName", "")
        val conversationRef = data.optString("conversationRef", "")
        val message = data.optString("message", "")
        val messageHash = data.optString("messageHash", "")
        val searchQuery = data.optString("searchQuery", "")
        val steps = data.optJSONArray("steps") ?: return NagexAccessibilityExecutionService.ActionResult(false, "MALFORMED_PLAN")
        if (data.optString("targetPackage", data.optString("packageName")) != "com.kakao.talk") {
            return NagexAccessibilityExecutionService.ActionResult(false, "PACKAGE_NOT_ALLOWLISTED")
        }
        if (steps.length() != 1) return NagexAccessibilityExecutionService.ActionResult(false, "EXECUTION_BUDGET_EXCEEDED")
        val step = steps.optJSONObject(0) ?: return NagexAccessibilityExecutionService.ActionResult(false, "MALFORMED_STEP")
        val stepAction = step.optString("action")
        if (stepAction != "SELECT_KAKAO_DIRECT_CONVERSATION" && stepAction != "DRY_RUN_SELECT_KAKAO_DIRECT_CONVERSATION" && stepAction != "KAKAOTALK_PREPARE_MESSAGE" && stepAction != "KAKAOTALK_SEARCH_TO_PREPARE_MESSAGE" && stepAction != "KAKAOTALK_GOVERNED_SEND" && stepAction != "KAKAOTALK_SEARCH_TO_SEND") {
            return NagexAccessibilityExecutionService.ActionResult(false, "ACTION_NOT_ALLOWLISTED")
        }
        val stepExpected = step.optString("expectedProviderDisplayName", expectedProviderDisplayName)
        val stepConversationRef = step.optString("conversationRef", conversationRef)
        if (stepExpected != expectedProviderDisplayName || expectedProviderDisplayName.isBlank()) {
            return NagexAccessibilityExecutionService.ActionResult(false, "KAKAO_DIRECT_TARGET_IDENTITY_REQUIRED")
        }
        if (stepConversationRef != conversationRef || conversationRef.isBlank() || !conversationRef.startsWith("cvr_")) {
            return NagexAccessibilityExecutionService.ActionResult(false, "KAKAO_CONVERSATION_REF_REQUIRED")
        }
        val service = NagexAccessibilityExecutionService.active()
            ?: return NagexAccessibilityExecutionService.ActionResult(false, "ACCESSIBILITY_UNAVAILABLE")
        if (stepAction == "KAKAOTALK_PREPARE_MESSAGE" || stepAction == "KAKAOTALK_SEARCH_TO_PREPARE_MESSAGE" || stepAction == "KAKAOTALK_GOVERNED_SEND" || stepAction == "KAKAOTALK_SEARCH_TO_SEND") {
            if (message.isBlank() || messageHash.isBlank()) {
                return NagexAccessibilityExecutionService.ActionResult(false, "KAKAO_SEND_MESSAGE_REQUIRED")
            }
            if ((stepAction == "KAKAOTALK_SEARCH_TO_PREPARE_MESSAGE" || stepAction == "KAKAOTALK_SEARCH_TO_SEND") && searchQuery.isBlank()) {
                return NagexAccessibilityExecutionService.ActionResult(false, "KAKAO_SEARCH_QUERY_REQUIRED")
            }
            return service.executeBoundedAction(
                action = stepAction,
                target = NagexAccessibilityExecutionService.NodeSelector(),
                approvedText = message,
                expectedProviderDisplayName = expectedProviderDisplayName,
                expectedMessageHash = messageHash,
                searchQuery = searchQuery,
            )
        }
        return service.executeBoundedAction(
            action = stepAction,
            target = NagexAccessibilityExecutionService.NodeSelector(),
            expectedProviderDisplayName = expectedProviderDisplayName,
        )
    }

    // ── semantic M4C plans: draft preparation only ───────────────────────────────────────────────────────────────────────────────────────────────────────────
    fun dispatchSemanticPlan(command: JSONObject): DispatchResult {
        val plan = command.optJSONObject("data") ?: return DispatchResult.rejected(null, null, "MALFORMED_PLAN")
        val commandId = command.optString("commandId", plan.optString("commandId", null))
        val planId = plan.optString("planId", null)
        if (command.optString("commandType") != "ACCESSIBILITY_EXECUTE_PLAN") return DispatchResult.rejected(commandId, planId, "UNKNOWN_COMMAND")
        val config = config
        if (config != null) {
            if (command.optString("deviceId") != config.deviceId || plan.optString("deviceId") != config.deviceId) return DispatchResult.rejected(commandId, planId, "WRONG_DEVICE")
            if (command.optString("tenantId") != config.tenantId || plan.optString("tenantId") != config.tenantId) return DispatchResult.rejected(commandId, planId, "WRONG_TENANT")
            if (command.optString("ownerId") != config.principalId || plan.optString("principalId") != config.principalId) return DispatchResult.rejected(commandId, planId, "WRONG_USER")
        }
        if (plan.optString("targetPackage") != "com.kakao.talk" || plan.optString("packageName") != "com.kakao.talk") return DispatchResult.rejected(commandId, planId, "PACKAGE_NOT_ALLOWLISTED")
        if (isExpired(command.optString("queuedAt", null), plan.optLong("timeoutMs", 120_000L))) return DispatchResult.rejected(commandId, planId, "COMMAND_EXPIRED")
        if (wasSeen(commandId)) return DispatchResult.rejected(commandId, planId, "REPLAY_REJECTED")

        val service = NagexAccessibilityExecutionService.active() ?: return DispatchResult.blocked(commandId, planId, "ACCESSIBILITY_UNAVAILABLE")
        if (context != null && DeviceEnrollmentManager.accessibilityState(context) != "ENABLED") return DispatchResult.blocked(commandId, planId, "ACCESSIBILITY_UNAVAILABLE")

        val approvedText = plan.optString("approvedText", null)
        if (!approvedText.isNullOrEmpty() && sha256Hex(approvedText) != plan.optString("approvedPayloadHash")) {
            markSeen(commandId)
            return DispatchResult.blocked(commandId, planId, "PAYLOAD_HASH_MISMATCH")
        }

        val budget = plan.optJSONObject("budget") ?: JSONObject()
        val maxSteps = budget.optInt("maxSteps", 10).coerceAtMost(10)
        val steps = plan.optJSONArray("steps") ?: return DispatchResult.rejected(commandId, planId, "MALFORMED_PLAN")
        if (steps.length() > maxSteps) return DispatchResult.blocked(commandId, planId, "EXECUTION_BUDGET_EXCEEDED")

        var recipientVerified = false
        var textInputs = 0
        markSeen(commandId)

        for (i in 0 until steps.length()) {
            if (service.isInterruptedByUser()) return DispatchResult.blocked(commandId, planId, "USER_INTERRUPTED", i)
            val step = steps.optJSONObject(i) ?: return DispatchResult.failed(commandId, planId, "MALFORMED_STEP", i)
            val action = step.optString("action")
            if (FORBIDDEN_ACTIONS.contains(action)) return DispatchResult.blocked(commandId, planId, "BLOCKED_ACTION_NOT_ALLOWED", i)

            when (action) {
                "OPEN_APP" -> {
                    openTargetApp(plan.optString("targetPackage"))
                }
                "VERIFY_RECIPIENT" -> {
                    val result = service.executeBoundedAction("FIND_ELEMENT", selector(step, plan.optString("displayName")))
                    if (!result.ok) return DispatchResult.blocked(commandId, planId, "RECIPIENT_UNVERIFIED", i)
                    recipientVerified = true
                }
                "SELECT_RECIPIENT" -> {
                    val result = service.executeBoundedAction("CLICK_ALLOWED_NODE", selector(step, plan.optString("displayName")))
                    if (!result.ok) return DispatchResult.failed(commandId, planId, result.reasonCode, i)
                }
                "TYPE_APPROVED_TEXT" -> {
                    if (!recipientVerified) return DispatchResult.blocked(commandId, planId, "OUT_OF_ORDER_STEP", i)
                    if (textInputs >= budget.optInt("maxTextInputs", 1)) return DispatchResult.blocked(commandId, planId, "EXECUTION_BUDGET_EXCEEDED", i)
                    val result = service.executeBoundedAction("TYPE_APPROVED_TEXT", selector(step, plan.optString("displayName")), approvedText)
                    if (!result.ok) return DispatchResult.failed(commandId, planId, result.reasonCode, i)
                    textInputs += 1
                }
                "TYPE_APPROVED_RECIPIENT_QUERY" -> {
                    val result = service.executeBoundedAction("TYPE_APPROVED_RECIPIENT_QUERY", selector(step, plan.optString("displayName")), plan.optString("displayName"))
                    if (!result.ok) return DispatchResult.failed(commandId, planId, result.reasonCode, i)
                }
                "FIND_ELEMENT", "FOCUS_INPUT", "CLICK_ALLOWED_NODE", "OBSERVE_RESULT", "SCROLL_BOUNDED", "NAVIGATE_BACK" -> {
                    val result = service.executeBoundedAction(action, selector(step, plan.optString("displayName")))
                    if (!result.ok) return DispatchResult.failed(commandId, planId, result.reasonCode, i)
                }
                else -> return DispatchResult.blocked(commandId, planId, "UNKNOWN_ACTION", i)
            }

            val observed = service.currentPackageName()
            if (observed != null && observed != "com.kakao.talk") return DispatchResult.blocked(commandId, planId, "PACKAGE_MISMATCH", i)
        }

        return DispatchResult(commandId, planId, "DRAFT_PREPARED", "DRAFT_PREPARED", steps.length() - 1, "MEDIUM", "com.kakao.talk", plan.optString("targetAppVersion", null))
    }

    private fun selector(step: JSONObject, fallbackLabel: String): NagexAccessibilityExecutionService.NodeSelector {
        val hints = step.optJSONObject("selectorHints") ?: JSONObject()
        return NagexAccessibilityExecutionService.NodeSelector(
            resourceViewId = hints.optString("resourceId", null),
            contentDescription = hints.optString("contentDescription", null),
            contentDescriptionContains = hints.optString("contentDescriptionContains", null),
            className = hints.optString("className", null),
            visibleText = hints.optString("expectedVisibleLabel", null) ?: if (step.optString("action") == "VERIFY_RECIPIENT" || step.optString("action") == "SELECT_RECIPIENT") fallbackLabel else null,
            visibleTextContains = hints.optString("visibleTextContains", null),
            ancestorResourceViewId = hints.optString("ancestorResourceId", null),
            selected = if (hints.has("selected")) hints.optBoolean("selected") else null,
            editable = if (step.optString("action") == "FOCUS_INPUT" || step.optString("action") == "TYPE_APPROVED_TEXT" || step.optString("action") == "TYPE_APPROVED_RECIPIENT_QUERY") true else null,
            clickable = if (step.optString("action") == "SELECT_RECIPIENT" || step.optString("action") == "CLICK_ALLOWED_NODE") true else null,
            requireSelectedAfterClick = hints.optBoolean("requireSelectedAfterClick", false),
        )
    }

    private fun openTargetApp(packageName: String) {
        val context = context ?: return
        val intent = context.packageManager.getLaunchIntentForPackage(packageName) ?: return
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    private fun isExpired(queuedAt: String?, ttlMs: Long): Boolean {
        if (queuedAt.isNullOrBlank()) return true
        return try {
            Instant.parse(queuedAt).plusMillis(ttlMs).isBefore(Instant.now())
        } catch (_: Exception) {
            true
        }
    }

    private fun wasSeen(commandId: String?): Boolean {
        if (commandId.isNullOrBlank()) return true
        val context = context ?: return false
        return context.getSharedPreferences("nagex_accessibility_plan_replay", Context.MODE_PRIVATE).getBoolean(commandId, false)
    }

    private fun markSeen(commandId: String?) {
        val context = context ?: return
        if (!commandId.isNullOrBlank()) {
            context.getSharedPreferences("nagex_accessibility_plan_replay", Context.MODE_PRIVATE).edit().putBoolean(commandId, true).apply()
        }
    }

    private fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    data class DispatchResult(
        val commandId: String?,
        val planId: String?,
        val status: String,
        val reasonCode: String,
        val stepIndex: Int? = null,
        val confirmationStrength: String = "NONE",
        val observedApp: String? = null,
        val observedVersion: String? = null,
    ) {
        // A prepared draft is the only success a semantic plan can report; rejected / blocked / failed are never presented as done.
        fun toActionResult() = NagexAccessibilityExecutionService.ActionResult(status == "DRAFT_PREPARED", reasonCode)

        fun toJson(): JSONObject {
            val json = JSONObject()
                .put("commandId", commandId)
                .put("planId", planId)
                .put("status", status)
                .put("reasonCode", reasonCode)
                .put("confirmationStrength", confirmationStrength)
                .put("timestamp", Instant.now().toString())
            if (stepIndex != null) json.put("stepIndex", stepIndex)
            if (observedApp != null) json.put("observedApp", observedApp)
            if (observedVersion != null) json.put("observedVersion", observedVersion)
            return json
        }

        companion object {
            fun rejected(commandId: String?, planId: String?, reason: String, step: Int? = null) = DispatchResult(commandId, planId, "REJECTED", reason, step)
            fun blocked(commandId: String?, planId: String?, reason: String, step: Int? = null) = DispatchResult(commandId, planId, "BLOCKED", reason, step)
            fun failed(commandId: String?, planId: String?, reason: String, step: Int? = null) = DispatchResult(commandId, planId, "FAILED", reason, step)
        }
    }

    companion object {
        // The generic send actions are never executable through a semantic plan (the governed KakaoTalk send is a distinct, approval-bound plan shape).
        private val FORBIDDEN_ACTIONS = setOf("PRESS_SEND", "SEND_MESSAGE", "CLICK_SEND")
        private val GOVERNED_KAKAO_ACTIONS = setOf(
            "SELECT_KAKAO_DIRECT_CONVERSATION",
            "DRY_RUN_SELECT_KAKAO_DIRECT_CONVERSATION",
            "KAKAOTALK_PREPARE_MESSAGE",
            "KAKAOTALK_SEARCH_TO_PREPARE_MESSAGE",
            "KAKAOTALK_GOVERNED_SEND",
            "KAKAOTALK_SEARCH_TO_SEND",
        )
    }
}
