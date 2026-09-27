package com.nagex.mobile

import java.security.MessageDigest

/**
 * R23.6M Phase B1 — builds the exact wire JSON for a
 * DeviceAgentCommandPayload (device-agent-protocol.ts:
 * `{commandType, executionSessionId, data}`, in that field order) and its
 * sha256 hash, from the SAME string — never two separately-constructed
 * representations that could drift apart. Phase B only ever sends CONNECT
 * and HEARTBEAT; STATUS is included as a low-risk read that's useful for
 * the diagnostic screen. No mobile-message command type exists yet
 * (deferred to Phase C, per the R23.6M directive).
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
}
