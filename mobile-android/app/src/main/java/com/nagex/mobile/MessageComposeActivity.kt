package com.nagex.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.LinearLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.nagex.mobile.databinding.ActivityMessageComposeBinding

/**
 * R23.6M Phase C — one complete real SMS flow, UI side: compose (voice) ->
 * immutable draft -> real human approval (the same
 * POST /api/v1/approvals/:id/approve every other consequential NAgex
 * action uses) -> device-executed SmsManager send -> real device-reported
 * result. This Activity is reached only after VoiceCommandActivity's own
 * UNIQUE contact resolution — it never itself resolves a contact or
 * decides who the recipient is.
 *
 * Never calls SmsManager directly — SmsSendExecutor is the one place that
 * happens, and only after the server's MOBILE_MESSAGE_EXECUTE response
 * (via a real Ed25519-signed device-agent command) confirms the approval
 * was genuinely consumed.
 */
class MessageComposeActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMessageComposeBinding
    private lateinit var config: NagexServerConfig
    private lateinit var apiClient: NagexApiClient
    private lateinit var keyManager: DeviceKeyManager
    private lateinit var recipientLocalCache: RecipientLocalCache
    private lateinit var phoneNumberResolver: PhoneNumberResolver
    private var speech: NagexSpeech? = null
    private var activeSession: VoiceSession? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private lateinit var recipientRef: String
    private lateinit var displayName: String
    private var currentRunId: String? = null
    private var currentApprovalId: String? = null

    private val requestMicPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startListeningForMessage() else showStatus("Microphone permission denied — voice command cannot proceed.")
    }
    private val requestSmsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) proceedToExecution() else showStatus("SMS permission denied — the approved message cannot be sent from this device.")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMessageComposeBinding.inflate(layoutInflater)
        setContentView(binding.root)

        recipientRef = intent.getStringExtra(EXTRA_RECIPIENT_REF) ?: run { finish(); return }
        displayName = intent.getStringExtra(EXTRA_DISPLAY_NAME) ?: ""

        config = NagexServerConfig(this)
        apiClient = NagexApiClient(config)
        keyManager = DeviceKeyManager(this)
        recipientLocalCache = RecipientLocalCache(this)
        phoneNumberResolver = PhoneNumberResolver(this)
        speech = NagexSpeech(this) { }

        binding.recipientText.text = "To: $displayName"
        binding.recordMessageButton.setOnClickListener {
            if (VoiceCaptureManager(this).hasMicrophonePermission()) startListeningForMessage()
            else requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
        }
        binding.approveButton.setOnClickListener { onApproveTapped() }
        binding.rejectButton.setOnClickListener { onRejectTapped() }
        setApprovalButtonsVisible(false)
    }

    // C.5B-P0 — this capture step now also goes through the canonical
    // VoiceSession, so the MULTIPLE_ACTIVE_VOICE_SESSIONS = 0 guard covers
    // message recording exactly like recipient resolution does.
    private fun startListeningForMessage() {
        val session = VoiceSession.tryAcquire(this)
        if (session == null) {
            showStatus("NAgex is already listening.")
            return
        }
        activeSession = session
        showStatus("Listening for the message...")
        // C.5B-P0 physical-cert finding: starting capture the instant the
        // button is tapped gave the user no warning/preparation window at
        // all ("too fast — the gap before I need to speak needs to be
        // longer"). Reusing the same spoken acknowledgement + wait-for-
        // TTS-to-finish sequencing VoiceCommandActivity already uses gives
        // a consistent, audible "now" cue before listening starts.
        session.start(locale = "ko-KR", speech = speech, acknowledgement = getString(R.string.voice_acknowledgement)) { result ->
            mainHandler.post {
                activeSession = null
                onMessageRecognized(result)
            }
        }
    }

    private fun onMessageRecognized(result: VoiceSession.Result) {
        when (result) {
            is VoiceSession.Result.PermissionDenied -> showStatus("Microphone permission denied — voice command cannot proceed.")
            is VoiceSession.Result.EmptyResult -> showStatus("Didn't catch that — please try again.")
            is VoiceSession.Result.TimedOut -> showStatus("Didn't hear anything — please try again.")
            is VoiceSession.Result.Error -> showStatus("Voice recognition error: ${result.reason}")
            is VoiceSession.Result.Recognized -> {
                binding.messageText.text = result.text
                createDraftAndRequestApproval(result.text)
            }
        }
    }

    private fun createDraftAndRequestApproval(message: String) {
        val deviceId = config.deviceId
        if (deviceId == null) {
            showStatus("Device is not enrolled yet.")
            return
        }
        showStatus("Requesting approval...")
        Thread {
            val outcome = try {
                val run = apiClient.createMessage(deviceId, recipientRef, message)
                apiClient.requestMessageApproval(run.runId)
            } catch (e: NagexApiClient.ApiException) {
                null
            }
            mainHandler.post {
                if (outcome == null) {
                    showStatus("Could not request approval.")
                    return@post
                }
                currentRunId = outcome.runId
                currentApprovalId = outcome.approvalId
                showStatus("Approve sending this message to $displayName?")
                setApprovalButtonsVisible(true)
            }
        }.start()
    }

    private fun onApproveTapped() {
        val approvalId = currentApprovalId ?: return
        setApprovalButtonsVisible(false)
        showStatus("Approving...")
        Thread {
            val approvedRun = try {
                apiClient.approveMessage(approvalId)
                apiClient.getMessage(currentRunId!!)
            } catch (e: NagexApiClient.ApiException) {
                null
            }
            mainHandler.post {
                if (approvedRun == null || approvedRun.status != "APPROVED") {
                    showStatus("Approval did not complete (status=${approvedRun?.status}).")
                    return@post
                }
                showStatus("Approved. Preparing to send...")
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
                    requestSmsPermission.launch(Manifest.permission.SEND_SMS)
                } else {
                    proceedToExecution()
                }
            }
        }.start()
    }

    private fun onRejectTapped() {
        val approvalId = currentApprovalId ?: return
        setApprovalButtonsVisible(false)
        Thread {
            try { apiClient.rejectMessage(approvalId) } catch (e: NagexApiClient.ApiException) { }
            mainHandler.post { showStatus("Cancelled. No message was sent.") }
        }.start()
    }

    private fun proceedToExecution() {
        val runId = currentRunId ?: return
        val deviceId = config.deviceId ?: return
        val tenantId = config.tenantId ?: return
        val ownerId = config.principalId ?: return
        val androidContactId = recipientLocalCache.androidContactIdFor(recipientRef)
        if (androidContactId == null) {
            showStatus("Could not locally resolve this recipient anymore.")
            return
        }

        Thread {
            val prepareResult = try {
                apiClient.sendDeviceMessage(deviceId, tenantId, ownerId, keyManager, DeviceAgentPayload.mobileMessagePrepare(runId))
            } catch (e: NagexApiClient.ApiException) {
                null
            }
            if (prepareResult == null) {
                mainHandler.post { showStatus("Could not prepare the approved message for execution.") }
                return@Thread
            }

            val phoneResult = phoneNumberResolver.resolve(androidContactId)
            when (phoneResult) {
                is PhoneNumberResolver.Result.NotFound -> mainHandler.post { showStatus("No phone number is saved for $displayName — cannot send.") }
                is PhoneNumberResolver.Result.Ambiguous -> mainHandler.post { showPhoneNumberPicker(phoneResult.phoneNumbers) }
                is PhoneNumberResolver.Result.Unique -> executeApprovedSend(runId, deviceId, tenantId, ownerId, phoneResult.phoneNumber)
            }
        }.start()
    }

    private fun showPhoneNumberPicker(numbers: List<String>) {
        binding.phoneNumberPickerContainer.removeAllViews()
        binding.phoneNumberPickerContainer.visibility = android.view.View.VISIBLE
        showStatus("Multiple phone numbers found for $displayName — please choose one.")
        for (number in numbers) {
            val button = Button(this).apply {
                text = phoneNumberResolver.maskForDisplay(number)
                setOnClickListener {
                    binding.phoneNumberPickerContainer.visibility = android.view.View.GONE
                    val runId = currentRunId ?: return@setOnClickListener
                    val deviceId = config.deviceId ?: return@setOnClickListener
                    val tenantId = config.tenantId ?: return@setOnClickListener
                    val ownerId = config.principalId ?: return@setOnClickListener
                    Thread { executeApprovedSend(runId, deviceId, tenantId, ownerId, number) }.start()
                }
            }
            binding.phoneNumberPickerContainer.addView(button, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }
    }

    /** Called on a background thread. The one and only path that reaches
     * SmsSendExecutor — never directly from a UI callback. */
    private fun executeApprovedSend(runId: String, deviceId: String, tenantId: String, ownerId: String, phoneNumber: String) {
        val executeResult = try {
            apiClient.sendDeviceMessage(deviceId, tenantId, ownerId, keyManager, DeviceAgentPayload.mobileMessageExecute(runId))
        } catch (e: NagexApiClient.ApiException) {
            mainHandler.post { showStatus("Execution was rejected: ${e.message}") }
            return
        }
        val status = executeResult.optJSONObject("result")?.optString("status")
        if (status != "SEND_ATTEMPTED") {
            mainHandler.post { showStatus("Server did not authorize the send (status=$status).") }
            return
        }

        val message = binding.messageText.text.toString()
        mainHandler.post {
            showStatus("Sending...")
            SmsSendExecutor(this).send(
                phoneNumber = phoneNumber,
                message = message,
                onSentResult = { outcome ->
                    val resultCode = when (outcome) {
                        is SmsSendExecutor.SendOutcome.SentConfirmed -> "SENT_CONFIRMED"
                        is SmsSendExecutor.SendOutcome.SendFailed -> "SEND_FAILED"
                        is SmsSendExecutor.SendOutcome.StatusUnknown -> "SEND_STATUS_UNKNOWN"
                    }
                    Thread {
                        try { apiClient.sendDeviceMessage(deviceId, tenantId, ownerId, keyManager, DeviceAgentPayload.mobileMessageStatus(runId, resultCode)) } catch (e: Exception) { }
                    }.start()
                    val text = when (outcome) {
                        is SmsSendExecutor.SendOutcome.SentConfirmed -> "Sent to $displayName."
                        is SmsSendExecutor.SendOutcome.SendFailed -> "Send failed: ${outcome.reason}"
                        is SmsSendExecutor.SendOutcome.StatusUnknown -> "Send result unknown — the message may or may not have been delivered."
                    }
                    showStatus(text)
                },
                onDeliveredResult = { delivered ->
                    if (delivered) {
                        Thread {
                            try { apiClient.sendDeviceMessage(deviceId, tenantId, ownerId, keyManager, DeviceAgentPayload.mobileMessageDeliveryConfirmed(runId)) } catch (e: Exception) { }
                        }.start()
                        mainHandler.post { showStatus("Delivered to $displayName.") }
                    }
                },
            )
        }
    }

    private fun setApprovalButtonsVisible(visible: Boolean) {
        val visibility = if (visible) android.view.View.VISIBLE else android.view.View.GONE
        binding.approveButton.visibility = visibility
        binding.rejectButton.visibility = visibility
    }

    private fun showStatus(text: String) {
        binding.statusText.text = text
        speech?.speak(text)
    }

    override fun onDestroy() {
        activeSession?.cancel()
        activeSession = null
        speech?.shutdown()
        super.onDestroy()
    }

    companion object {
        const val EXTRA_RECIPIENT_REF = "extra_recipient_ref"
        const val EXTRA_DISPLAY_NAME = "extra_display_name"
    }
}
