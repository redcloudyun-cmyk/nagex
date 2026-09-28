package com.nagex.mobile

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * R23.6M Phase C.5B-P0 — the one canonical entry point every invocation
 * route (in-app tap, home-screen shortcut/widget, notification action,
 * Quick Settings Tile — Section 17.3's VoiceInvocationProvider list)
 * converges on before reaching the existing voice/contact/message/approval
 * pipeline. It does not replace VoiceCaptureManager — it wraps it, adding
 * exactly three things VoiceCaptureManager was never responsible for:
 * an optional spoken acknowledgement, a session-level timeout safety net,
 * and cross-invocation concurrency control.
 *
 * Deliberately NOT responsible for (per the C.5A audit's explicit
 * boundary): resolving execution authority, approval, execution,
 * credentials, or direct device control, and it never mutates a Phase C
 * payload. It also implements no wake-word detection — C.5B-P0 is
 * explicit-invocation only; that boundary is enforced structurally here
 * by the simple fact that starting a session always requires an external
 * caller to invoke start() — nothing in this class listens for anything
 * before that call.
 */
class VoiceSession private constructor(context: Context) {

    private val voiceCapture = VoiceCaptureManager(context)
    private var resultDelivered = false
    private val timeoutHandler = Handler(Looper.getMainLooper())

    sealed class Result {
        data class Recognized(val text: String) : Result()
        object EmptyResult : Result()
        data class Error(val reason: String) : Result()
        object PermissionDenied : Result()
        object TimedOut : Result()
    }

    /** [speech]/[acknowledgement]: if both are non-null, the caller's own
     * NagexSpeech instance speaks the acknowledgement (e.g.
     * "네, 말씀하세요.") and command listening does not begin until that
     * utterance has actually finished playing — the canonical UX every
     * invocation route shares (Section 17's C.5E). Starting capture any
     * earlier would let the recognizer's own silence timeout run out
     * while the acknowledgement is still audibly playing, since
     * TextToSpeech.speak() itself returns long before playback ends.
     * [ackTimeoutMs] is a safety net only, in case the TTS engine never
     * reports completion. VoiceSession deliberately never constructs its
     * own TTS engine — it only coordinates the caller's. [onResult] fires
     * exactly once; any capture callback that arrives after a timeout has
     * already fired is silently ignored, never double-delivered. */
    fun start(
        locale: String,
        speech: NagexSpeech?,
        acknowledgement: String?,
        timeoutMs: Long = 15_000L,
        ackTimeoutMs: Long = 4_000L,
        onResult: (Result) -> Unit,
    ) {
        if (speech != null && acknowledgement != null) {
            var capturingStarted = false
            val beginCaptureRunnable = Runnable {
                if (!capturingStarted) {
                    capturingStarted = true
                    Log.d(TAG, "acknowledgement finished (or ack-timeout fired) — starting command capture")
                    beginCommandCapture(locale, timeoutMs, onResult)
                }
            }
            Log.d(TAG, "speaking acknowledgement, capture will start once it finishes (or after ${ackTimeoutMs}ms safety-net)")
            timeoutHandler.postDelayed(beginCaptureRunnable, ackTimeoutMs)
            speech.speak(acknowledgement) {
                // NagexSpeech's onDone callback arrives on the TTS
                // engine's own callback thread, not necessarily the main
                // thread — capture must start from the same thread
                // VoiceCaptureManager/SpeechRecognizer expect.
                timeoutHandler.post {
                    timeoutHandler.removeCallbacks(beginCaptureRunnable)
                    beginCaptureRunnable.run()
                }
            }
        } else {
            beginCommandCapture(locale, timeoutMs, onResult)
        }
    }

    private fun beginCommandCapture(locale: String, timeoutMs: Long, onResult: (Result) -> Unit) {
        timeoutHandler.postDelayed({
            if (!resultDelivered) {
                resultDelivered = true
                Log.d(TAG, "session-level timeout (${timeoutMs}ms) fired before any capture result arrived")
                release()
                onResult(Result.TimedOut)
            }
        }, timeoutMs)

        voiceCapture.listenOnce(locale) { captured ->
            if (resultDelivered) return@listenOnce
            resultDelivered = true
            timeoutHandler.removeCallbacksAndMessages(null)
            release()
            onResult(mapResult(captured))
        }
    }

    /** Explicit user cancellation — e.g. the hosting Activity is being torn
     * down. Any capture result that still arrives afterward is ignored. */
    fun cancel() {
        if (resultDelivered) return
        resultDelivered = true
        timeoutHandler.removeCallbacksAndMessages(null)
        release()
    }

    private fun mapResult(result: VoiceCaptureManager.Result): Result = when (result) {
        is VoiceCaptureManager.Result.Recognized -> Result.Recognized(result.text)
        is VoiceCaptureManager.Result.EmptyResult -> Result.EmptyResult
        is VoiceCaptureManager.Result.Error -> Result.Error(result.reason)
        is VoiceCaptureManager.Result.PermissionDenied -> Result.PermissionDenied
    }

    private fun release() {
        synchronized(lock) {
            if (active === this) active = null
        }
    }

    companion object {
        private const val TAG = "NagexVoiceSession"
        private val lock = Any()

        // MULTIPLE_ACTIVE_VOICE_SESSIONS = 0 — a single process-wide slot.
        // Any invocation route that finds this non-null must reject the
        // new invocation rather than starting a second SpeechRecognizer.
        @Volatile private var active: VoiceSession? = null

        /** Returns null if a session is already active. */
        fun tryAcquire(context: Context): VoiceSession? = synchronized(lock) {
            if (active != null) return@synchronized null
            val session = VoiceSession(context.applicationContext)
            active = session
            session
        }

        fun isActive(): Boolean = active != null
    }
}
