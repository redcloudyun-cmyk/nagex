package com.nagex.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * R23.6M Phase C.5B-P0 — structural proof that no wake-word engine or
 * assistant-role integration exists in this app yet (Section 10 of the
 * C.5A audit explicitly defers both). Mirrors the same source-scanning
 * pattern already used server-side (e.g.
 * r23_6m_phase_c_sms_execution.test.ts's "no KakaoTalk/... references"
 * check) rather than a runtime reflection trick, so it fails loudly and
 * readably if a future change quietly introduces one of these without
 * the explicit P1 review the roadmap requires.
 *
 * Deliberately checks for concrete API/class names, not the English
 * phrase "wake word" — that phrase legitimately appears throughout this
 * app's own KDoc comments describing what is NOT implemented, and a
 * naive text match would false-positive on exactly the documentation
 * this test exists to keep honest.
 */
class WakeWordNotImplementedTest {

    // Gradle's test working directory is the app module root
    // (mobile-android/app), matching how every other file-path-based test
    // in this suite (e.g. ContactCandidateProviderTest's Robolectric
    // fixtures) already assumes.
    private val mainSourceDir = File("src/main/java/com/nagex/mobile")

    private val forbiddenApiReferences = listOf(
        "AlwaysOnHotwordDetector",
        "VoiceInteractionService",
        "VoiceInteractionSessionService",
        "createAlwaysOnHotwordDetector",
        "SoundTrigger",
        "android.app.role.ASSISTANT",
        "RoleManager",
    )

    @Test
    fun `no wake-word engine or assistant-role API is referenced anywhere in main source`() {
        val kotlinFiles = mainSourceDir.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue("expected to find the app's Kotlin sources at $mainSourceDir", kotlinFiles.isNotEmpty())

        for (file in kotlinFiles) {
            val content = file.readText()
            for (forbidden in forbiddenApiReferences) {
                assertFalse(
                    "${file.name} unexpectedly references '$forbidden' — wake-word/assistant-role integration is P1/long-term, not yet approved for implementation",
                    content.contains(forbidden),
                )
            }
        }
    }

    @Test
    fun `AndroidManifest declares no VoiceInteractionService or BIND_VOICE_INTERACTION component`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertFalse(manifest.contains("VoiceInteractionService"))
        assertFalse(manifest.contains("BIND_VOICE_INTERACTION"))
        assertFalse(manifest.contains("android.app.role.ASSISTANT"))
    }
}
