package com.nagex.mobile

import android.content.Context
import android.speech.tts.TextToSpeech
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
     * must fall back to a visual display of [text] instead. */
    fun speak(text: String): Boolean {
        val engine = tts ?: return false
        if (!isReady) return false
        val result = engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "nagex_utterance")
        return result == TextToSpeech.SUCCESS
    }

    fun shutdown() {
        tts?.stop()
        tts?.shutdown()
        tts = null
    }
}
