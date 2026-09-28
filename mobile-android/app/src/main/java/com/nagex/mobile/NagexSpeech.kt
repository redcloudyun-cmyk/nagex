package com.nagex.mobile

import android.content.Context
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/**
 * R23.6M Phase B2 — Text-to-Speech playback of NAgex's plain-text
 * responses. Like VoiceCaptureManager, this makes no decisions — it only
 * speaks whatever text it is given, and reports whether speaking actually
 * succeeded so the caller can fall back to a visual result instead of
 * silently doing nothing (per the directive: "TTS failure → visual
 * fallback").
 */
class NagexSpeech(context: Context, private val onReady: (available: Boolean) -> Unit) {

    private var tts: TextToSpeech? = null
    private var isReady = false

    init {
        tts = TextToSpeech(context) { status ->
            isReady = status == TextToSpeech.SUCCESS
            if (isReady) {
                tts?.language = Locale.getDefault()
            }
            onReady(isReady)
        }
    }

    /** Returns true if speech was actually queued; false means the caller
     * must fall back to a visual display of [text] instead.
     *
     * [onDone], if given, fires exactly once — when this utterance
     * finishes, errors, or (if speech could not even be queued) is never
     * spoken at all. R23.6M Phase C.5B-P0 needs this: an invocation
     * route's spoken acknowledgement ("네, 말씀하세요.") must fully finish
     * playing before command listening starts, since TextToSpeech.speak()
     * itself is fire-and-forget and returns long before the audio is
     * actually done — starting the recognizer immediately after calling
     * this would let its own silence timeout run out while the
     * acknowledgement is still audibly playing. */
    fun speak(text: String, onDone: (() -> Unit)? = null): Boolean {
        val engine = tts
        if (engine == null || !isReady) {
            onDone?.invoke()
            return false
        }

        if (onDone == null) {
            val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "nagex_utterance")
            return result == TextToSpeech.SUCCESS
        }

        val utteranceId = "nagex_utterance_${System.nanoTime()}"
        engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) {
                onDone()
            }
            @Deprecated("required override of the abstract legacy method")
            override fun onError(utteranceId: String?) {
                onDone()
            }
            override fun onError(utteranceId: String?, errorCode: Int) {
                onDone()
            }
        })
        val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
        if (result != TextToSpeech.SUCCESS) onDone()
        return result == TextToSpeech.SUCCESS
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
    }
}
