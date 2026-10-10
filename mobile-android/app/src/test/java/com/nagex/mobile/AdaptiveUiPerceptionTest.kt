package com.nagex.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdaptiveUiPerceptionTest {
    private val folded = AdaptiveUiPerception.DisplayContext(
        widthPx = 904,
        heightPx = 2316,
        density = 3.0f,
        posture = AdaptiveUiPerception.Posture.FOLDED,
        orientation = AdaptiveUiPerception.Orientation.PORTRAIT,
        windowMode = AdaptiveUiPerception.WindowMode.FULLSCREEN,
        splitScreen = false,
    )

    private val unfolded = AdaptiveUiPerception.DisplayContext(
        widthPx = 1768,
        heightPx = 2208,
        density = 2.5f,
        posture = AdaptiveUiPerception.Posture.UNFOLDED,
        orientation = AdaptiveUiPerception.Orientation.PORTRAIT,
        windowMode = AdaptiveUiPerception.WindowMode.SPLIT_SCREEN,
        splitScreen = true,
    )

    @Test
    fun `folded vs unfolded observations invalidate stale physical handles`() {
        val first = snapshot(display = folded, objects = listOf(searchInput()))
        val second = snapshot(display = unfolded, previous = first, objects = listOf(searchInput()))

        assertEquals(AdaptiveUiPerception.Posture.UNFOLDED, second.displayContext.posture)
        assertEquals(AdaptiveUiPerception.WindowMode.SPLIT_SCREEN, second.displayContext.windowMode)
        assertTrue(second.invalidatesPriorPhysicalHandles)
        assertTrue(second.visionRequired)
    }

    @Test
    fun `orientation change triggers reobservation before action`() {
        val first = snapshot(display = folded, objects = listOf(searchInput()))
        val landscape = folded.copy(widthPx = 2316, heightPx = 904, orientation = AdaptiveUiPerception.Orientation.LANDSCAPE)
        val second = snapshot(display = landscape, previous = first, objects = listOf(searchInput()))

        assertTrue(second.visionRequired)
        assertTrue(second.recommendedNextActions.contains(AdaptiveUiPerception.ActionMethod.FRESH_SCREENSHOT_BOUNDED_ACTIVATION))
    }

    @Test
    fun `ambiguous direct candidates trigger tree vision fusion path`() {
        val snap = snapshot(
            objects = listOf(
                direct("one"),
                direct("two"),
            ),
        )

        assertTrue(snap.ambiguity)
        assertTrue(snap.visionRequired)
        assertTrue(snap.recommendedNextActions.contains(AdaptiveUiPerception.ActionMethod.TREE_VISION_MAPPED_ACTIVATION))
    }

    @Test
    fun `successful click with no transition triggers new perception`() {
        val before = snapshot(objects = listOf(searchInput()))
        val after = snapshot(
            previous = before,
            previousAction = AdaptiveUiPerception.PreviousAction(
                method = AdaptiveUiPerception.ActionMethod.ACCESSIBILITY_CLICK,
                expectedScreenType = AdaptiveUiPerception.ScreenType.CHAT,
                transitionExpected = true,
                reportedSuccess = true,
            ),
            objects = listOf(searchInput()),
        )

        assertTrue(after.visionRequired)
    }

    @Test
    fun `recent query chip is a search result state not a terminal failure`() {
        val snap = snapshot(objects = listOf(searchInput(), recent()))

        assertEquals(AdaptiveUiPerception.ScreenType.SEARCH_RESULTS, snap.screenType)
        assertEquals(AdaptiveUiPerception.ObjectKind.RECENT_QUERY, snap.candidateTargets.single().kind)
        assertFalse(snap.recommendedNextActions.contains(AdaptiveUiPerception.ActionMethod.HUMAN_INTERACTION))
    }

    @Test
    fun `search result layout variation still resolves direct conversation semantically`() {
        val snap = snapshot(display = unfolded, objects = listOf(direct("target")))

        assertEquals(AdaptiveUiPerception.ScreenType.SEARCH_RESULTS, snap.screenType)
        assertEquals(1, snap.candidateTargets.size)
        assertEquals(AdaptiveUiPerception.ObjectKind.DIRECT_CONVERSATION, snap.candidateTargets.single().kind)
    }

    @Test
    fun `low risk navigation can use adaptive fallback`() {
        val snap = snapshot(objects = listOf(searchInput(confidence = 0.4)))
        val chosen = AdaptiveUiPerception.chooseBestSafeAction(
            snap,
            listOf(
                AdaptiveUiPerception.CandidateAction("SEND_MESSAGE", AdaptiveUiPerception.ActionMethod.ACCESSIBILITY_CLICK, AdaptiveUiPerception.Risk.HIGH),
                AdaptiveUiPerception.CandidateAction("OPEN_SEARCH", AdaptiveUiPerception.ActionMethod.TREE_VISION_MAPPED_ACTIVATION, AdaptiveUiPerception.Risk.LOW),
            ),
        )

        assertEquals("OPEN_SEARCH", chosen?.action)
    }

    @Test
    fun `high risk send still requires deterministic authority`() {
        assertTrue(
            AdaptiveUiPerception.canExecuteHighRiskSend(
                AdaptiveUiPerception.SendAuthority(
                    targetVerified = true,
                    payloadVerified = true,
                    approvalValid = true,
                    routeVerified = true,
                    duplicateRiskAbsent = true,
                ),
            ),
        )
        assertFalse(
            AdaptiveUiPerception.canExecuteHighRiskSend(
                AdaptiveUiPerception.SendAuthority(
                    targetVerified = true,
                    payloadVerified = true,
                    approvalValid = false,
                    routeVerified = true,
                    duplicateRiskAbsent = true,
                ),
            ),
        )
    }

    @Test
    fun `service exposes adaptive implementation marker`() {
        assertEquals("adaptive-perception-first-v1", NagexAccessibilityExecutionService.ADAPTIVE_PERCEPTION_IMPL_VERSION)
    }

    private fun snapshot(
        display: AdaptiveUiPerception.DisplayContext = folded,
        objects: List<AdaptiveUiPerception.SemanticObject>,
        previous: AdaptiveUiPerception.SemanticUiSnapshot? = null,
        previousAction: AdaptiveUiPerception.PreviousAction? = null,
    ): AdaptiveUiPerception.SemanticUiSnapshot =
        AdaptiveUiPerception.buildSnapshot(
            packageName = "com.kakao.talk",
            activityName = "MainActivity",
            displayContext = display,
            objects = objects,
            previous = previous,
            previousAction = previousAction,
        )

    private fun searchInput(confidence: Double = 0.95) = AdaptiveUiPerception.SemanticObject(
        id = "search",
        kind = AdaptiveUiPerception.ObjectKind.SEARCH_INPUT,
        editable = true,
        confidence = confidence,
    )

    private fun direct(id: String) = AdaptiveUiPerception.SemanticObject(
        id = id,
        kind = AdaptiveUiPerception.ObjectKind.DIRECT_CONVERSATION,
        label = "조민형 (Blue Dia/Mini)",
        clickable = true,
        confidence = 0.98,
    )

    private fun recent() = AdaptiveUiPerception.SemanticObject(
        id = "recent",
        kind = AdaptiveUiPerception.ObjectKind.RECENT_QUERY,
        label = "조민형",
        clickable = true,
        confidence = 0.8,
    )
}
