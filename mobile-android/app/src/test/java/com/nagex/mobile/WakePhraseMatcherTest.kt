package com.nagex.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WakePhraseMatcherTest {
    @Test
    fun `canonical wake phrase is accepted and removed from remainder`() {
        val result = WakePhraseMatcher.match("\uD5E4\uC774 \uB124\uC774\uC81D\uC2A4, \uC870\uBBFC\uD615\uC5D0\uAC8C \uC804\uD654 \uAC78\uC5B4\uC918")
        assertEquals(WakePhraseMatcher.Decision.ACCEPT, result.decision)
        assertEquals(WakePhraseMatcher.DEFAULT_WAKE_PHRASE, result.normalizedWakeCandidate)
        assertTrue(result.remainder.contains("\uC870\uBBFC\uD615"))
    }

    @Test
    fun `observed bounded STT wake drift is accepted only by the matcher`() {
        val result = WakePhraseMatcher.match("\uD5E4\uC774\uB370\uC774\uC81D\uC2A4 \uC870\uBBFC\uD615\uC5D0\uAC8C \uC804\uD654\uD574 \uC918")
        assertEquals(WakePhraseMatcher.Decision.ACCEPT, result.decision)
        assertEquals(WakePhraseMatcher.DEFAULT_WAKE_PHRASE, result.normalizedWakeCandidate)
        assertTrue(result.similarity >= 0.84)
    }

    @Test
    fun `unrelated phrase is rejected`() {
        val result = WakePhraseMatcher.match("\uD5E4\uC774 \uB300\uC774\uD130 \uC815\uB9AC\uD574\uC918")
        assertEquals(WakePhraseMatcher.Decision.REJECT, result.decision)
    }
}
