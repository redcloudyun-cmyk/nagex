package com.nagex.mobile

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * R23.6M Phase C.5B-P0 — certifies VoiceSession's concurrency contract
 * (MULTIPLE_ACTIVE_VOICE_SESSIONS = 0) and that a terminal capture result
 * (here: PermissionDenied, the one outcome reliably reproducible without a
 * real SpeechRecognizer under Robolectric) always releases the
 * process-wide slot rather than leaking it.
 */
@RunWith(RobolectricTestRunner::class)
class VoiceSessionTest {

    private fun context() = ApplicationProvider.getApplicationContext<android.app.Application>()

    @Test
    fun `a second tryAcquire fails while a session is already held`() {
        val first = VoiceSession.tryAcquire(context())
        assertNotNull(first)
        assertTrue(VoiceSession.isActive())

        val second = VoiceSession.tryAcquire(context())
        assertNull(second)

        first?.cancel()
    }

    @Test
    fun `cancelling the active session frees the slot for a new invocation`() {
        val first = VoiceSession.tryAcquire(context())
        assertNotNull(first)

        first?.cancel()
        assertFalse(VoiceSession.isActive())

        val second = VoiceSession.tryAcquire(context())
        assertNotNull("a new invocation must be able to acquire the slot once the prior one is cancelled", second)
        second?.cancel()
    }

    @Test
    fun `a permission-denied capture result releases the slot automatically, without an explicit cancel`() {
        // RECORD_AUDIO is not granted in a fresh Robolectric application by
        // default, so VoiceCaptureManager.listenOnce reports
        // PermissionDenied synchronously — this exercises start()'s own
        // release() path, not cancel()'s.
        val session = VoiceSession.tryAcquire(context())
        assertNotNull(session)

        var delivered: VoiceSession.Result? = null
        session?.start(locale = "ko-KR", speech = null, acknowledgement = null) { result ->
            delivered = result
        }

        assertTrue(delivered is VoiceSession.Result.PermissionDenied)
        assertFalse("the slot must be free again once a terminal result has been delivered", VoiceSession.isActive())
    }

    @Test
    fun `a late result after cancel is silently ignored, never double-delivered`() {
        val session = VoiceSession.tryAcquire(context())
        assertNotNull(session)
        session?.cancel()

        var callCount = 0
        // Calling start() after cancel() on the same (already-released)
        // instance simulates a capture callback arriving after the
        // session considers itself finished — resultDelivered is already
        // true, so onResult must never fire.
        session?.start(locale = "ko-KR", speech = null, acknowledgement = null) { callCount++ }

        assertEquals(0, callCount)
    }
}
