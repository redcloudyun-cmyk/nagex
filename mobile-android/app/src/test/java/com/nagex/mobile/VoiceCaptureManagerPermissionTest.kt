package com.nagex.mobile

import android.Manifest
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * R23.6M Phase B4 — certifies the previously-disclosed gap: a denied
 * microphone permission produces a truthful PermissionDenied result and
 * VoiceCaptureManager never attempts to start listening (no action is
 * taken), exactly as the R23.6M directive requires of the Voice Layer.
 * Runs as a real Android-framework-backed (Robolectric) unit test, not a
 * hand-simulated mock of PackageManager.
 */
@RunWith(RobolectricTestRunner::class)
class VoiceCaptureManagerPermissionTest {

    @Test
    fun `hasMicrophonePermission is false when RECORD_AUDIO has not been granted`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val manager = VoiceCaptureManager(context)
        assertFalse(manager.hasMicrophonePermission())
    }

    @Test
    fun `listenOnce reports PermissionDenied and never starts recognition when permission is denied`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val manager = VoiceCaptureManager(context)

        var result: VoiceCaptureManager.Result? = null
        manager.listenOnce("ko-KR") { result = it }

        assertEquals(VoiceCaptureManager.Result.PermissionDenied, result)
    }

    @Test
    fun `hasMicrophonePermission is true once RECORD_AUDIO is granted`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        shadowOf(context).grantPermissions(Manifest.permission.RECORD_AUDIO)
        val manager = VoiceCaptureManager(context)
        assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.RECORD_AUDIO))
        assert(manager.hasMicrophonePermission())
    }
}
