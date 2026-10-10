package com.nagex.mobile

import kotlin.math.max

object WakePhraseMatcher {
    const val DEFAULT_WAKE_PHRASE = "\uD5E4\uC774 \uB124\uC774\uC81D\uC2A4"
    const val SHORT_WAKE_PHRASE = "\uB124\uC774\uC81D\uC2A4"

    data class Result(
        val rawWakeText: String,
        val normalizedWakeCandidate: String?,
        val similarity: Double,
        val decision: Decision,
        val remainder: String,
    )

    enum class Decision { ACCEPT, REJECT }

    fun match(rawText: String): Result {
        val normalized = normalize(rawText)
        val candidates = candidatePrefixes(normalized)
        val best = candidates
            .flatMap { candidate ->
                listOf(
                    score(candidate, normalize(DEFAULT_WAKE_PHRASE), DEFAULT_WAKE_PHRASE),
                    score(candidate, normalize(SHORT_WAKE_PHRASE), SHORT_WAKE_PHRASE),
                )
            }
            .maxByOrNull { it.similarity }

        if (best == null || best.similarity < 0.84 || best.distance > 2) {
            return Result(rawWakeText = firstToken(rawText), normalizedWakeCandidate = null, similarity = best?.similarity ?: 0.0, decision = Decision.REJECT, remainder = rawText.trim())
        }

        val remainder = normalized.removePrefix(best.rawCandidate).trim()
        return Result(
            rawWakeText = best.rawCandidate,
            normalizedWakeCandidate = best.canonical,
            similarity = best.similarity,
            decision = Decision.ACCEPT,
            remainder = remainder.ifBlank { rawText.trim() },
        )
    }

    private data class Score(val rawCandidate: String, val canonical: String, val similarity: Double, val distance: Int)

    private fun score(candidate: String, canonicalNormalized: String, canonical: String): Score {
        val distance = levenshtein(candidate, canonicalNormalized)
        val similarity = 1.0 - (distance.toDouble() / max(candidate.length, canonicalNormalized.length).coerceAtLeast(1))
        return Score(candidate, canonical, similarity, distance)
    }

    private fun candidatePrefixes(normalized: String): List<String> {
        val compact = normalize(normalized)
        val maxLen = normalize(DEFAULT_WAKE_PHRASE).length + 2
        return (2..maxLen.coerceAtMost(compact.length)).map { compact.take(it) }
    }

    private fun normalize(value: String): String =
        value.lowercase()
            .replace(Regex("[\\s,.;:!?~]+"), "")
            .replace("\uD5E4\uC774\uB370\uC774\uC81D\uC2A4", "\uD5E4\uC774\uB124\uC774\uC81D\uC2A4")

    private fun firstToken(value: String): String = value.trim().split(Regex("\\s+")).firstOrNull().orEmpty()

    private fun levenshtein(a: String, b: String): Int {
        if (a == b) return 0
        if (a.isEmpty()) return b.length
        if (b.isEmpty()) return a.length
        val costs = IntArray(b.length + 1) { it }
        for (i in a.indices) {
            var last = i
            costs[0] = i + 1
            for (j in b.indices) {
                val old = costs[j + 1]
                costs[j + 1] = minOf(
                    costs[j + 1] + 1,
                    costs[j] + 1,
                    last + if (a[i] == b[j]) 0 else 1,
                )
                last = old
            }
        }
        return costs[b.length]
    }
}
