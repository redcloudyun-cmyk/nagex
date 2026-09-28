package com.nagex.mobile

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/**
 * R23.6M Phase C.5B-P0 — the Quick Settings Tile invocation route
 * (Section 4D of the C.5A audit). Deliberately does NOT start a
 * microphone foreground service from onClick() — that path is not a
 * documented while-in-use-permission exemption and is reported as
 * unreliable on current Android versions. Instead it uses the officially
 * supported startActivityAndCollapse(), bringing VoiceInvokeActivity (the
 * one exported trampoline) into the foreground; that Activity then does
 * the existing, ordinary in-Activity SpeechRecognizer capture, which
 * needs no foreground-service type or permission at all.
 */
class NagexQuickTileService : TileService() {

    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            label = getString(R.string.quick_tile_label)
            icon = Icon.createWithResource(this@NagexQuickTileService, R.drawable.ic_nagex_mic)
            state = Tile.STATE_INACTIVE
            updateTile()
        }
    }

    // The deprecated Intent overload below is reached only on devices
    // actually running an OS older than UpsideDownCake (34) — where the
    // PendingIntent overload lint wants instead does not exist in the
    // framework at all and would throw NoSuchMethodError if called. Lint's
    // StartActivityAndCollapseDeprecated check flags the mere presence of
    // the deprecated call site regardless of this SDK_INT guard, so it is
    // suppressed here specifically, not the Kotlin-level @Deprecated
    // warning already handled inline. Both branches reach the identical
    // destination (VoiceInvokeActivity) — this is a runtime-OS
    // compatibility shim, not a design difference between the two routes.
    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        super.onClick()
        val intent = Intent(this, VoiceInvokeActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val pendingIntent = PendingIntent.getActivity(
                this, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            startActivityAndCollapse(pendingIntent)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
