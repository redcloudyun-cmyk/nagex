package com.nagex.mobile

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity
import com.nagex.mobile.databinding.ActivityStatusBinding

/**
 * R23.6M Phase B1 — the app's launcher screen: configurable server URL,
 * device enrollment, and a basic diagnostic/status view. Deliberately the
 * ONLY "foreground connection/status screen" this phase builds — no
 * broader design system.
 */
class StatusActivity : AppCompatActivity() {

    private lateinit var binding: ActivityStatusBinding
    private lateinit var config: NagexServerConfig
    private lateinit var keyManager: DeviceKeyManager
    private lateinit var apiClient: NagexApiClient
    private lateinit var enrollmentManager: DeviceEnrollmentManager
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityStatusBinding.inflate(layoutInflater)
        setContentView(binding.root)

        config = NagexServerConfig(this)
        keyManager = DeviceKeyManager(this)
        apiClient = NagexApiClient(config)
        enrollmentManager = DeviceEnrollmentManager(config, keyManager, apiClient)

        binding.serverUrlInput.setText(config.serverBaseUrl)
        binding.tenantIdInput.setText(config.tenantId ?: "")
        binding.principalIdInput.setText(config.principalId ?: "")
        renderStatus()

        binding.saveConfigButton.setOnClickListener {
            config.serverBaseUrl = binding.serverUrlInput.text.toString()
            config.tenantId = binding.tenantIdInput.text.toString().ifBlank { null }
            config.principalId = binding.principalIdInput.text.toString().ifBlank { null }
            binding.statusText.text = "Configuration saved."
        }

        binding.enrollButton.setOnClickListener { runEnrollment() }
        binding.checkStatusButton.setOnClickListener { runStatusCheck() }

        binding.voiceCommandButton.setOnClickListener {
            startActivity(Intent(this, VoiceCommandActivity::class.java))
        }
    }

    private fun renderStatus() {
        binding.statusText.text = if (config.isEnrolled) {
            "Enrolled. deviceId=${config.deviceId}, status=${config.deviceStatus}"
        } else {
            getString(R.string.status_not_enrolled)
        }
    }

    private fun runEnrollment() {
        binding.statusText.text = "Enrolling..."
        Thread {
            val outcome = enrollmentManager.ensureEnrolled()
            mainHandler.post {
                binding.statusText.text = when (outcome) {
                    is DeviceEnrollmentManager.EnrollmentOutcome.AlreadyEnrolled ->
                        "Already enrolled. deviceId=${outcome.deviceId}, status=${outcome.status}"
                    is DeviceEnrollmentManager.EnrollmentOutcome.Enrolled ->
                        "Enrolled. deviceId=${outcome.deviceId}, status=${outcome.status}"
                    is DeviceEnrollmentManager.EnrollmentOutcome.Failed ->
                        "Enrollment failed: ${outcome.message}"
                }
            }
        }.start()
    }

    private fun runStatusCheck() {
        val deviceId = config.deviceId
        val tenantId = config.tenantId
        val ownerId = config.principalId
        if (deviceId == null || tenantId == null || ownerId == null) {
            binding.statusText.text = "Not enrolled yet — enroll first."
            return
        }
        binding.statusText.text = "Checking..."
        Thread {
            val text = try {
                apiClient.sendDeviceMessage(deviceId, tenantId, ownerId, keyManager, DeviceAgentPayload.connect())
                val status = apiClient.sendDeviceMessage(deviceId, tenantId, ownerId, keyManager, DeviceAgentPayload.status())
                "Connected. Server reports: ${status.optJSONObject("result")}"
            } catch (e: NagexApiClient.ApiException) {
                if (e.code == "DEVICE_TRANSPORT_REJECTED") {
                    "Device is not connected — it may be revoked or unenrolled. (${e.message})"
                } else {
                    "Server error: ${e.message}"
                }
            } catch (e: Exception) {
                "Could not reach server: ${e.message}"
            }
            mainHandler.post { binding.statusText.text = text }
        }.start()
    }
}
