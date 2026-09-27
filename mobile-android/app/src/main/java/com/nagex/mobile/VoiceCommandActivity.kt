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
 * R23.6M Phase B2/B3/C — user speaks -> STT -> contact candidate lookup ->
 * server resolution -> spoken result -> (Phase C) hand-off to
 * MessageComposeActivity for the compose/approve/send flow. This Activity
 * is intentionally the ONLY place decisions are made about what recognized
 * text means; VoiceCaptureManager/NagexSpeech/ContactCandidateProvider/
 * NagexApiClient are all pure input/output or transport, exactly as the
 * R23.6M directive requires of the Voice Layer. It never itself composes a
 * message, requests approval, or sends anything — that is
 * MessageComposeActivity's job, reached only after a real UNIQUE
 * resolution.
 */
class VoiceCommandActivity : AppCompatActivity() {

    private lateinit var binding: ActivityVoiceCommandBinding
    private lateinit var config: NagexServerConfig
    private lateinit var apiClient: NagexApiClient
    private lateinit var voiceCapture: VoiceCaptureManager
    private lateinit var contactProvider: ContactCandidateProvider
    private lateinit var recipientLocalCache: RecipientLocalCache
    private var speech: NagexSpeech? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private val requestMicPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startListening() else showResult("Microphone permission denied — voice command cannot proceed.")
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
        voiceCapture = VoiceCaptureManager(this)
        contactProvider = ContactCandidateProvider(this)
        recipientLocalCache = RecipientLocalCache(this)
        speech = NagexSpeech(this) { /* ready callback — no action needed */ }

        binding.startListeningButton.setOnClickListener {
            if (voiceCapture.hasMicrophonePermission()) startListening()
            else requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun startListening() {
        binding.recognizedTextView.text = "Listening..."
        binding.resultTextView.text = ""
        voiceCapture.listenOnce(locale = "ko-KR") { result ->
            mainHandler.post { onVoiceResult(result) }
        }
    }

    private fun onVoiceResult(result: VoiceCaptureManager.Result) {
        when (result) {
            is VoiceCaptureManager.Result.PermissionDenied ->
                showResult("Microphone permission denied — voice command cannot proceed.")
            is VoiceCaptureManager.Result.EmptyResult -> {
                // STT uncertain/empty result — no action, per the directive.
                binding.recognizedTextView.text = ""
                showResult("Didn't catch that — please try again.")
            }
            is VoiceCaptureManager.Result.Error ->
                showResult("Voice recognition error: ${result.reason}")
            is VoiceCaptureManager.Result.Recognized -> {
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
        speech?.shutdown()
        super.onDestroy()
    }
}
