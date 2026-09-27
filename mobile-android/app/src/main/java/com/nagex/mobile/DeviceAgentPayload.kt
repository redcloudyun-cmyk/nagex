package com.nagex.mobile

import java.security.MessageDigest

/**
 * R23.6M Phase B1/C — builds the exact wire JSON for a
 * DeviceAgentCommandPayload (device-agent-protocol.ts:
 * `{commandType, executionSessionId, data}`, in that field order) and its
 * sha256 hash, from the SAME string — never two separately-constructed
 * representations that could drift apart.
 *
 * Phase C adds exactly the three mobile-message builders
 * (mobileMessagePrepare/mobileMessageExecute/mobileMessageStatus) — never
 * a generic command-data builder. Each corresponds to exactly one
 * MobileMessageRunService method server-side.
 */
object DeviceAgentPayload {

    data class Built(val json: String, val sha256Hex: String)

    private fun sha256Hex(input: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }
    }

    fun connect(): Built {
        val json = "{\"commandType\":\"CONNECT\",\"executionSessionId\":null,\"data\":{}}"
        return Built(json, sha256Hex(json))
    }

    fun heartbeat(agentVersion: String, capabilityInventory: List<String>): Built {
        val capabilitiesJson = capabilityInventory.joinToString(",") { CanonicalJson.escapeString(it) }
        val dataJson = "{\"agentVersion\":${CanonicalJson.escapeString(agentVersion)},\"capabilityInventory\":[$capabilitiesJson]}"
        val json = "{\"commandType\":\"HEARTBEAT\",\"executionSessionId\":null,\"data\":$dataJson}"
        return Built(json, sha256Hex(json))
    }

    fun status(): Built {
        val json = "{\"commandType\":\"STATUS\",\"executionSessionId\":null,\"data\":{}}"
        return Built(json, sha256Hex(json))
    }

    /** MOBILE_MESSAGE_PREPARE — read-only: asks the server for the exact
     * approved recipientRef+message for this run. Consumes nothing. */
    fun mobileMessagePrepare(runId: String): Built {
        val dataJson = "{\"runId\":${CanonicalJson.escapeString(runId)}}"
        val json = "{\"commandType\":\"MOBILE_MESSAGE_PREPARE\",\"executionSessionId\":null,\"data\":$dataJson}"
        return Built(json, sha256Hex(json))
    }

    /** MOBILE_MESSAGE_EXECUTE — the one moment the server consumes the
     * approval. A successful response means "you are cleared to call
     * SmsManager now", never that anything has actually been sent yet. */
    fun mobileMessageExecute(runId: String): Built {
        val dataJson = "{\"runId\":${CanonicalJson.escapeString(runId)}}"
        val json = "{\"commandType\":\"MOBILE_MESSAGE_EXECUTE\",\"executionSessionId\":null,\"data\":$dataJson}"
        return Built(json, sha256Hex(json))
    }

    /** MOBILE_MESSAGE_STATUS — the device's own honest report of what
     * SmsManager actually did. [result] must be one of SENT_CONFIRMED /
     * SEND_FAILED / SEND_STATUS_UNKNOWN — never fabricated from the fact
     * that sendTextMessage() didn't throw. */
    fun mobileMessageStatus(runId: String, result: String): Built {
        val dataJson = "{\"runId\":${CanonicalJson.escapeString(runId)},\"result\":${CanonicalJson.escapeString(result)}}"
        val json = "{\"commandType\":\"MOBILE_MESSAGE_STATUS\",\"executionSessionId\":null,\"data\":$dataJson}"
        return Built(json, sha256Hex(json))
    }

    /** A separate STATUS report specifically for the later DELIVERED
     * broadcast, which arrives independently of (and sometimes long after)
     * the SENT result. */
    fun mobileMessageDeliveryConfirmed(runId: String): Built {
        val dataJson = "{\"runId\":${CanonicalJson.escapeString(runId)},\"deliveryConfirmed\":true}"
        val json = "{\"commandType\":\"MOBILE_MESSAGE_STATUS\",\"executionSessionId\":null,\"data\":$dataJson}"
        return Built(json, sha256Hex(json))
    }
}
