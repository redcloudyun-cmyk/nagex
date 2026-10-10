package com.nagex.mobile

object SpokenNameExtractor {
    private val KOREAN_RECIPIENT_MARKERS = listOf("\uC5D0\uAC8C", "\uD55C\uD14C", "\uAED8")
    private val KOREAN_COMMAND_MARKERS = listOf("\uC804\uD654", "\uAC78\uC5B4", "\uBB38\uC790", "\uBCF4\uB0B4")
    private val ENGLISH_LEAD_INS = listOf("tell ", "message ", "text ", "call ")

    fun extract(utterance: String): String {
        val trimmed = utterance.trim()
        if (trimmed.isEmpty()) return ""

        val wake = WakePhraseMatcher.match(trimmed)
        val withoutWake = if (wake.decision == WakePhraseMatcher.Decision.ACCEPT) wake.remainder else trimmed

        for (marker in KOREAN_RECIPIENT_MARKERS) {
            val index = withoutWake.indexOf(marker)
            if (index > 0) return withoutWake.substring(0, index).trim()
        }

        for (marker in KOREAN_COMMAND_MARKERS) {
            val index = withoutWake.indexOf(marker)
            if (index > 0) return withoutWake.substring(0, index).trim()
        }

        val lower = withoutWake.lowercase()
        for (leadIn in ENGLISH_LEAD_INS) {
            if (lower.startsWith(leadIn)) {
                val rest = withoutWake.substring(leadIn.length).trim()
                val stopWords = listOf(" that", " i'm", " i am", " to say")
                var end = rest.length
                for (stop in stopWords) {
                    val idx = rest.lowercase().indexOf(stop)
                    if (idx in 0 until end) end = idx
                }
                return rest.substring(0, end).trim()
            }
        }

        return withoutWake.trim()
    }
}
