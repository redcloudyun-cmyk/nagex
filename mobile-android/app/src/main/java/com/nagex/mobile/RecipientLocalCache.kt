package com.nagex.mobile

import android.content.Context

/**
 * R23.6M Phase C — the device-side half of the recipientRef privacy
 * boundary. The server's RecipientRefStore holds recipientRef ->
 * androidContactId (Phase B3), but the server never has a phone number.
 * Only this device can map androidContactId -> phone number, and only
 * this device remembers which androidContactId a given recipientRef
 * actually corresponds to — populated the moment ContactResolver
 * (server-side) returns a UNIQUE match with a recipientRef.
 *
 * Plain SharedPreferences — an androidContactId is a local, meaningless-
 * outside-this-device integer id, not a secret.
 */
class RecipientLocalCache(context: Context) {
    private val prefs = context.getSharedPreferences("nagex_recipient_local_cache", Context.MODE_PRIVATE)

    fun remember(recipientRef: String, androidContactId: String) {
        prefs.edit().putString(recipientRef, androidContactId).apply()
    }

    fun androidContactIdFor(recipientRef: String): String? = prefs.getString(recipientRef, null)
}
