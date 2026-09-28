package com.nagex.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * R23.6M Phase C.5B-P0 — locks in the post-speech silence tuning decision
 * (minimum 1500ms, default/target 1800ms, capped ~2200ms) after physical
 * testing showed the OEM recognizer's own default threshold was cutting
 * off names and natural mid-sentence pauses prematurely. These are
 * recognizer hints, not a guaranteed exact cutoff — actual behavior is
 * verified on the physical certification device (scenarios A-E), not
 * purely by this unit test.
 */
class VoiceCaptureSilenceTuningTest {

    @Test
    fun `complete-silence threshold meets the 1500ms minimum and 1800ms target`() {
        assertTrue(VoiceCaptureManager.COMPLETE_SILENCE_LENGTH_MILLIS >= 1_500L)
        assertEquals(1_800L, VoiceCaptureManager.COMPLETE_SILENCE_LENGTH_MILLIS)
    }

    @Test
    fun `complete-silence threshold does not exceed the ~2200ms cap`() {
        assertTrue(VoiceCaptureManager.COMPLETE_SILENCE_LENGTH_MILLIS <= 2_200L)
    }

    @Test
    fun `possibly-complete threshold stays at or below the complete threshold, never overriding it later`() {
        assertTrue(VoiceCaptureManager.POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS <= VoiceCaptureManager.COMPLETE_SILENCE_LENGTH_MILLIS)
        assertEquals(1_500L, VoiceCaptureManager.POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS)
    }
}
