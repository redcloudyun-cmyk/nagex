package com.nagex.mobile

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DeviceEnrollmentManagerStaleBindingTest {
    private lateinit var config: NagexServerConfig
    private lateinit var keyProvider: FakeKeyProvider
    private lateinit var api: FakeEnrollmentApi
    private lateinit var manager: DeviceEnrollmentManager

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        config = NagexServerConfig(context)
        config.serverBaseUrl = "https://nagex-test.example"
        config.clearStaleEnrollmentBindingPreservingDeviceKey()
        keyProvider = FakeKeyProvider()
        api = FakeEnrollmentApi()
        manager = DeviceEnrollmentManager(config, keyProvider, api)
    }

    @Test
    fun `localDeviceId absent performs normal enrollment`() {
        api.nextEnroll = NagexApiClient.EnrollResult("dev_fresh", "ACTIVE", "ten_session", "usr_session")

        val outcome = manager.ensureEnrolled()

        assertTrue(outcome is DeviceEnrollmentManager.EnrollmentOutcome.Enrolled)
        assertEquals("dev_fresh", config.deviceId)
        assertEquals(0, api.validateCalls)
        assertEquals(1, api.enrollCalls)
    }

    @Test
    fun `localDeviceId active owned validates without duplicate enrollment`() {
        config.deviceId = "dev_existing"
        config.deviceStatus = "ACTIVE"
        api.nextValidation = NagexApiClient.DeviceBindingValidationResult("dev_existing", "ACTIVE", "ten_session", "usr_session")

        val outcome = manager.ensureEnrolled()

        assertTrue(outcome is DeviceEnrollmentManager.EnrollmentOutcome.AlreadyEnrolled)
        assertEquals("dev_existing", config.deviceId)
        assertEquals(1, api.validateCalls)
        assertEquals(0, api.enrollCalls)
    }

    @Test
    fun `localDeviceId not found clears stale metadata preserves key and enrolls fresh`() {
        config.deviceId = "dev_stale"
        config.deviceStatus = "ACTIVE"
        config.tenantId = "ten_old"
        config.principalId = "usr_old"
        val beforeKey = keyProvider.publicKeyPem()
        api.validationFailure = NagexApiClient.ApiException(404, "DEVICE_BINDING_NOT_FOUND", "missing")
        api.nextEnroll = NagexApiClient.EnrollResult("dev_new", "ACTIVE", "ten_session", "usr_session")

        val outcome = manager.ensureEnrolled()

        assertTrue(outcome is DeviceEnrollmentManager.EnrollmentOutcome.StaleBindingRecovered)
        assertEquals("dev_new", config.deviceId)
        assertEquals("ten_session", config.tenantId)
        assertEquals("usr_session", config.principalId)
        assertEquals(beforeKey, keyProvider.publicKeyPem())
        assertEquals(1, api.validateCalls)
        assertEquals(1, api.enrollCalls)
        assertFalse(api.lastEnrollBodyContains("dev_stale"))
    }

    @Test
    fun `ownership failure preserves local state`() {
        config.deviceId = "dev_foreign"
        config.deviceStatus = "ACTIVE"
        config.tenantId = "ten_old"
        config.principalId = "usr_old"
        api.validationFailure = NagexApiClient.ApiException(403, "DEVICE_BINDING_NOT_AUTHORIZED", "forbidden")

        val outcome = manager.ensureEnrolled()

        assertTrue(outcome is DeviceEnrollmentManager.EnrollmentOutcome.Failed)
        assertEquals("dev_foreign", config.deviceId)
        assertEquals("ten_old", config.tenantId)
        assertEquals("usr_old", config.principalId)
        assertEquals(1, api.validateCalls)
        assertEquals(0, api.enrollCalls)
    }

    @Test
    fun `auth failure preserves local state`() {
        config.deviceId = "dev_existing"
        config.tenantId = "ten_old"
        config.principalId = "usr_old"
        api.validationFailure = NagexApiClient.ApiException(401, "DEVICE_VALIDATE_AUTH_REQUIRED", "auth")

        val outcome = manager.ensureEnrolled()

        assertTrue(outcome is DeviceEnrollmentManager.EnrollmentOutcome.Failed)
        assertEquals("dev_existing", config.deviceId)
        assertEquals("ten_old", config.tenantId)
        assertEquals("usr_old", config.principalId)
        assertEquals(0, api.enrollCalls)
    }

    @Test
    fun `network failure preserves local state`() {
        config.deviceId = "dev_existing"
        config.tenantId = "ten_old"
        config.principalId = "usr_old"
        api.validationRuntimeFailure = RuntimeException("network down")

        val outcome = manager.ensureEnrolled()

        assertTrue(outcome is DeviceEnrollmentManager.EnrollmentOutcome.Failed)
        assertEquals("dev_existing", config.deviceId)
        assertEquals("ten_old", config.tenantId)
        assertEquals("usr_old", config.principalId)
        assertEquals(0, api.enrollCalls)
    }

    @Test
    fun `safe reset preserves key and unrelated preferences`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val unrelated = context.getSharedPreferences("nagex_server_config", android.content.Context.MODE_PRIVATE)
        unrelated.edit().putString("voice_mode", "push_to_talk").apply()
        config.deviceId = "dev_stale"
        config.tenantId = "ten_old"
        val beforeKey = keyProvider.publicKeyPem()

        config.clearStaleEnrollmentBindingPreservingDeviceKey()

        assertNull(config.deviceId)
        assertNull(config.tenantId)
        assertEquals(beforeKey, keyProvider.publicKeyPem())
        assertEquals("push_to_talk", unrelated.getString("voice_mode", null))
        assertEquals("https://nagex-test.example", config.serverBaseUrl)
    }

    @Test
    fun `fresh enrollment stores server returned id only`() {
        config.deviceId = "dev_stale"
        api.validationFailure = NagexApiClient.ApiException(404, "DEVICE_BINDING_NOT_FOUND", "missing")
        api.nextEnroll = NagexApiClient.EnrollResult("dev_returned", "ACTIVE", "ten_session", "usr_session")

        manager.ensureEnrolled()

        assertNotEquals("dev_stale", config.deviceId)
        assertEquals("dev_returned", config.deviceId)
    }

    private class FakeKeyProvider : DeviceKeyProvider {
        private val key = "-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----\n"
        var ensureCalls = 0
        override fun ensureKeyPairExists() {
            ensureCalls += 1
        }
        override fun publicKeyPem(): String = key
    }

    private class FakeEnrollmentApi : DeviceEnrollmentApi {
        var validateCalls = 0
        var enrollCalls = 0
        var nextValidation = NagexApiClient.DeviceBindingValidationResult("dev_existing", "ACTIVE", "ten_session", "usr_session")
        var nextEnroll = NagexApiClient.EnrollResult("dev_fresh", "ACTIVE", "ten_session", "usr_session")
        var validationFailure: NagexApiClient.ApiException? = null
        var validationRuntimeFailure: RuntimeException? = null
        private var lastEnrollPublicKey: String = ""

        override fun validateDeviceBinding(deviceId: String, publicKeyPem: String): NagexApiClient.DeviceBindingValidationResult {
            validateCalls += 1
            validationRuntimeFailure?.let { throw it }
            validationFailure?.let { throw it }
            return nextValidation
        }

        override fun enroll(publicKeyPem: String, agentVersion: String, capabilityInventory: List<String>): NagexApiClient.EnrollResult {
            enrollCalls += 1
            lastEnrollPublicKey = publicKeyPem
            return nextEnroll
        }

        fun lastEnrollBodyContains(value: String): Boolean = lastEnrollPublicKey.contains(value)
    }
}
