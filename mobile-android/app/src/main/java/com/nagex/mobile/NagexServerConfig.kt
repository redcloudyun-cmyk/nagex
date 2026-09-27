package com.nagex.mobile

import android.content.Context
import android.content.SharedPreferences

/**
 * R23.6M Phase B1 — configurable NAgex server URL and the identity/session
 * headers this device has been given. Plain SharedPreferences (not
 * encrypted) — nothing stored here is a secret; the device's own private
 * key lives in [DeviceKeyManager]'s encrypted store instead.
 */
class NagexServerConfig(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("nagex_server_config", Context.MODE_PRIVATE)

    var serverBaseUrl: String
        get() = prefs.getString(KEY_SERVER_BASE_URL, DEFAULT_SERVER_BASE_URL) ?: DEFAULT_SERVER_BASE_URL
        set(value) = prefs.edit().putString(KEY_SERVER_BASE_URL, value.trimEnd('/')).apply()

    /** Set by whatever authenticated NAgex web/app session the user is
     * already signed into on this device — Phase B does not implement a
     * new mobile-specific login flow; it reuses the caller-authenticated
     * tenant/principal header convention every other NAgex HTTP route
     * already uses. */
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
