package com.nagex.mobile

import org.json.JSONObject

class AccessibilityExecutionPlanDispatcher : DeviceAgentCommandDispatcher {
    override fun dispatch(command: JSONObject): NagexAccessibilityExecutionService.ActionResult {
        if (command.optString("commandType") != "ACCESSIBILITY_EXECUTE_PLAN") {
            return NagexAccessibilityExecutionService.ActionResult(false, "UNKNOWN_COMMAND")
        }
        val data = command.optJSONObject("data") ?: return NagexAccessibilityExecutionService.ActionResult(false, "MALFORMED_PLAN")
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

    fun dryRunSelectKakaoDirectConversation(expectedProviderDisplayName: String): NagexAccessibilityExecutionService.ActionResult {
        val service = NagexAccessibilityExecutionService.active()
            ?: return NagexAccessibilityExecutionService.ActionResult(false, "ACCESSIBILITY_UNAVAILABLE")
        return service.executeBoundedAction(
            action = "DRY_RUN_SELECT_KAKAO_DIRECT_CONVERSATION",
            target = NagexAccessibilityExecutionService.NodeSelector(),
            expectedProviderDisplayName = expectedProviderDisplayName,
        )
    }
}
