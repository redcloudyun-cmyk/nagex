package com.nagex.mobile

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.net.Uri
import java.io.File
import java.io.IOException

interface VoiceAudioOutput {
    fun playFile(
        file: File,
        callbacks: PlaybackCallbacks = PlaybackCallbacks(),
    )

    fun playBytes(
        bytes: ByteArray,
        formatHint: String,
        callbacks: PlaybackCallbacks = PlaybackCallbacks(),
    )

    fun playStream(
        uri: Uri,
        callbacks: PlaybackCallbacks = PlaybackCallbacks(),
    )

    fun pause()
    fun stop()
    fun release()
    fun diagnostics(): Diagnostics

    data class PlaybackCallbacks(
        val onStarted: () -> Unit = {},
        val onCompleted: () -> Unit = {},
        val onStopped: () -> Unit = {},
        val onError: (String) -> Unit = {},
    )

    data class Diagnostics(
        val outputRoute: String,
        val mediaVolumeLevel: String,
        val playbackSession: String?,
        val bluetoothRouteActive: Boolean,
        val deviceSpeakerAvailable: Boolean,
    )
}

class AndroidVoiceAudioOutput(
    private val context: Context,
    private val playerFactory: () -> MediaPlayer = { MediaPlayer() },
) : VoiceAudioOutput {
    private var player: MediaPlayer? = null
    private var sessionId: String? = null
    private var stoppedByCaller = false

    override fun playFile(file: File, callbacks: VoiceAudioOutput.PlaybackCallbacks) {
        if (!file.exists() || file.length() <= 0) {
            callbacks.onError("VOICE_AUDIO_FILE_MISSING_OR_EMPTY")
            return
        }
        playLocalPath(file.absolutePath, callbacks)
    }

    override fun playBytes(bytes: ByteArray, formatHint: String, callbacks: VoiceAudioOutput.PlaybackCallbacks) {
        if (bytes.isEmpty()) {
            callbacks.onError("VOICE_AUDIO_BYTES_EMPTY")
            return
        }
        val ext = when (formatHint.lowercase()) {
            "audio/mpeg", "audio/mp3", "mp3" -> ".mp3"
            "audio/wav", "audio/x-wav", "wav" -> ".wav"
            else -> ".audio"
        }
        val temp = File.createTempFile("nagex-tts-", ext, context.cacheDir)
        try {
            temp.writeBytes(bytes)
        } catch (e: IOException) {
            callbacks.onError("VOICE_AUDIO_BYTES_WRITE_FAILED")
            return
        }
        playFile(
            temp,
            callbacks.copy(
                onCompleted = {
                    temp.delete()
                    callbacks.onCompleted()
                },
                onStopped = {
                    temp.delete()
                    callbacks.onStopped()
                },
                onError = {
                    temp.delete()
                    callbacks.onError(it)
                },
            ),
        )
    }

    override fun playStream(uri: Uri, callbacks: VoiceAudioOutput.PlaybackCallbacks) {
        release()
        val next = playerFactory()
        player = next
        stoppedByCaller = false
        sessionId = "vao_${System.nanoTime()}"
        try {
            next.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            next.setOnPreparedListener { prepared ->
                callbacks.onStarted()
                prepared.start()
            }
            next.setOnCompletionListener {
                if (stoppedByCaller) callbacks.onStopped() else callbacks.onCompleted()
                release()
            }
            next.setOnErrorListener { _, what, extra ->
                callbacks.onError("MEDIA_PLAYER_ERROR_$what:$extra")
                release()
                true
            }
            next.setDataSource(context, uri)
            next.prepareAsync()
        } catch (e: Exception) {
            callbacks.onError(e.javaClass.simpleName.ifBlank { "VOICE_AUDIO_PLAYBACK_ERROR" })
            release()
        }
    }

    private fun playLocalPath(path: String, callbacks: VoiceAudioOutput.PlaybackCallbacks) {
        release()
        val next = playerFactory()
        player = next
        stoppedByCaller = false
        sessionId = "vao_${System.nanoTime()}"
        try {
            next.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            next.setOnPreparedListener { prepared ->
                callbacks.onStarted()
                prepared.start()
            }
            next.setOnCompletionListener {
                if (stoppedByCaller) callbacks.onStopped() else callbacks.onCompleted()
                release()
            }
            next.setOnErrorListener { _, what, extra ->
                callbacks.onError("MEDIA_PLAYER_ERROR_$what:$extra")
                release()
                true
            }
            next.setDataSource(path)
            next.prepareAsync()
        } catch (e: Exception) {
            callbacks.onError(e.javaClass.simpleName.ifBlank { "VOICE_AUDIO_PLAYBACK_ERROR" })
            release()
        }
    }

    override fun pause() {
        player?.let {
            runCatching {
                if (it.isPlaying) it.pause()
            }
        }
    }

    override fun stop() {
        player?.let {
            runCatching {
                stoppedByCaller = true
                if (it.isPlaying) it.stop()
            }
        }
        release()
    }

    override fun release() {
        player?.let {
            it.setOnPreparedListener(null)
            it.setOnCompletionListener(null)
            it.setOnErrorListener(null)
            runCatching { it.release() }
        }
        player = null
    }

    override fun diagnostics(): VoiceAudioOutput.Diagnostics {
        val audio = context.getSystemService(AudioManager::class.java)
        val devices = audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        val route = devices.joinToString(",") { it.routeLabel() }
        val musicVolume = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
        val musicMax = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        val bluetoothActive = devices.any {
            it.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
        }
        val speakerAvailable = devices.any { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        return VoiceAudioOutput.Diagnostics(route, "$musicVolume/$musicMax", sessionId, bluetoothActive, speakerAvailable)
    }

    private fun AudioDeviceInfo.routeLabel(): String = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "BUILTIN_SPEAKER"
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "BLUETOOTH_A2DP"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "BLUETOOTH_SCO"
        AudioDeviceInfo.TYPE_BLE_HEADSET -> "BLE_HEADSET"
        AudioDeviceInfo.TYPE_USB_HEADSET -> "USB_HEADSET"
        AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "WIRED_HEADPHONES"
        AudioDeviceInfo.TYPE_WIRED_HEADSET -> "WIRED_HEADSET"
        else -> "TYPE_$type"
    }
}

typealias MediaPlayerVoiceAudioOutput = AndroidVoiceAudioOutput
