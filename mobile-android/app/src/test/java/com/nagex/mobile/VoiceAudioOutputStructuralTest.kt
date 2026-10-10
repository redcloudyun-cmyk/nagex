package com.nagex.mobile

import android.media.MediaPlayer
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class VoiceAudioOutputStructuralTest {
    @Test
    fun `voice audio output exposes file and stream entry points without external intents`() {
        val output: VoiceAudioOutput = AndroidVoiceAudioOutput(
            ApplicationProvider.getApplicationContext(),
        ) { MediaPlayer() }

        assertTrue(output is VoiceAudioOutput)
        assertTrue(VoiceAudioOutput::class.java.methods.any { it.name == "playFile" })
        assertTrue(VoiceAudioOutput::class.java.methods.any { it.name == "playBytes" })
        assertTrue(VoiceAudioOutput::class.java.methods.any { it.name == "playStream" })
        assertTrue(VoiceAudioOutput::class.java.methods.any { it.name == "stop" })
        assertTrue(VoiceAudioOutput::class.java.methods.any { it.name == "release" })
    }

    @Test
    fun `missing file fails before MediaPlayer allocation`() {
        var error: String? = null
        val output = AndroidVoiceAudioOutput(ApplicationProvider.getApplicationContext()) {
            throw AssertionError("MediaPlayer should not be created for a missing file")
        }

        output.playFile(
            File("/sdcard/Download/nagex-voice-cert/missing.mp3"),
            VoiceAudioOutput.PlaybackCallbacks(onError = { error = it }),
        )

        assertTrue(error == "VOICE_AUDIO_FILE_MISSING_OR_EMPTY")
    }

    @Test
    fun `voice runtime service does not use activities ACTION_VIEW or external media player packages`() {
        val source = String(
            java.nio.file.Files.readAllBytes(java.nio.file.Path.of("src/main/java/com/nagex/mobile/NagexVoiceRuntimeService.kt")),
        )
        assertTrue(!source.contains("ACTION_VIEW"))
        assertTrue(!source.contains("startActivity"))
        assertTrue(!source.contains("VoiceAudioCertActivity"))
        assertTrue(!source.contains("com.sec.android.app.music"))
        assertTrue(!source.contains("com.sec.android.app.myfiles"))
    }

    @Test
    fun `voice runtime service is registered as media playback service not foreground activity`() {
        val manifest = String(
            java.nio.file.Files.readAllBytes(java.nio.file.Path.of("src/main/AndroidManifest.xml")),
        )
        assertTrue(manifest.contains("NagexVoiceRuntimeService"))
        assertTrue(manifest.contains("FOREGROUND_SERVICE_MEDIA_PLAYBACK"))
        assertTrue(manifest.contains("android:foregroundServiceType=\"mediaPlayback\""))
        assertTrue(!manifest.contains("VoiceAudioCertActivity"))
    }

    @Test
    fun `lock screen policy blocks sensitive locked speech but allows low sensitivity hook`() {
        assertTrue(
            VoiceRuntimeLockPolicy.canSpeak(
                VoiceRuntimePolicyInput(deviceLocked = true, contentSensitivity = VoiceContentSensitivity.LOW),
            ),
        )
        assertTrue(
            !VoiceRuntimeLockPolicy.canSpeak(
                VoiceRuntimePolicyInput(deviceLocked = true, contentSensitivity = VoiceContentSensitivity.SENSITIVE),
            ),
        )
    }

    @Test
    fun `settings preview controller uses the same audio output and deletes generated file`() {
        val temp = File.createTempFile("nagex-preview-", ".mp3")
        temp.writeText("fake audio")
        var played = false
        val output = object : VoiceAudioOutput {
            override fun playFile(file: File, callbacks: VoiceAudioOutput.PlaybackCallbacks) {
                played = file == temp
                callbacks.onCompleted()
            }
            override fun playBytes(bytes: ByteArray, formatHint: String, callbacks: VoiceAudioOutput.PlaybackCallbacks) {}
            override fun playStream(uri: android.net.Uri, callbacks: VoiceAudioOutput.PlaybackCallbacks) {}
            override fun pause() {}
            override fun stop() {}
            override fun release() {}
            override fun diagnostics() = VoiceAudioOutput.Diagnostics("", "", null, false, false)
        }

        VoicePreviewController(output).playGeneratedFile(temp)

        assertTrue(played)
        assertTrue(!temp.exists())
    }
}
