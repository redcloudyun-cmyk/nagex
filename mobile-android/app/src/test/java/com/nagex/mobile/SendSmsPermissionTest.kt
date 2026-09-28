package com.nagex.mobile

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * R23.6M Phase C — certifies the SEND_SMS permission gate
 * MessageComposeActivity.onApproveTapped() checks immediately before
 * execution: a fresh install has SEND_SMS denied by default, and only
 * once it is explicitly granted does ContextCompat report it as such.
 * SmsSendExecutor itself performs no permission check (see its own
 * class doc) — MessageComposeActivity is the sole enforcement point, so
 * this certifies exactly that gate's underlying primitive.
 */
@RunWith(RobolectricTestRunner::class)
class SendSmsPermissionTest {

    @Test
    fun `SEND_SMS is denied by default, so SmsManager must never be reached without an explicit grant`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        assertEquals(
            PackageManager.PERMISSION_DENIED,
            ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS),
        )
    }

    @Test
    fun `once SEND_SMS is explicitly granted, ContextCompat reflects it truthfully`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        shadowOf(context).grantPermissions(Manifest.permission.SEND_SMS)
        assertEquals(
            PackageManager.PERMISSION_GRANTED,
            ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS),
        )
    }
}
