package com.nagex.mobile

/**
 * R23.6M Phase B1 — byte-for-byte mirror of the server's
 * `canonicalEnvelopeSigningBytes()` (src/device-agent/device-transport-security.ts),
 * which signs `JSON.stringify({deviceId, tenantId, ownerId, messageId,
 * sequence, issuedAt, expiresAt, payloadHash})` in exactly that field
 * order. A generic JSON library (including org.json.JSONObject, whose
 * insertion-order guarantees are not a documented contract) is
 * deliberately NOT used here — a single reordered field, or a single
 * differently-escaped character, produces a signature the server's
 * DeviceTransportSecurity.verify() will reject, so this hand-written,
 * order-exact, escaping-exact builder is the one correct way to reproduce
 * Node's JSON.stringify output for this specific fixed shape.
 */
object CanonicalJson {

    /** Escapes a string exactly as JSON.stringify does: quote, backslash,
     * and control characters below 0x20 (with the standard short escapes
     * for \b \f \n \r \t, \uXXXX for the rest). */
    fun escapeString(value: String): String {
        val sb = StringBuilder(value.length + 2)
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (ch.code < 0x20) {
                    sb.append("\\u").append(String.format("%04x", ch.code))
                } else {
                    sb.append(ch)
                }
            }
        }
        sb.append('"')
        return sb.toString()
    }

    /** The exact envelope signing-bytes shape, field order matching
     * canonicalEnvelopeSigningBytes() precisely. `sequence` is written as a
     * bare integer literal, matching how a JS number serializes. */
    fun canonicalEnvelopeSigningString(
        deviceId: String,
        tenantId: String,
        ownerId: String,
        messageId: String,
        sequence: Long,
        issuedAt: String,
        expiresAt: String,
        payloadHash: String,
    ): String {
        return "{" +
            "\"deviceId\":${escapeString(deviceId)}," +
            "\"tenantId\":${escapeString(tenantId)}," +
            "\"ownerId\":${escapeString(ownerId)}," +
            "\"messageId\":${escapeString(messageId)}," +
            "\"sequence\":$sequence," +
            "\"issuedAt\":${escapeString(issuedAt)}," +
            "\"expiresAt\":${escapeString(expiresAt)}," +
            "\"payloadHash\":${escapeString(payloadHash)}" +
            "}"
    }
}
