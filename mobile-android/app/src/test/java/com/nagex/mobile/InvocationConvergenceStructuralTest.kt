package com.nagex.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * R23.6M Phase C.5B-P0 — structural proof that every invocation-route
 * source file converges on the single VoiceInvokeActivity trampoline
 * (never a bespoke destination per route, per the directive's "Do not
 * create separate agent/action logic per invocation mechanism"), and that
 * the Quick Settings Tile route specifically never starts a microphone
 * foreground service directly from its own onClick(). Full runtime
 * behavior of TileService/AppWidgetProvider is certified on the physical
 * device (Section 9's certification plan); this test locks in the source
 * property those physical checks are meant to confirm.
 */
class InvocationConvergenceStructuralTest {

    private fun read(relativePath: String): String = File(relativePath).readText()

    @Test
    fun `the Quick Settings Tile route targets VoiceInvokeActivity and starts no foreground service`() {
        val content = read("src/main/java/com/nagex/mobile/NagexQuickTileService.kt")
        assertTrue(content.contains("VoiceInvokeActivity"))
        assertFalse(content.contains("startForegroundService"))
        assertFalse(content.contains("FOREGROUND_SERVICE_MICROPHONE"))
        assertFalse(content.contains("foregroundServiceType"))
    }

    @Test
    fun `the home-screen widget route targets VoiceInvokeActivity`() {
        val content = read("src/main/java/com/nagex/mobile/NagexVoiceWidgetProvider.kt")
        assertTrue(content.contains("VoiceInvokeActivity"))
        assertFalse(content.contains("startForegroundService"))
    }

    @Test
    fun `the notification route targets VoiceInvokeActivity`() {
        val content = read("src/main/java/com/nagex/mobile/NotificationHelper.kt")
        assertTrue(content.contains("VoiceInvokeActivity"))
        assertFalse(content.contains("startForegroundService"))
    }

    @Test
    fun `the home-screen shortcut targets VoiceInvokeActivity`() {
        val content = read("src/main/res/xml/shortcuts.xml")
        assertTrue(content.contains("VoiceInvokeActivity"))
    }

    @Test
    fun `VoiceInvokeActivity itself only ever forwards to VoiceCommandActivity with EXTRA_AUTO_START`() {
        val content = read("src/main/java/com/nagex/mobile/VoiceInvokeActivity.kt")
        assertTrue(content.contains("VoiceCommandActivity"))
        assertTrue(content.contains("EXTRA_AUTO_START"))
        // The one exported entry point must never itself reach into the
        // approval/execution pipeline.
        assertFalse(content.contains("ActionApproval"))
        assertFalse(content.contains("SmsManager"))
    }

    @Test
    fun `no P0 invocation route declares a microphone foreground-service permission`() {
        val manifest = read("src/main/AndroidManifest.xml")
        assertFalse(manifest.contains("FOREGROUND_SERVICE_MICROPHONE"))
        assertFalse(manifest.contains("android:foregroundServiceType"))
    }
}
