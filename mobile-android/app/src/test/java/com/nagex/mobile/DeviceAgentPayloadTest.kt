package com.nagex.mobile

import org.junit.Assert.assertEquals
import org.junit.Test
import java.security.MessageDigest

class DeviceAgentPayloadTest {

    private fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    @Test
    fun `connect payload matches DeviceAgentCommandPayload field order`() {
        val built = DeviceAgentPayload.connect()
        assertEquals("{\"commandType\":\"CONNECT\",\"executionSessionId\":null,\"data\":{}}", built.json)
        assertEquals(sha256Hex(built.json), built.sha256Hex)
    }

    @Test
    fun `heartbeat payload embeds agentVersion and capabilityInventory in a fixed order`() {
        val built = DeviceAgentPayload.heartbeat("1.0.0", listOf("MOBILE_VOICE_INPUT", "MOBILE_CONTACT_RESOLUTION"))
        val expectedJson = "{\"commandType\":\"HEARTBEAT\",\"executionSessionId\":null,\"data\":{\"agentVersion\":\"1.0.0\",\"capabilityInventory\":[\"MOBILE_VOICE_INPUT\",\"MOBILE_CONTACT_RESOLUTION\"]}}"
        assertEquals(expectedJson, built.json)
        // The hash is always over the exact same string that is sent — the
        // whole point of building both from one source.
        assertEquals(sha256Hex(built.json), built.sha256Hex)
    }

    @Test
    fun `the hash is always computed over the exact json that will be sent, never a separately-built representation`() {
        val a = DeviceAgentPayload.heartbeat("2.0.0", emptyList())
        val b = DeviceAgentPayload.heartbeat("2.0.0", emptyList())
        assertEquals(a.json, b.json)
        assertEquals(a.sha256Hex, b.sha256Hex)
    }
}
