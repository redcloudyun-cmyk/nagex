package com.nagex.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * R23.6M Phase C.5B-P0 — the persistent "Talk to NAgex" notification
 * invocation route (Section 4C of the C.5A audit). The notification
 * itself does nothing but display an action; tapping it launches
 * VoiceInvokeActivity (the one exported trampoline), which forwards to
 * VoiceCommandActivity with EXTRA_AUTO_START — a documented, official
 * while-in-use-permission exemption for a microphone-adjacent flow
 * (notification interaction), so no FOREGROUND_SERVICE_MICROPHONE is
 * declared or needed for this route.
 *
 * POST_NOTIFICATIONS (Android 13+) is requested opportunistically and
 * handled truthfully: if denied, this one route is simply unavailable —
 * every other invocation route (tap, shortcut, widget, Quick Settings
 * Tile) continues to work normally. NAgex never treats notification
 * permission as mandatory.
 */
object NotificationHelper {
    private const val CHANNEL_ID = "nagex_voice_invocation"
    private const val NOTIFICATION_ID = 1001

    fun hasPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    }

    private fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_voice_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = context.getString(R.string.notification_channel_voice_description)
        }
        manager.createNotificationChannel(channel)
    }

    /** No-op (never a fake "shown" state) if permission is not granted —
     * the caller is expected to have already checked [hasPermission].
     * Suppressed lint check: the permission is genuinely verified above,
     * via [hasPermission], immediately before this method's single
     * `.notify()` call — lint cannot trace that guarantee across the
     * function boundary itself. */
    @SuppressLint("MissingPermission")
    fun showTalkToNagexNotification(context: Context) {
        if (!hasPermission(context)) return
        ensureChannel(context)

        val invokeIntent = Intent(context, VoiceInvokeActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pendingIntent = PendingIntent.getActivity(
            context, 0, invokeIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_nagex_mic)
            .setContentTitle(context.getString(R.string.notification_talk_to_nagex_title))
            .setContentText(context.getString(R.string.notification_talk_to_nagex_text))
            .setContentIntent(pendingIntent)
            .addAction(0, context.getString(R.string.notification_action_talk), pendingIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
    }
}
