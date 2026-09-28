package com.nagex.mobile

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * R23.6M Phase B1/B4 — configurable NAgex server URL and this device's
 * identity/session state.
 *
 * Phase B4 security-audit fix: enrollment no longer uses the
 * x-nagex-tenant/x-principal-id headers (trivially spoofable — see
 * device-agent.routes.ts's own updated header comment). The server now
 * requires a real, validated session (`Authorization: Bearer <sessionId>`,
 * checked against SessionStore.getSession()) for /enroll specifically.
 * [sessionToken] is that bearer credential — it grants real API access as
 * the signed-in user, so unlike the other fields here it is stored in
 * Jetpack Security's EncryptedSharedPreferences, not plain prefs.
 *
 * Known Phase B limitation: there is no in-app login flow yet. The user
 * must obtain a session token from an existing authenticated NAgex web
 * session (e.g. the `nagex_session` cookie value, or a token from
 * `POST /api/v1/auth/login`) and enter it here manually. A real mobile
 * login/QR-pairing flow is a reasonable Phase C+ improvement, not
 * implemented now.
 */
class NagexServerConfig(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("nagex_server_config", Context.MODE_PRIVATE)

    // Lazy — EncryptedSharedPreferences requires a real, working
    // AndroidKeyStore, which normal config reads/writes (serverBaseUrl,
    // deviceId, etc.) have no need to depend on. Deferring construction
    // until sessionToken is actually touched keeps every other property
    // usable in contexts without a real keystore (this codebase's own
    // Robolectric unit tests included) without weakening how the token
    // itself is stored once it is.
    private val encryptedPrefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "nagex_server_config_secure",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    var serverBaseUrl: String
        get() = prefs.getString(KEY_SERVER_BASE_URL, DEFAULT_SERVER_BASE_URL) ?: DEFAULT_SERVER_BASE_URL
        set(value) = prefs.edit().putString(KEY_SERVER_BASE_URL, value.trimEnd('/')).apply()

    /** The real, server-issued session credential — required for
     * enrollment. Never a client-chosen tenant/principal string. */
    var sessionToken: String?
        get() = encryptedPrefs.getString(KEY_SESSION_TOKEN, null)
        set(value) = encryptedPrefs.edit().putString(KEY_SESSION_TOKEN, value).apply()

    /** Informational only, populated FROM the enrollment response after a
     * successful enroll — never sent as an auth header themselves. Used
     * only to label which tenant/user this device is currently enrolled
     * under, for the status screen. */
    var tenantId: String?
        get() = prefs.getString(KEY_TENANT_ID, null)
        set(value) = prefs.edit().putString(KEY_TENANT_ID, value).apply()

    var principalId: String?
        get() = prefs.getString(KEY_PRINCIPAL_ID, null)
        set(value) = prefs.edit().putString(KEY_PRINCIPAL_ID, value).apply()

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value).apply()

    var deviceStatus: String?
        get() = prefs.getString(KEY_DEVICE_STATUS, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_STATUS, value).apply()

    val isEnrolled: Boolean
        get() = !deviceId.isNullOrBlank()

    companion object {
        private const val KEY_SERVER_BASE_URL = "server_base_url"
        private const val KEY_SESSION_TOKEN = "session_token"
        private const val KEY_TENANT_ID = "tenant_id"
        private const val KEY_PRINCIPAL_ID = "principal_id"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_DEVICE_STATUS = "device_status"

        // Placeholder default — every real deployment must set its own via
        // the status screen before enrollment; this is never a live
        // production NAgex URL.
        private const val DEFAULT_SERVER_BASE_URL = "https://your-nagex-server.example"
    }
}
