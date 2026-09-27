package com.nagex.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.nagex.mobile.databinding.ActivityVoiceCommandBinding

/**
 * R23.6M Phase B2/B3 — the end-to-end Phase B loop: user speaks -> STT ->
 * contact candidate lookup -> server resolution -> spoken result. This
 * Activity is intentionally the ONLY place decisions are made about what
 * recognized text means; VoiceCaptureManager/NagexSpeech/
 * ContactCandidateProvider/NagexApiClient are all pure input/output or
 * transport, exactly as the R23.6M directive requires of the Voice Layer.
 *
 * Explicitly out of scope here (Phase C/D): no SMS send, no KakaoTalk
 * send, no approval flow — this screen only ever reaches a spoken
 * UNIQUE/AMBIGUOUS/NOT_FOUND result and stops.
 */
class VoiceCommandActivity : AppCompatActivity() {

    private lateinit var binding: ActivityVoiceCommandBinding
    private lateinit var config: NagexServerConfig
    private lateinit var apiClient: NagexApiClient
    private lateinit var voiceCapture: VoiceCaptureManager
    private lateinit var contactProvider: ContactCandidateProvider
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
            val outcome = try {
                val candidates = contactProvider.findCandidates(spokenName)
                    .map { NagexApiClient.ContactCandidateDto(it.contactId, it.displayName) }
                apiClient.resolveContacts(deviceId, spokenName, candidates)
            } catch (e: Exception) {
                null
            }
            mainHandler.post { renderResolution(spokenName, outcome) }
        }.start()
    }

    private fun renderResolution(spokenName: String, outcome: NagexApiClient.ContactResolutionResponse?) {
        val spoken = when {
            outcome == null -> "Sorry, I couldn't reach NAgex to look that up."
            outcome.status == "UNIQUE" -> "Found ${outcome.displayName}. (Phase B stops here — no message is sent yet.)"
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
