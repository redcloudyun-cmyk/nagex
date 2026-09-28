package com.nagex.mobile

import android.Manifest
import android.app.NotificationManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * R23.6M Phase C.5B-P0 — certifies the notification invocation route:
 * it truthfully respects POST_NOTIFICATIONS denial (never a fake "shown"
 * state), and once granted, its action converges on VoiceInvokeActivity —
 * the same single destination every other P0 route targets, never a
 * bespoke per-route action.
 */
@RunWith(RobolectricTestRunner::class)
class NotificationHelperTest {

    private fun context() = ApplicationProvider.getApplicationContext<android.app.Application>()

    @Test
    fun `showTalkToNagexNotification posts nothing when POST_NOTIFICATIONS is denied`() {
        val context = context()
        val manager = context.getSystemService(NotificationManager::class.java)!!
        val shadowManager = shadowOf(manager)

        NotificationHelper.showTalkToNagexNotification(context)

        assertEquals(0, shadowManager.allNotifications.size)
    }

    @Test
    fun `once POST_NOTIFICATIONS is granted, the notification action targets VoiceInvokeActivity`() {
        val context = context()
        shadowOf(context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        assertTrue(NotificationHelper.hasPermission(context))

        val manager = context.getSystemService(NotificationManager::class.java)!!
        val shadowManager = shadowOf(manager)

        NotificationHelper.showTalkToNagexNotification(context)

        assertEquals(1, shadowManager.allNotifications.size)
        val posted = shadowManager.allNotifications.first()
        val pendingIntent = posted.contentIntent
        val shadowPending = shadowOf(pendingIntent)
        val target = shadowPending.savedIntent.component
        assertEquals(VoiceInvokeActivity::class.java.name, target?.className)
    }

    @Test
    fun `hasPermission is false before POST_NOTIFICATIONS is granted`() {
        assertFalse(NotificationHelper.hasPermission(context()))
    }
}
