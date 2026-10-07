package com.nagex.mobile

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent

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

    companion object {
        val ALLOWED_PACKAGES = setOf("com.kakao.talk")
        val ALLOWED_ACTIONS = setOf(
            "OPEN_APP",
            "OPEN_CHAT",
            "SEARCH_CONTACT",
            "SELECT_CONTACT",
            "FOCUS_MESSAGE_BOX",
            "TYPE_MESSAGE",
            "REQUEST_SEND_APPROVAL",
            "PRESS_SEND",
            "OBSERVE_RESULT",
            "BACK",
        )
    }
}
