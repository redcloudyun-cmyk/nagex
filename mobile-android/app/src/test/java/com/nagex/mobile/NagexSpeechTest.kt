package com.nagex.mobile

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowTextToSpeech

/**
 * R23.6M Phase B4 — certifies the previously-disclosed gap: when TTS is
 * not ready/available, speak() truthfully reports failure (false) so the
 * caller falls back to a visual display, rather than silently doing
 * nothing or claiming success.
 */
@RunWith(RobolectricTestRunner::class)
class NagexSpeechTest {

    @Test
    fun `speak returns false before the TTS engine has reported ready`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val speech = NagexSpeech(context) { }
        // Deliberately not draining Robolectric's scheduler / not
        // simulating TextToSpeech.OnInitListener's onInit callback — this
        // is exactly the "not ready yet" window a real failure/slow-init
        // would produce.
        assertFalse(speech.speak("test utterance"))
    }

    @Test
    fun `speak returns true once the shadow TTS engine has reported ready`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        var readyState: Boolean? = null
        val speech = NagexSpeech(context) { ready -> readyState = ready }

        val shadow: ShadowTextToSpeech = shadowOf(ShadowTextToSpeech.getLastTextToSpeechInstance())
        shadow.onInitListener?.onInit(android.speech.tts.TextToSpeech.SUCCESS)

        assertTrue(readyState == true)
        assertTrue(speech.speak("test utterance"))
    }
}
