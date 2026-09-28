package com.nagex.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.nagex.mobile.databinding.ActivityVoiceCommandBinding

/**
 * R23.6M Phase B2/B3/C/C.5B-P0 — user speaks -> STT -> contact candidate
 * lookup -> server resolution -> spoken result -> (Phase C) hand-off to
 * MessageComposeActivity for the compose/approve/send flow. This Activity
 * is intentionally the ONLY place decisions are made about what recognized
 * text means; VoiceSession/VoiceCaptureManager/NagexSpeech/
 * ContactCandidateProvider/NagexApiClient are all pure input/output,
 * session-lifecycle, or transport, exactly as the R23.6M directive
 * requires of the Voice Layer. It never itself composes a message,
 * requests approval, or sends anything — that is MessageComposeActivity's
 * job, reached only after a real UNIQUE resolution.
 *
 * Phase C.5B-P0: this Activity is now the single canonical destination
 * every invocation route (in-app tap, home-screen shortcut/widget,
 * notification action, Quick Settings Tile) converges on — external
 * routes reach it only via the exported VoiceInvokeActivity trampoline,
 * never directly, so this Activity's own android:exported="false"
 * boundary (established in Phase B) is unchanged. EXTRA_AUTO_START, set
 * only by that trampoline, is what makes external invocation feel like
 * "no extra button press" (Section 5) without changing the existing
 * manual in-app tap flow's own behavior.
 */
class VoiceCommandActivity : AppCompatActivity() {

    private lateinit var binding: ActivityVoiceCommandBinding
    private lateinit var config: NagexServerConfig
    private lateinit var apiClient: NagexApiClient
    private lateinit var contactProvider: ContactCandidateProvider
    private lateinit var recipientLocalCache: RecipientLocalCache
    private var speech: NagexSpeech? = null
    private var activeSession: VoiceSession? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private val requestMicPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) beginListening() else showResult("Microphone permission denied — voice command cannot proceed.")
    }
    private val requestContactsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) showResult("Contacts permission denied — cannot resolve a recipient.")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityVoiceCommandBinding.inflate(layoutInflater)
        setContentView(binding.root)

        config = NagexServerConfig(this)
        apiClient = NagexApiClient(config)
        contactProvider = ContactCandidateProvider(this)
        recipientLocalCache = RecipientLocalCache(this)
        speech = NagexSpeech(this) { /* ready callback — no action needed */ }

        binding.startListeningButton.setOnClickListener { attemptStartListening() }

        // Every external invocation route (Section 17.3) sets this exactly
        // once, via VoiceInvokeActivity — never set by this app's own
        // manual "tap and speak" flow.
        if (intent.getBooleanExtra(EXTRA_AUTO_START, false)) {
            attemptStartListening()
        }
    }

    private fun attemptStartListening() {
        if (VoiceCaptureManager(this).hasMicrophonePermission()) beginListening()
        else requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
    }

    private fun beginListening() {
        // MULTIPLE_ACTIVE_VOICE_SESSIONS = 0 — a second invocation (e.g.
        // the widget tapped again, or a notification tapped while this
        // very screen is already listening) must never start a second
        // SpeechRecognizer; it is rejected here, truthfully, not silently
        // queued or dropped.
        val session = VoiceSession.tryAcquire(this)
        if (session == null) {
            showResult("NAgex is already listening.")
            return
        }
        activeSession = session
        binding.recognizedTextView.text = ""
        binding.resultTextView.text = ""
        session.start(locale = "ko-KR", speech = speech, acknowledgement = getString(R.string.voice_acknowledgement)) { result ->
            mainHandler.post {
                activeSession = null
                onVoiceResult(result)
            }
        }
    }

    private fun onVoiceResult(result: VoiceSession.Result) {
        when (result) {
            is VoiceSession.Result.PermissionDenied ->
                showResult("Microphone permission denied — voice command cannot proceed.")
            is VoiceSession.Result.EmptyResult -> {
                // STT uncertain/empty result — no action, per the directive.
                binding.recognizedTextView.text = ""
                showResult("Didn't catch that — please try again.")
            }
            is VoiceSession.Result.TimedOut -> {
                binding.recognizedTextView.text = ""
                showResult("Didn't hear anything — please try again.")
            }
            is VoiceSession.Result.Error ->
                showResult("Voice recognition error: ${result.reason}")
            is VoiceSession.Result.Recognized -> {
                binding.recognizedTextView.text = result.text
                resolveRecipient(result.text)
            }
        }
    }

    private fun resolveRecipient(utterance: String) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            requestContactsPermission.launch(Manifest.permission.READ_CONTACTS)
            return
        }

        val deviceId = config.deviceId
        val tenantId = config.tenantId
        val ownerId = config.principalId
        if (deviceId == null || tenantId == null || ownerId == null) {
            showResult("Device is not enrolled yet — set up the device on the Status screen first.")
            return
        }

        val spokenName = SpokenNameExtractor.extract(utterance)
        showResult("Looking up \"$spokenName\"...")

        Thread {
            val localCandidates = contactProvider.findCandidates(spokenName)
            val outcome = try {
                val candidateDtos = localCandidates.map { NagexApiClient.ContactCandidateDto(it.contactId, it.displayName) }
                apiClient.resolveContacts(deviceId, spokenName, candidateDtos)
            } catch (e: Exception) {
                null
            }
            mainHandler.post { renderResolution(spokenName, outcome, localCandidates) }
        }.start()
    }

    private fun renderResolution(spokenName: String, outcome: NagexApiClient.ContactResolutionResponse?, localCandidates: List<ContactCandidateProvider.Candidate>) {
        if (outcome != null && outcome.status == "UNIQUE" && outcome.recipientRef != null) {
            // Correlate the server's UNIQUE match back to the local
            // androidContactId this device itself found — the server never
            // sent one back (it never has more than the opaque contactId
            // string to begin with, and never a phone number). Matching by
            // displayName is safe here: a genuinely duplicate-name
            // situation is exactly what AMBIGUOUS exists to catch instead
            // of ever reaching UNIQUE.
            val matched = localCandidates.firstOrNull { it.displayName == outcome.displayName }
            if (matched != null) {
                recipientLocalCache.remember(outcome.recipientRef, matched.contactId)
                showResult("Found ${outcome.displayName}.")
                startActivity(Intent(this, MessageComposeActivity::class.java).apply {
                    putExtra(MessageComposeActivity.EXTRA_RECIPIENT_REF, outcome.recipientRef)
                    putExtra(MessageComposeActivity.EXTRA_DISPLAY_NAME, outcome.displayName)
                })
                return
            }
        }

        val spoken = when {
            outcome == null -> "Sorry, I couldn't reach NAgex to look that up."
            outcome.status == "UNIQUE" -> "Found ${outcome.displayName}, but I lost track of which local contact that was — please try again."
            outcome.status == "AMBIGUOUS" -> {
                val names = outcome.candidates.joinToString(", ") { it.displayName }
                "There are ${outcome.candidates.size} contacts matching \"$spokenName\": $names. Please be more specific."
            }
            else -> "I couldn't find a contact matching \"$spokenName\"."
        }
        showResult(spoken)
    }

    private fun showResult(text: String) {
        binding.resultTextView.text = text
        val spoke = speech?.speak(text) ?: false
        if (!spoke) {
            // TTS failure -> visual fallback is already satisfied by the
            // resultTextView above; nothing further to do.
        }
    }

    override fun onDestroy() {
        activeSession?.cancel()
        activeSession = null
        speech?.shutdown()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_AUTO_START = "extra_auto_start"
    }
}
