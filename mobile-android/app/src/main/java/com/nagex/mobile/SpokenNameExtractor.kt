package com.nagex.mobile

/**
 * R23.6M Phase B2 — a deliberately minimal, deterministic heuristic for
 * pulling a recipient name out of a full spoken utterance, e.g.
 * "김대진 대표에게 전화해줘" -> "김대진 대표". This is NOT real intent
 * parsing/NLU — it exists only so Phase B's foundation loop (voice ->
 * contact candidate lookup -> spoken result) has something to send as
 * `spokenName`. It makes no send/approval/policy decision of any kind,
 * consistent with the Voice Layer's Phase B scope. Real command
 * understanding (message content, channel selection) is Phase C/D's
 * concern, likely via the existing Model Router rather than this
 * hand-rolled heuristic.
 */
object SpokenNameExtractor {

    private val KOREAN_PARTICLES = listOf("에게는", "한테는", "에게", "한테", "께")
    private val ENGLISH_LEAD_INS = listOf("tell ", "message ", "text ", "call ")

    fun extract(utterance: String): String {
        val trimmed = utterance.trim()
        if (trimmed.isEmpty()) return ""

        for (particle in KOREAN_PARTICLES) {
            val index = trimmed.indexOf(particle)
            if (index > 0) {
                return trimmed.substring(0, index).trim()
            }
        }

        val lower = trimmed.lowercase()
        for (leadIn in ENGLISH_LEAD_INS) {
            if (lower.startsWith(leadIn)) {
                val rest = trimmed.substring(leadIn.length).trim()
                // Stop at the first word after the name — a real NLU pass
                // would do this properly; this MVP heuristic takes just the
                // next token(s) up to a common trailing verb, best-effort.
                val stopWords = listOf(" that", " i'm", " i am", " to say")
                var end = rest.length
                for (stop in stopWords) {
                    val idx = rest.lowercase().indexOf(stop)
                    if (idx in 0 until end) end = idx
                }
                return rest.substring(0, end).trim()
            }
        }

        // No recognized pattern — return the whole utterance and let the
        // server's own match-against-candidates step fail closed
        // (NOT_FOUND) rather than this class guessing further.
        return trimmed
    }
}
