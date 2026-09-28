package com.nagex.mobile

import android.os.Build

/**
 * R23.6M Phase B1 — orchestrates the enroll-once flow: ensure a local
 * keypair exists, call the server's /enroll route, persist the returned
 * deviceId. Deliberately idempotent and safe to call from app startup
 * every time — it only actually calls the server if this install has
 * never enrolled before.
 */
class DeviceEnrollmentManager(
    private val config: NagexServerConfig,
    private val keyManager: DeviceKeyManager,
    private val apiClient: NagexApiClient,
) {
    companion object {
        const val AGENT_VERSION = "0.1.0-r23.6m-phase-b"

        // Capability tags this device declares — a generic, extensible
        // string list (DeviceIdentityRecord.capabilityInventory), not a new
        // schema field. No mobile-message-execution capability is declared
        // yet — Phase B implements no execution.
        val CAPABILITIES = listOf("MOBILE_VOICE_INPUT", "MOBILE_CONTACT_RESOLUTION")
    }

    sealed class EnrollmentOutcome {
        data class AlreadyEnrolled(val deviceId: String, val status: String?) : EnrollmentOutcome()
        data class Enrolled(val deviceId: String, val status: String) : EnrollmentOutcome()
        data class Failed(val message: String) : EnrollmentOutcome()
    }

    /** Blocking — call from a background thread. */
    fun ensureEnrolled(): EnrollmentOutcome {
        val existingDeviceId = config.deviceId
        if (existingDeviceId != null) {
            return EnrollmentOutcome.AlreadyEnrolled(existingDeviceId, config.deviceStatus)
        }
        return try {
            keyManager.ensureKeyPairExists()
            val agentVersion = "$AGENT_VERSION (Android ${Build.VERSION.RELEASE})"
            val result = apiClient.enroll(keyManager.publicKeyPem(), agentVersion, CAPABILITIES)
            config.deviceId = result.deviceId
            config.deviceStatus = result.status
            // tenantId/ownerId are recorded FROM the server's own
            // session-derived response — this app never asserts them itself.
            config.tenantId = result.tenantId
            config.principalId = result.ownerId
            EnrollmentOutcome.Enrolled(result.deviceId, result.status)
        } catch (e: Exception) {
            EnrollmentOutcome.Failed(e.message ?: "Enrollment failed for an unknown reason.")
        }
    }
}
