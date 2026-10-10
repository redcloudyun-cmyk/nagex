package com.nagex.mobile

import java.io.File

class VoicePreviewController(
    private val audioOutput: VoiceAudioOutput,
) {
    fun playGeneratedFile(
        file: File,
        callbacks: VoiceAudioOutput.PlaybackCallbacks = VoiceAudioOutput.PlaybackCallbacks(),
    ) {
        audioOutput.playFile(
            file,
            callbacks.copy(
                onCompleted = {
                    file.delete()
                    callbacks.onCompleted()
                },
                onStopped = {
                    file.delete()
                    callbacks.onStopped()
                },
                onError = {
                    file.delete()
                    callbacks.onError(it)
                },
            ),
        )
    }

    fun playGeneratedBytes(
        bytes: ByteArray,
        formatHint: String,
        callbacks: VoiceAudioOutput.PlaybackCallbacks = VoiceAudioOutput.PlaybackCallbacks(),
    ) {
        audioOutput.playBytes(bytes, formatHint, callbacks)
    }

    fun stop() {
        audioOutput.stop()
    }

    fun release() {
        audioOutput.release()
    }
}
