package com.nagex.mobile

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * R23.6M Phase C — structural certification that no server-facing wire
 * shape (device-agent command payload, or the MobileMessageRun the HTTP
 * API returns) ever requires or carries a phone number field. The server
 * genuinely cannot supply a phone number, since it never has one
 * (PhoneNumberResolver is the only class that reads one, and it never
 * leaves the device) — this test locks that structural absence in place
 * so a future change can't accidentally add one.
 */
class MobileMessagePhoneNumberAbsenceTest {

    private val phoneNumberKeys = listOf("phoneNumber", "phone", "msisdn", "number", "contactNumber")

    @Test
    fun `none of the mobile-message device-agent command payloads contain a phone-number field`() {
        val builds = listOf(
            DeviceAgentPayload.mobileMessagePrepare("run_1"),
            DeviceAgentPayload.mobileMessageExecute("run_1"),
            DeviceAgentPayload.mobileMessageStatus("run_1", "SENT_CONFIRMED"),
            DeviceAgentPayload.mobileMessageDeliveryConfirmed("run_1"),
        )
        for (built in builds) {
            val json = JSONObject(built.json)
            val data = json.getJSONObject("data")
            for (key in phoneNumberKeys) {
                assertFalse("${built.json} unexpectedly contains key $key", data.has(key))
            }
        }
    }

    @Test
    fun `MobileMessageRun, the HTTP response shape the server returns, has no phone-number field at all`() {
        // Structural: MobileMessageRun's declared properties are runId,
        // status, failureReason, approvalId, executionId, message — there
        // is no phoneNumber constructor parameter for the server to ever
        // populate, so this is enforced at compile time. This test exists
        // to make that guarantee explicit and to fail loudly (a compile
        // error) if a future edit ever adds one.
        val run = NagexApiClient.MobileMessageRun(
            runId = "run_1",
            status = "APPROVED",
            failureReason = null,
            approvalId = "appr_1",
            executionId = null,
            message = "hello",
        )
        val declaredFields = run::class.java.declaredFields.map { it.name }
        for (key in phoneNumberKeys) {
            assertFalse("MobileMessageRun unexpectedly declares field $key", declaredFields.any { it.equals(key, ignoreCase = true) })
        }
    }
}
