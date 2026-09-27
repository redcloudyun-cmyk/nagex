package com.nagex.mobile

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * R23.6M Phase B1/B3 — the authenticated HTTPS client of the NAgex server.
 *
 * Every call is a blocking OkHttp request — callers (Activities) are
 * responsible for invoking these off the main thread. No coroutines/RxJava
 * dependency is added for this; a plain background Thread is enough for a
 * Phase B foundation slice, per the "do not build a large mobile design
 * system" directive.
 */
class NagexApiClient(private val config: NagexServerConfig) {

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    class ApiException(val httpStatus: Int, val code: String?, message: String) : Exception(message)

    private fun authenticatedRequestBuilder(path: String): Request.Builder {
        val tenantId = config.tenantId ?: throw IllegalStateException("tenantId is not configured yet.")
        val principalId = config.principalId ?: throw IllegalStateException("principalId is not configured yet.")
        return Request.Builder()
            .url(config.serverBaseUrl + path)
            .header("x-nagex-tenant", tenantId)
            .header("x-principal-id", principalId)
            .header("x-request-id", "req_android_${UUID.randomUUID()}")
    }

    private fun execute(request: Request): JSONObject {
        http.newCall(request).execute().use { response ->
            val bodyString = response.body?.string().orEmpty()
            val parsed = if (bodyString.isNotBlank()) JSONObject(bodyString) else JSONObject()
            if (!response.isSuccessful) {
                val code = parsed.optString("code", null)
                val message = parsed.optString("message", "NAgex server request failed (${response.code}).")
                throw ApiException(response.code, code, message)
            }
            return parsed
        }
    }

    data class EnrollResult(val deviceId: String, val status: String)

    /** Calls POST /api/v1/device-agent/enroll — the one place a
     * DeviceIdentityRecord is created (src/http/routes/device-agent.routes.ts). */
    fun enroll(publicKeyPem: String, agentVersion: String, capabilityInventory: List<String>): EnrollResult {
        val body = JSONObject()
            .put("publicKey", publicKeyPem)
            .put("agentVersion", agentVersion)
            .put("capabilityInventory", JSONArray(capabilityInventory))
        val request = authenticatedRequestBuilder("/api/v1/device-agent/enroll")
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()
        val result = execute(request)
        return EnrollResult(result.getString("deviceId"), result.getString("status"))
    }

    /** Calls POST /api/v1/device-agent/message with a signed envelope —
     * used for CONNECT/HEARTBEAT/STATUS in Phase B. The outer body is
     * assembled manually (not via JSONObject for the `payload` field) so
     * the exact bytes sent for `payload` are guaranteed identical to the
     * exact bytes hashed into the envelope's payloadHash — see
     * DeviceAgentPayload's own header comment for why this matters. */
    fun sendDeviceMessage(deviceId: String, tenantId: String, ownerId: String, keyManager: DeviceKeyManager, built: DeviceAgentPayload.Built): JSONObject {
        val messageId = "msg_android_${UUID.randomUUID()}"
        val sequence = System.currentTimeMillis()
        val issuedAt = java.time.Instant.now().toString()
        val expiresAt = java.time.Instant.now().plusSeconds(60).toString()

        val signingString = CanonicalJson.canonicalEnvelopeSigningString(
            deviceId = deviceId,
            tenantId = tenantId,
            ownerId = ownerId,
            messageId = messageId,
            sequence = sequence,
            issuedAt = issuedAt,
            expiresAt = expiresAt,
            payloadHash = built.sha256Hex,
        )
        val signature = keyManager.signEnvelopeBytes(signingString.toByteArray(Charsets.UTF_8))

        val envelopeJson = JSONObject()
            .put("deviceId", deviceId)
            .put("tenantId", tenantId)
            .put("ownerId", ownerId)
            .put("messageId", messageId)
            .put("sequence", sequence)
            .put("issuedAt", issuedAt)
            .put("expiresAt", expiresAt)
            .put("payloadHash", built.sha256Hex)
            .put("signature", signature)

        // Manually spliced so `payload` is exactly `built.json`, byte for
        // byte — never re-encoded through JSONObject, which could
        // otherwise reorder or re-escape it differently than what was
        // hashed.
        val outerBody = "{\"envelope\":$envelopeJson,\"payload\":${built.json}}"

        val request = Request.Builder()
            .url(config.serverBaseUrl + "/api/v1/device-agent/message")
            .header("x-request-id", "req_android_${UUID.randomUUID()}")
            .post(outerBody.toRequestBody(jsonMediaType))
            .build()
        return execute(request)
    }

    data class ContactCandidateDto(val contactId: String, val displayName: String)

    data class ContactResolutionResponse(
        val status: String,
        val recipientRef: String?,
        val displayName: String?,
        val candidates: List<ContactCandidateDto>,
    )

    /** Calls POST /api/v1/mobile/contacts/resolve. Never sends a phone
     * number — only contactId (device-local, opaque) + displayName, per
     * the Contact Resolution privacy boundary. */
    fun resolveContacts(deviceId: String, spokenName: String, candidates: List<ContactCandidateDto>): ContactResolutionResponse {
        val candidatesJson = JSONArray()
        for (c in candidates) {
            candidatesJson.put(JSONObject().put("contactId", c.contactId).put("displayName", c.displayName))
        }
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("spokenName", spokenName)
            .put("candidates", candidatesJson)
        val request = authenticatedRequestBuilder("/api/v1/mobile/contacts/resolve")
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()
        val result = execute(request)
        val outCandidates = mutableListOf<ContactCandidateDto>()
        result.optJSONArray("candidates")?.let { arr ->
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                outCandidates.add(ContactCandidateDto(obj.getString("contactId"), obj.getString("displayName")))
            }
        }
        return ContactResolutionResponse(
            status = result.getString("status"),
            recipientRef = result.optString("recipientRef", null),
            displayName = result.optString("displayName", null),
            candidates = outCandidates,
        )
    }
}
