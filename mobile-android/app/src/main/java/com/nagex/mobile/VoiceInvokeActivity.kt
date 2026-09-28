package com.nagex.mobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * R23.6M Phase C.5B-P0 — the ONLY exported entry point external Android
 * components (home-screen shortcut, widget, notification action, Quick
 * Settings Tile) may target. It never runs any voice/contact/message/
 * approval logic itself — it exists solely so VoiceCommandActivity can
 * stay android:exported="false" (its existing, intentional Phase B/C
 * boundary) while still being reachable from outside this app's own
 * process. Immediately forwards to VoiceCommandActivity with
 * EXTRA_AUTO_START set, then finishes itself — it is never shown to the
 * user (see its manifest entry's NoDisplay theme) and holds no state.
 */
class VoiceInvokeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(
            Intent(this, VoiceCommandActivity::class.java)
                .putExtra(VoiceCommandActivity.EXTRA_AUTO_START, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        )
        finish()
    }
}
