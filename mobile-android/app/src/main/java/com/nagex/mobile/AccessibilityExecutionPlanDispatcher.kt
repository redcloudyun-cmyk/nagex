package com.nagex.mobile

import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant

class AccessibilityExecutionPlanDispatcher(private val context: Context, private val config: NagexServerConfig) {

    fun dispatch(command: JSONObject): DispatchResult {
        val plan = command.optJSONObject("data") ?: return DispatchResult.rejected(null, null, "MALFORMED_PLAN")
        val commandId = command.optString("commandId", plan.optString("commandId", null))
        val planId = plan.optString("planId", null)
        if (command.optString("commandType") != "ACCESSIBILITY_EXECUTE_PLAN") return DispatchResult.rejected(commandId, planId, "UNKNOWN_COMMAND")
        if (command.optString("deviceId") != config.deviceId || plan.optString("deviceId") != config.deviceId) return DispatchResult.rejected(commandId, planId, "WRONG_DEVICE")
        if (command.optString("tenantId") != config.tenantId || plan.optString("tenantId") != config.tenantId) return DispatchResult.rejected(commandId, planId, "WRONG_TENANT")
        if (command.optString("ownerId") != config.principalId || plan.optString("principalId") != config.principalId) return DispatchResult.rejected(commandId, planId, "WRONG_USER")
        if (plan.optString("targetPackage") != "com.kakao.talk" || plan.optString("packageName") != "com.kakao.talk") return DispatchResult.rejected(commandId, planId, "PACKAGE_NOT_ALLOWLISTED")
        if (isExpired(command.optString("queuedAt", null), plan.optLong("timeoutMs", 120_000L))) return DispatchResult.rejected(commandId, planId, "COMMAND_EXPIRED")
        if (wasSeen(commandId)) return DispatchResult.rejected(commandId, planId, "REPLAY_REJECTED")

        val service = NagexAccessibilityExecutionService.active() ?: return DispatchResult.blocked(commandId, planId, "ACCESSIBILITY_UNAVAILABLE")
        if (DeviceEnrollmentManager.accessibilityState(context) != "ENABLED") return DispatchResult.blocked(commandId, planId, "ACCESSIBILITY_UNAVAILABLE")

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
        return context.getSharedPreferences("nagex_accessibility_plan_replay", Context.MODE_PRIVATE).getBoolean(commandId, false)
    }

    private fun markSeen(commandId: String?) {
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
        private val FORBIDDEN_ACTIONS = setOf("PRESS_SEND", "SEND_MESSAGE", "CLICK_SEND")
    }
}
