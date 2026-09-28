package com.nagex.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews

/**
 * R23.6M Phase C.5B-P0 — the home-screen widget invocation route (Section
 * 4B of the C.5A audit). A single tap target; tapping it launches
 * VoiceInvokeActivity (the one exported trampoline) via an ordinary
 * PendingIntent-backed Activity launch, which the platform documents as a
 * genuine app-widget-interaction exemption from background-start
 * restrictions — no foreground-service type or microphone permission is
 * declared here.
 */
class NagexVoiceWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        for (widgetId in appWidgetIds) {
            val intent = Intent(context, VoiceInvokeActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            val pendingIntent = PendingIntent.getActivity(
                context, widgetId, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val views = RemoteViews(context.packageName, R.layout.widget_talk_to_nagex).apply {
                setOnClickPendingIntent(R.id.widgetRoot, pendingIntent)
            }
            appWidgetManager.updateAppWidget(widgetId, views)
        }
    }
}
