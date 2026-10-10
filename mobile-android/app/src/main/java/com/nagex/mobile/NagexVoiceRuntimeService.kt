package com.nagex.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File

class NagexVoiceRuntimeService : Service() {
    private var audioOutput: VoiceAudioOutput? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var audioFocusGranted = false
    private var activeFile: File? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY_FILE -> playFile(intent)
            ACTION_STOP -> stopRuntime()
            else -> {
                Log.w(TAG, "VOICE_RUNTIME_IGNORED action=${intent?.action}")
                stopSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopRuntime()
        super.onDestroy()
    }

    private fun playFile(intent: Intent) {
        startForeground(NOTIFICATION_ID, buildNotification())
        val file = resolveAllowedFile(intent.getStringExtra(EXTRA_FILE_PATH))
        if (file == null) {
            Log.e(TAG, "VOICE_RUNTIME_ERROR reason=FILE_NOT_ALLOWED_OR_MISSING")
            releaseRuntime(stopService = true)
            return
        }

        activeFile = file
        val output = AndroidVoiceAudioOutput(applicationContext)
        audioOutput = output

        logRoute(output.diagnostics())
        if (!requestAudioFocus()) {
            Log.e(TAG, "VOICE_RUNTIME_ERROR reason=AUDIO_FOCUS_DENIED")
            releaseRuntime(stopService = true)
            return
        }

        output.playFile(
            file,
            VoiceAudioOutput.PlaybackCallbacks(
                onStarted = {
                    Log.i(TAG, "VOICE_RUNTIME_STARTED file=${file.name}")
                },
                onCompleted = {
                    Log.i(TAG, "VOICE_RUNTIME_COMPLETED file=${file.name}")
                    releaseRuntime(stopService = true)
                },
                onStopped = {
                    Log.i(TAG, "VOICE_RUNTIME_STOPPED file=${file.name}")
                    releaseRuntime(stopService = true)
                },
                onError = {
                    Log.e(TAG, "VOICE_RUNTIME_ERROR reason=$it file=${file.name}")
                    releaseRuntime(stopService = true)
                },
            ),
        )
    }

    private fun stopRuntime() {
        audioOutput?.stop()
        releaseRuntime(stopService = false)
    }

    private fun releaseRuntime(stopService: Boolean) {
        val hadRuntime = audioOutput != null || audioFocusGranted || activeFile != null
        audioOutput?.release()
        audioOutput = null
        activeFile = null
        abandonAudioFocus()
        stopForegroundCompat()
        if (hadRuntime) Log.i(TAG, "VOICE_RUNTIME_PLAYER_RELEASED")
        if (stopService) stopSelf()
    }

    private fun requestAudioFocus(): Boolean {
        val audio = getSystemService(AudioManager::class.java) ?: return false
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setOnAudioFocusChangeListener { change ->
                    Log.i(TAG, "VOICE_RUNTIME_AUDIO_FOCUS_CHANGE change=$change")
                }
                .build()
            audioFocusRequest = request
            audio.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audio.requestAudioFocus(
                { change -> Log.i(TAG, "VOICE_RUNTIME_AUDIO_FOCUS_CHANGE change=$change") },
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
            )
        }
        audioFocusGranted = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        Log.i(TAG, "VOICE_RUNTIME_AUDIO_FOCUS granted=$audioFocusGranted")
        return audioFocusGranted
    }

    private fun abandonAudioFocus() {
        if (!audioFocusGranted) return
        val audio = getSystemService(AudioManager::class.java) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audio.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audio.abandonAudioFocus(null)
        }
        audioFocusRequest = null
        audioFocusGranted = false
        Log.i(TAG, "VOICE_RUNTIME_AUDIO_FOCUS_RELEASED")
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (manager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    "NAgex voice runtime",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Plays NAgex spoken responses without opening the full app."
                },
            )
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_nagex_mic)
            .setContentTitle("NAgex")
            .setContentText("Speaking")
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun resolveAllowedFile(path: String?): File? {
        val requestedPath = path?.trim()
        if (requestedPath.isNullOrBlank()) return null
        val file = File(requestedPath).canonicalFile
        val appExternal = getExternalFilesDir(null) ?: return null
        val allowedRoots = listOf(
            File(filesDir, "nagex-voice-cert").canonicalFile,
            File(appExternal, "nagex-voice-cert").canonicalFile,
            File("/storage/emulated/0/Android/data/$packageName/files/nagex-voice-cert").canonicalFile,
            File("/sdcard/Download/nagex-voice-cert").canonicalFile,
            File("/storage/emulated/0/Download/nagex-voice-cert").canonicalFile,
        )
        Log.i(TAG, "VOICE_RUNTIME_RESOLVE requested=$requestedPath canonical=${file.path}")
        if (allowedRoots.none { root -> file.path == root.path || file.path.startsWith(root.path + File.separator) }) {
            Log.e(TAG, "VOICE_RUNTIME_REJECTED_PATH canonical=${file.path} allowed=${allowedRoots.joinToString { it.path }}")
            return null
        }
        if (!file.exists() || file.length() <= 0) return null
        return file
    }

    private fun logRoute(diagnostics: VoiceAudioOutput.Diagnostics) {
        Log.i(
            TAG,
            "VOICE_RUNTIME_ROUTE mediaVolume=${diagnostics.mediaVolumeLevel} " +
                "outputRoute=${diagnostics.outputRoute} " +
                "bluetoothRouteActive=${diagnostics.bluetoothRouteActive} " +
                "deviceSpeakerAvailable=${diagnostics.deviceSpeakerAvailable}",
        )
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    companion object {
        const val ACTION_PLAY_FILE = "com.nagex.mobile.action.PLAY_VOICE_OUTPUT"
        const val ACTION_STOP = "com.nagex.mobile.action.STOP_VOICE_OUTPUT"
        const val EXTRA_FILE_PATH = "extra_file_path"
        private const val CHANNEL_ID = "nagex_voice_runtime"
        private const val NOTIFICATION_ID = 2206
        private const val TAG = "NagexVoiceRuntime"
    }
}
