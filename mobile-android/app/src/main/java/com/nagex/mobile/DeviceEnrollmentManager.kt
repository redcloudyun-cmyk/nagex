package com.nagex.mobile

import android.os.Build
import android.provider.Settings

/**
 * R23.6M Phase B1 - orchestrates the enroll-once flow: ensure a local
 * keypair exists, call the server's /enroll route, persist the returned
 * deviceId. A cached local deviceId is treated as a binding that must be
 * validated against the authenticated active runtime before it is trusted.
 */
class DeviceEnrollmentManager(
    private val config: NagexServerConfig,
    private val keyManager: DeviceKeyProvider,
    private val apiClient: DeviceEnrollmentApi,
) {
    companion object {
        const val AGENT_VERSION = "0.1.0-r23.6m-phase-m4c"

        fun capabilities(context: android.content.Context): List<String> {
            val accessibility = accessibilityState(context)
            return listOf(
                "VOICE_CAPTURE",
                "CONTACT_READ",
                "SMS_SEND",
                "DEEP_LINK_OPEN",
                "ANDROID_ACCESSIBILITY",
                "permission:ACCESSIBILITY_SERVICE:$accessibility",
            )
        }

        fun accessibilityState(context: android.content.Context): String {
            val enabled = Settings.Secure.getInt(context.contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1
            if (!enabled) return "DISABLED"
            val services = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return "DISABLED"
            val canonical = "${context.packageName}/com.nagex.mobile.NagexAccessibilityExecutionService"
            val shorthand = "${context.packageName}/.NagexAccessibilityExecutionService"
            return if (services.split(':').any { it == canonical || it == shorthand }) "ENABLED" else "DISABLED"
        }
    }

    sealed class EnrollmentOutcome {
        data class AlreadyEnrolled(val deviceId: String, val status: String?) : EnrollmentOutcome()
        data class Enrolled(val deviceId: String, val status: String) : EnrollmentOutcome()
        data class StaleBindingRecovered(val oldDeviceId: String, val newDeviceId: String, val status: String) : EnrollmentOutcome()
        data class Failed(val message: String) : EnrollmentOutcome()
    }

    /** Blocking - call from a background thread. */
    fun ensureEnrolled(): EnrollmentOutcome {
        keyManager.ensureKeyPairExists()
        val existingDeviceId = config.deviceId
        if (existingDeviceId != null) {
            val publicKey = keyManager.publicKeyPem()
            try {
                val validation = apiClient.validateDeviceBinding(existingDeviceId, publicKey)
                config.deviceStatus = validation.status
                config.tenantId = validation.tenantId
                config.principalId = validation.ownerId
                return EnrollmentOutcome.AlreadyEnrolled(existingDeviceId, validation.status)
            } catch (e: NagexApiClient.ApiException) {
                if (e.httpStatus == 404 || e.code == "DEVICE_BINDING_NOT_FOUND") {
                    config.clearStaleEnrollmentBindingPreservingDeviceKey()
                    return enrollFresh(publicKey, staleDeviceId = existingDeviceId)
                }
                return EnrollmentOutcome.Failed(e.message ?: "Enrollment validation failed.")
            } catch (e: Exception) {
                return EnrollmentOutcome.Failed(e.message ?: "Enrollment validation failed.")
            }
        }
        return enrollFresh(keyManager.publicKeyPem(), staleDeviceId = null)
    }

    private fun enrollFresh(publicKeyPem: String, staleDeviceId: String?): EnrollmentOutcome {
        return try {
            val agentVersion = "$AGENT_VERSION (Android ${Build.VERSION.RELEASE})"
            val result = apiClient.enroll(publicKeyPem, agentVersion, capabilities(config.context))
            config.deviceId = result.deviceId
            config.deviceStatus = result.status
            config.tenantId = result.tenantId
            config.principalId = result.ownerId
            if (staleDeviceId == null) {
                EnrollmentOutcome.Enrolled(result.deviceId, result.status)
            } else {
                EnrollmentOutcome.StaleBindingRecovered(staleDeviceId, result.deviceId, result.status)
            }
        } catch (e: Exception) {
            EnrollmentOutcome.Failed(e.message ?: "Enrollment failed for an unknown reason.")
        }
    }
}
