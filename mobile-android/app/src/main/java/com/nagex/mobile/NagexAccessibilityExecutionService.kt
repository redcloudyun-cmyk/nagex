package com.nagex.mobile

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * M4 constrained accessibility plane.
 *
 * Android, not NAgex, controls whether this service is enabled. The service
 * does not self-enable and does not accept free-form clicks or text.
 * Server-issued plans must already be app,
 * action, recipient, message, device, route, and approval bound before the
 * Android client may execute them.
 */
class NagexAccessibilityExecutionService : AccessibilityService() {
    @Volatile
    private var interruptedByUser = false

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        val packageName = event?.packageName?.toString() ?: return
        if (!ALLOWED_PACKAGES.contains(packageName)) return
        if (event.eventType == AccessibilityEvent.TYPE_TOUCH_INTERACTION_START) {
            interruptedByUser = true
        }
    }

    override fun onInterrupt() {
        interruptedByUser = true
    }

    fun isInterruptedByUser(): Boolean = interruptedByUser

    fun executeBoundedAction(action: String, target: NodeSelector, approvedText: String? = null): ActionResult {
        if (interruptedByUser) return ActionResult(false, "USER_INTERRUPTED")
        if (!ALLOWED_ACTIONS.contains(action)) return ActionResult(false, "ACTION_NOT_ALLOWLISTED")
        if (action == "PRESS_SEND" || action == "REQUEST_SEND_APPROVAL") return ActionResult(false, "SEND_ACTION_DISABLED_IN_M4C_R1")

        val root = rootInActiveWindow ?: return ActionResult(false, "NO_ACTIVE_WINDOW")
        val packageName = root.packageName?.toString() ?: return ActionResult(false, "UNKNOWN_PACKAGE")
        if (!ALLOWED_PACKAGES.contains(packageName)) return ActionResult(false, "PACKAGE_NOT_ALLOWLISTED")

        return when (action) {
            "FIND_ELEMENT", "OBSERVE_RESULT" -> {
                val node = findFirst(root, target)
                ActionResult(node != null, if (node != null) "FOUND" else "NODE_NOT_FOUND")
            }
            "FOCUS_INPUT", "CLICK_ALLOWED_NODE" -> {
                val node = findFirst(root, target) ?: return ActionResult(false, "NODE_NOT_FOUND")
                val accessibilityAction = if (action == "FOCUS_INPUT") AccessibilityNodeInfo.ACTION_FOCUS else AccessibilityNodeInfo.ACTION_CLICK
                ActionResult(node.performAction(accessibilityAction), action)
            }
            "TYPE_APPROVED_TEXT" -> {
                val node = findFirst(root, target) ?: return ActionResult(false, "NODE_NOT_FOUND")
                if (!node.isEditable || approvedText == null) return ActionResult(false, "TEXT_INPUT_NOT_ALLOWED")
                val args = Bundle().apply {
                    putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, approvedText)
                }
                ActionResult(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args), "TYPE_APPROVED_TEXT")
            }
            "SCROLL_BOUNDED" -> {
                val node = findFirst(root, target) ?: return ActionResult(false, "NODE_NOT_FOUND")
                ActionResult(node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD), "SCROLL_BOUNDED")
            }
            "NAVIGATE_BACK", "BACK" -> ActionResult(performGlobalAction(GLOBAL_ACTION_BACK), "NAVIGATE_BACK")
            else -> ActionResult(false, "ACTION_NOT_IMPLEMENTED")
        }
    }

    private fun findFirst(root: AccessibilityNodeInfo, selector: NodeSelector): AccessibilityNodeInfo? {
        val stack = ArrayDeque<AccessibilityNodeInfo>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val node = stack.removeFirst()
            if (selector.matches(node)) return node
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { stack.add(it) }
            }
        }
        return null
    }

    companion object {
        val ALLOWED_PACKAGES = setOf("com.kakao.talk")
        val ALLOWED_ACTIONS = setOf(
            "FIND_ELEMENT",
            "FOCUS_INPUT",
            "CLICK_ALLOWED_NODE",
            "TYPE_APPROVED_TEXT",
            "SCROLL_BOUNDED",
            "NAVIGATE_BACK",
            "OBSERVE_RESULT",
            "BACK",
        )
    }

    data class NodeSelector(
        val resourceViewId: String? = null,
        val contentDescription: String? = null,
        val className: String? = null,
        val visibleText: String? = null,
        val editable: Boolean? = null,
        val clickable: Boolean? = null,
    ) {
        fun matches(node: AccessibilityNodeInfo): Boolean {
            if (resourceViewId != null && node.viewIdResourceName != resourceViewId) return false
            if (contentDescription != null && node.contentDescription?.toString() != contentDescription) return false
            if (className != null && node.className?.toString() != className) return false
            if (visibleText != null && node.text?.toString() != visibleText) return false
            if (editable != null && node.isEditable != editable) return false
            if (clickable != null && node.isClickable != clickable) return false
            return true
        }
    }

    data class ActionResult(val ok: Boolean, val reasonCode: String)
}
