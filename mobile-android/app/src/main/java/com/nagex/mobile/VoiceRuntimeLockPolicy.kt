package com.nagex.mobile

enum class VoiceContentSensitivity {
    LOW,
    SENSITIVE,
}

data class VoiceRuntimePolicyInput(
    val deviceLocked: Boolean,
    val contentSensitivity: VoiceContentSensitivity,
)

object VoiceRuntimeLockPolicy {
    fun canSpeak(input: VoiceRuntimePolicyInput): Boolean {
        return !input.deviceLocked || input.contentSensitivity == VoiceContentSensitivity.LOW
    }
}
