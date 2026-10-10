package com.nagex.mobile

object KakaoRowActivationPolicy {
    enum class Role { CLASSIFIED_NODE, ROW_SAME_BOUNDS, ROW_ANCESTOR, WEBVIEW_ROW_PROXY, PROFILE_OR_AVATAR }

    data class Candidate(
        val role: Role,
        val hasClickAction: Boolean,
        val semanticText: String,
        val expectedProviderDisplayName: String,
        val alreadyTried: Boolean = false,
    )

    fun isAuthorized(candidate: Candidate): Boolean {
        if (candidate.alreadyTried) return false
        if (!candidate.hasClickAction) return false
        if (candidate.role == Role.PROFILE_OR_AVATAR) return false
        return containsDirectIdentitySegment(candidate.semanticText, candidate.expectedProviderDisplayName)
    }

    fun rank(candidates: List<Candidate>): List<Candidate> {
        return candidates
            .filter { isAuthorized(it) }
            .sortedWith(compareBy<Candidate> { priority(it.role) }.thenBy { it.semanticText.length })
    }

    private fun priority(role: Role): Int {
        return when (role) {
            Role.CLASSIFIED_NODE -> 0
            Role.ROW_SAME_BOUNDS -> 1
            Role.ROW_ANCESTOR -> 2
            Role.WEBVIEW_ROW_PROXY -> 3
            Role.PROFILE_OR_AVATAR -> 99
        }
    }

    private fun containsDirectIdentitySegment(value: String, expectedProviderDisplayName: String): Boolean {
        val normalizedText = normalize(value)
        val normalizedExpected = normalize(expectedProviderDisplayName)
        if (normalizedExpected.isBlank()) return false
        var index = normalizedText.indexOf(normalizedExpected)
        while (index >= 0) {
            val startsAtBoundary = index == 0 || normalizedText[index - 1].isWhitespace() || normalizedText[index - 1] in IDENTITY_PREFIX_BOUNDARIES
            val endsAtBoundary = hasIdentityBoundaryAfter(normalizedText, index + normalizedExpected.length)
            if (startsAtBoundary && endsAtBoundary) return true
            index = normalizedText.indexOf(normalizedExpected, index + 1)
        }
        return false
    }

    private fun hasIdentityBoundaryAfter(value: String, endIndex: Int): Boolean {
        if (value.length == endIndex) return true
        val next = value[endIndex]
        return next.isWhitespace() || next in IDENTITY_SUFFIX_BOUNDARIES
    }

    private fun normalize(value: String): String {
        return KakaoTalkConversationClassifier.normalizeIdentity(value)
    }

    private val IDENTITY_PREFIX_BOUNDARIES = setOf('|', ':', '-', ',', '/', '(', '[', '{')
    private val IDENTITY_SUFFIX_BOUNDARIES = setOf(',', '-', ':', '(', '[', '{')
}
