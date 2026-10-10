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
interface DeviceEnrollmentApi {
    fun validateDeviceBinding(deviceId: String, publicKeyPem: String): NagexApiClient.DeviceBindingValidationResult
    fun enroll(publicKeyPem: String, agentVersion: String, capabilityInventory: List<String>): NagexApiClient.EnrollResult
}

class NagexApiClient(private val config: NagexServerConfig) : DeviceEnrollmentApi {

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

    /** R23.6M Phase B4 — /enroll specifically requires a real, validated
     * session (Authorization: Bearer <sessionToken>), never the
     * x-nagex-tenant/x-principal-id headers [authenticatedRequestBuilder]
     * uses for every other Phase B call. See device-agent.routes.ts's
     * header comment for why: those headers are trivially spoofable and
     * the server no longer accepts them for enrollment. */
    private fun sessionAuthenticatedRequestBuilder(path: String): Request.Builder {
        val sessionToken = config.sessionToken
            ?: throw IllegalStateException("No session token is configured — sign in and enter a session token before enrolling.")
        return Request.Builder()
            .url(config.serverBaseUrl + path)
            .header("Authorization", "Bearer $sessionToken")
            .header("x-request-id", "req_android_${UUID.randomUUID()}")
    }

    private fun execute(request: Request): JSONObject {
        http.newCall(request).execute().use { response ->
            val bodyString = response.body?.string().orEmpty()
            val parsed = if (bodyString.isNotBlank()) JSONObject(bodyString) else JSONObject()
            if (!response.isSuccessful) {
                val error = parsed.optJSONObject("error")
                val code = error?.optString("code", null) ?: parsed.optString("code", null)
                val message = error?.optString("message", null)
                    ?: parsed.optString("message", "NAgex server request failed (${response.code}).")
                throw ApiException(response.code, code, message)
            }
            return parsed
        }
    }

    data class EnrollResult(val deviceId: String, val status: String, val tenantId: String, val ownerId: String)
    data class DeviceBindingValidationResult(val deviceId: String, val status: String, val tenantId: String, val ownerId: String)

    override fun validateDeviceBinding(deviceId: String, publicKeyPem: String): DeviceBindingValidationResult {
        val body = JSONObject()
            .put("deviceId", deviceId)
            .put("publicKey", publicKeyPem)
        val request = sessionAuthenticatedRequestBuilder("/api/v1/device-agent/devices/$deviceId/validate")
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()
        val result = execute(request)
        return DeviceBindingValidationResult(
            deviceId = result.getString("deviceId"),
            status = result.getString("status"),
            tenantId = result.getString("tenantId"),
            ownerId = result.getString("ownerId"),
        )
    }

    /** Calls POST /api/v1/device-agent/enroll — the one place a
     * DeviceIdentityRecord is created (src/http/routes/device-agent.routes.ts).
     * tenantId/ownerId in the response are the server's own, session-derived
     * values — never something this client asserted. */
    override fun enroll(publicKeyPem: String, agentVersion: String, capabilityInventory: List<String>): EnrollResult {
        val body = JSONObject()
            .put("publicKey", publicKeyPem)
            .put("agentVersion", agentVersion)
            .put("capabilityInventory", JSONArray(capabilityInventory))
        val request = sessionAuthenticatedRequestBuilder("/api/v1/device-agent/enroll")
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()
        val result = execute(request)
        return EnrollResult(
            deviceId = result.getString("deviceId"),
            status = result.getString("status"),
            tenantId = result.getString("tenantId"),
            ownerId = result.getString("ownerId"),
        )
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
        val matchKind: String?,
        val similarity: Double?,
        val confirmationRequired: Boolean,
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
        val request = sessionAuthenticatedRequestBuilder("/api/v1/mobile/contacts/resolve")
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
            matchKind = result.optString("matchKind", null),
            similarity = if (result.has("similarity")) result.optDouble("similarity") else null,
            confirmationRequired = result.optBoolean("confirmationRequired", false),
        )
    }

    data class MobileMessageRun(
        val runId: String,
        val status: String,
        val failureReason: String?,
        val approvalId: String?,
        val executionId: String?,
        val message: String,
    )

    private fun parseRun(result: JSONObject): MobileMessageRun = MobileMessageRun(
        runId = result.getString("runId"),
        status = result.getString("status"),
        failureReason = result.optString("failureReason", null),
        approvalId = result.optString("approvalId", null),
        executionId = result.optString("executionId", null),
        message = result.getString("message"),
    )

    /** Calls POST /api/v1/mobile/messages — session-authenticated, per the
     * R23.6M Phase C directive that every new mobile endpoint use validated
     * session identity, not the spoofable x-nagex-tenant/x-principal-id
     * headers. Creates the immutable (until edited) draft; never sends
     * anything by itself. */
    fun createMessage(deviceId: String, recipientRef: String, message: String, preferredChannel: String? = null): MobileMessageRun {
        val body = JSONObject().put("deviceId", deviceId).put("recipientRef", recipientRef).put("message", message)
        if (preferredChannel != null) body.put("preferredChannel", preferredChannel)
        val request = sessionAuthenticatedRequestBuilder("/api/v1/mobile/messages")
            .post(body.toString().toRequestBody(jsonMediaType))
            .build()
        return parseRun(execute(request))
    }

    fun requestMessageApproval(runId: String): MobileMessageRun {
        val request = sessionAuthenticatedRequestBuilder("/api/v1/mobile/messages/$runId/request-approval")
            .post("{}".toRequestBody(jsonMediaType))
            .build()
        return parseRun(execute(request))
    }

    fun getMessage(runId: String): MobileMessageRun {
        val request = sessionAuthenticatedRequestBuilder("/api/v1/mobile/messages/$runId")
            .get()
            .build()
        return parseRun(execute(request))
    }

    /** Calls the existing, unchanged POST /api/v1/approvals/:id/approve —
     * the SAME real human-approval endpoint every other consequential
     * NAgex action (including the R23.6E Gmail send) goes through. This
     * app never invents a parallel approval mechanism.
     *
     * Deliberately uses [authenticatedRequestBuilder] (x-nagex-tenant/
     * x-principal-id headers), NOT [sessionAuthenticatedRequestBuilder] —
     * approvals.routes.ts was not touched by R23.6M (it is REUSED, not
     * new) and still resolves tenantId/principal from those headers at
     * the composition-root/handleApiRequest level, not from a session.
     * This is the same pre-existing, disclosed, out-of-scope header-trust
     * gap Phase B4's audit found everywhere except /enroll — calling this
     * one specific existing route the way it actually authenticates today
     * is not a new weakening, just an honest reflection of it. */
    fun approveMessage(approvalId: String) {
        val request = authenticatedRequestBuilder("/api/v1/approvals/$approvalId/approve")
            .post("{}".toRequestBody(jsonMediaType))
            .build()
        execute(request)
    }

    fun rejectMessage(approvalId: String) {
        val request = authenticatedRequestBuilder("/api/v1/approvals/$approvalId/reject")
            .post("{}".toRequestBody(jsonMediaType))
            .build()
        execute(request)
    }
}
