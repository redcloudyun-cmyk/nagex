package com.nagex.mobile

import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.content.ContextCompat
import android.Manifest

/**
 * R23.6M Phase B2 — Voice Capture. This class's ENTIRE responsibility is
 * "microphone in, recognized text out (or a truthful failure/empty
 * result)". Per the R23.6M directive ("Voice Layer must NOT make
 * permission/approval/contact/policy decisions — it is only input/output"),
 * it never interprets, acts on, or forwards recognized text anywhere
 * itself; the caller (VoiceCommandActivity) decides what recognized text
 * means.
 */
class VoiceCaptureManager(private val context: Context) {

    sealed class Result {
        data class Recognized(val text: String) : Result()
        /** STT completed but returned nothing usable — never treated as an
         * executable command. */
        object EmptyResult : Result()
        data class Error(val reason: String) : Result()
        object PermissionDenied : Result()
    }

    fun hasMicrophonePermission(): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun listenOnce(locale: String, onResult: (Result) -> Unit) {
        if (!hasMicrophonePermission()) {
            onResult(Result.PermissionDenied)
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            onResult(Result.Error("SpeechRecognizer is not available on this device."))
            return
        }

        val recognizer = SpeechRecognizer.createSpeechRecognizer(context)
        val intent = android.content.Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            // Without these, the OEM recognizer's own default silence
            // threshold was finalizing results too early — physically
            // observed as names being cut off mid-word and brief natural
            // pauses (e.g. before a Korean honorific/title) ending the
            // utterance prematurely. These are hints, not a guaranteed
            // exact cutoff (the recognizer/OS may clamp or ignore them),
            // so behavior must still be verified per device.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, COMPLETE_SILENCE_LENGTH_MILLIS)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS)
        }

        Log.d(TAG, "listenOnce: startListening locale=$locale completeSilenceMs=$COMPLETE_SILENCE_LENGTH_MILLIS possiblyCompleteMs=$POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS")

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: Bundle) {
                val matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = matches?.firstOrNull()?.trim()
                Log.d(TAG, "onResults: text=${text ?: "<null>"}")
                if (text.isNullOrEmpty()) {
                    onResult(Result.EmptyResult)
                } else {
                    onResult(Result.Recognized(text))
                }
                recognizer.destroy()
            }

            override fun onError(error: Int) {
                Log.d(TAG, "onError: code=$error (${errorName(error)})")
                // STT uncertain/no-match is a truthful empty result, not an
                // error — everything else is a genuine error.
                if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                    onResult(Result.EmptyResult)
                } else {
                    onResult(Result.Error("SpeechRecognizer error code $error"))
                }
                recognizer.destroy()
            }

            override fun onReadyForSpeech(params: Bundle?) {
                Log.d(TAG, "onReadyForSpeech")
            }
            override fun onBeginningOfSpeech() {
                Log.d(TAG, "onBeginningOfSpeech")
            }
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {
                Log.d(TAG, "onEndOfSpeech")
            }
            override fun onPartialResults(partialResults: Bundle?) {
                val partial = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                if (partial != null) Log.d(TAG, "onPartialResults: $partial")
            }
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        recognizer.startListening(intent)
    }

    private fun errorName(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_NO_MATCH -> "ERROR_NO_MATCH"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "ERROR_SPEECH_TIMEOUT"
        SpeechRecognizer.ERROR_NETWORK -> "ERROR_NETWORK"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "ERROR_NETWORK_TIMEOUT"
        SpeechRecognizer.ERROR_AUDIO -> "ERROR_AUDIO"
        SpeechRecognizer.ERROR_CLIENT -> "ERROR_CLIENT"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "ERROR_INSUFFICIENT_PERMISSIONS"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "ERROR_RECOGNIZER_BUSY"
        SpeechRecognizer.ERROR_SERVER -> "ERROR_SERVER"
        else -> "UNKNOWN"
    }

    companion object {
        private const val TAG = "NagexVoiceCapture"

        // Post-speech silence targets (R23.6M Phase C.5B-P0 UX tuning):
        // minimum 1500ms, default 1800ms, capped ~2200ms per the directive.
        // "Possibly complete" is the recognizer's own earlier, softer
        // threshold — kept below the hard "complete" threshold so it never
        // overrides the longer one.
        const val COMPLETE_SILENCE_LENGTH_MILLIS = 1_800L
        const val POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS = 1_500L
    }
}
