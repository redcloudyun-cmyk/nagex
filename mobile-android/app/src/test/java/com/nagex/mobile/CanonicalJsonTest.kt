package com.nagex.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Certifies CanonicalJson produces byte-identical output to the server's
 * canonicalEnvelopeSigningBytes() (device-transport-security.ts) for a
 * fixed, hand-computed example — the exact contract a signature over
 * mismatched bytes would silently break.
 */
class CanonicalJsonTest {

    @Test
    fun `escapeString matches JSON_stringify quoting for a plain string`() {
        assertEquals("\"hello\"", CanonicalJson.escapeString("hello"))
    }

    @Test
    fun `escapeString escapes quotes and backslashes`() {
        assertEquals("\"a\\\"b\\\\c\"", CanonicalJson.escapeString("a\"b\\c"))
    }

    @Test
    fun `escapeString escapes control characters`() {
        assertEquals("\"a\\nb\"", CanonicalJson.escapeString("a\nb"))
        assertEquals("\"a\\tb\"", CanonicalJson.escapeString("a\tb"))
    }

    @Test
    fun `canonicalEnvelopeSigningString matches the exact field order and format canonicalEnvelopeSigningBytes produces`() {
        val actual = CanonicalJson.canonicalEnvelopeSigningString(
            deviceId = "dev_1",
            tenantId = "ten_a",
            ownerId = "usr_a",
            messageId = "msg_1",
            sequence = 42L,
            issuedAt = "2026-09-27T00:00:00.000Z",
            expiresAt = "2026-09-27T00:01:00.000Z",
            payloadHash = "abc123",
        )
        // This exact string is what
        // `JSON.stringify({deviceId, tenantId, ownerId, messageId, sequence, issuedAt, expiresAt, payloadHash})`
        // produces on the server for the same field values, in the same
        // field order — the entire point of this test.
        val expected = "{\"deviceId\":\"dev_1\",\"tenantId\":\"ten_a\",\"ownerId\":\"usr_a\",\"messageId\":\"msg_1\",\"sequence\":42,\"issuedAt\":\"2026-09-27T00:00:00.000Z\",\"expiresAt\":\"2026-09-27T00:01:00.000Z\",\"payloadHash\":\"abc123\"}"
        assertEquals(expected, actual)
    }
}
