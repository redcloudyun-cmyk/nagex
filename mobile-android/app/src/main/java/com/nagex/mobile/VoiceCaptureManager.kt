package com.nagex.mobile

import android.content.Context
import android.content.pm.PackageManager
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
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
        }

        recognizer.setRecognitionListener(object : RecognitionListener {
            override fun onResults(results: Bundle) {
                val matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val text = matches?.firstOrNull()?.trim()
                if (text.isNullOrEmpty()) {
                    onResult(Result.EmptyResult)
                } else {
                    onResult(Result.Recognized(text))
                }
                recognizer.destroy()
            }

            override fun onError(error: Int) {
                // STT uncertain/no-match is a truthful empty result, not an
                // error — everything else is a genuine error.
                if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                    onResult(Result.EmptyResult)
                } else {
                    onResult(Result.Error("SpeechRecognizer error code $error"))
                }
                recognizer.destroy()
            }

            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })

        recognizer.startListening(intent)
    }
}
