package com.nagex.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class KakaoTalkConversationClassifierTest {
    private val classifier = KakaoTalkConversationClassifier()
    private val expected = "조민형 (Blue Dia/Mini)"

    @Test
    fun `real tree normal chat rows keep prefixed group rows out of direct resolution`() {
        val candidates = classifier.classifyObservedRows(
            listOf(
                row("채팅방", "조민형 (Blue Dia/Mini) 사진을 보냈습니다. 어제"),
                row("채팅방", "임혜자 후보 광명갑, 조민형 (Blue Dia/Mini) 3 이러면 해주고 싶어도.. 못하는거 아닌가 싶네요.. 어제"),
                row("채팅방", "긴급 모임방 8 알림꺼짐 사진을 보냈습니다. 9월 24일"),
            ),
            expected,
        )
        val resolved = classifier.resolveDirect(candidates, expected)
        assertEquals(1, resolved.directCandidates.size)
        assertEquals(KakaoTalkConversationClassifier.Resolution.CANDIDATE_FOUND, resolved.status)
        assertEquals(KakaoTalkConversationClassifier.TargetType.GROUP, candidates[1].targetType)
        assertNotEquals(KakaoTalkConversationClassifier.TargetType.DIRECT, candidates[2].targetType)
        assertEquals(
            KakaoTalkConversationClassifier.normalizeIdentity(expected),
            resolved.directCandidates.single().targetEvidence.normalizedIdentity,
        )
    }

    @Test
    fun `B no DIRECT is not found`() {
        val candidates = classifier.classifyObservedRows(listOf(row("채팅방", "조민형 프로젝트방", "멤버 3명")), expected)
        assertEquals(KakaoTalkConversationClassifier.Resolution.NOT_FOUND, classifier.resolveDirect(candidates, expected).status)
    }

    @Test
    fun `C two DIRECT candidates are ambiguous`() {
        val candidates = classifier.classifyObservedRows(
            listOf(row("채팅방", expected), row("채팅방", "$expected 사진을 보냈습니다. 어제")),
            expected,
        )
        assertEquals(KakaoTalkConversationClassifier.Resolution.AMBIGUOUS, classifier.resolveDirect(candidates, expected).status)
    }

    @Test
    fun `D E F open chat channel and profile are never selected as direct`() {
        val candidates = classifier.classifyObservedRows(
            listOf(
                row("오픈채팅", "조민형 (Blue Dia/Mini) 팬 오픈채팅"),
                row("채널", "조민형 (Blue Dia/Mini) 채널"),
                row("친구", "조민형 (Blue Dia/Mini)"),
                row("메시지", "조민형 (Blue Dia/Mini)"),
            ),
            expected,
        )
        assertEquals(KakaoTalkConversationClassifier.Resolution.NOT_FOUND, classifier.resolveDirect(candidates, expected).status)
        candidates.forEach { assertNotEquals(KakaoTalkConversationClassifier.TargetType.DIRECT, it.targetType) }
    }

    @Test
    fun `executor can reacquire classifier semantic evidence from fresh equivalent rows`() {
        val first = classifier.resolveDirect(
            classifier.classifyObservedRows(listOf(row("채팅방", "조민형 (Blue Dia/Mini) 사진을 보냈습니다. 어제")), expected),
            expected,
        ).directCandidates.single().targetEvidence
        val fresh = classifier.resolveDirect(
            classifier.classifyObservedRows(listOf(row("채팅방", "  조민형 (Blue Dia/Mini)   사진을 보냈습니다. 오늘  ")), expected),
            expected,
        ).directCandidates.single().targetEvidence

        assertEquals(first.normalizedIdentity, fresh.normalizedIdentity)
        assertEquals(KakaoTalkConversationClassifier.TargetType.DIRECT, fresh.targetType)
    }

    @Test
    fun `unicode Korean identity normalization is shared NFC whitespace only`() {
        assertEquals(
            "조민형 (blue dia/mini)",
            KakaoTalkConversationClassifier.normalizeIdentity("  조민형   (Blue Dia/Mini)  "),
        )
    }

    @Test
    fun `implementation marker is present for runtime certification`() {
        assertEquals("r2g-reacquire-contract-v3", NagexAccessibilityExecutionService.R2G_REACQUIRE_IMPL_VERSION)
    }

    private fun row(section: String, primary: String, secondary: String = "") =
        KakaoTalkConversationClassifier.ObservedRow(sectionTitle = section, primaryText = primary, secondaryText = secondary)
}
