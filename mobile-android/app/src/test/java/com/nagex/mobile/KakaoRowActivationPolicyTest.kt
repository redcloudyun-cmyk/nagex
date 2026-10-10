package com.nagex.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class KakaoRowActivationPolicyTest {
    private val expected = "조민형 (Blue Dia/Mini)"

    @Test
    fun `nested child click can be retried with ancestor after no navigation`() {
        val ranked = KakaoRowActivationPolicy.rank(
            listOf(
                candidate(KakaoRowActivationPolicy.Role.CLASSIFIED_NODE, alreadyTried = true),
                candidate(KakaoRowActivationPolicy.Role.ROW_SAME_BOUNDS),
            ),
        )
        assertEquals(KakaoRowActivationPolicy.Role.ROW_SAME_BOUNDS, ranked.single().role)
    }

    @Test
    fun `avatar and profile candidates are excluded`() {
        assertFalse(candidate(KakaoRowActivationPolicy.Role.PROFILE_OR_AVATAR, semanticText = "프로필 명 $expected").let(KakaoRowActivationPolicy::isAuthorized))
    }

    @Test
    fun `candidate without click action is excluded`() {
        assertFalse(candidate(KakaoRowActivationPolicy.Role.ROW_ANCESTOR, hasClickAction = false).let(KakaoRowActivationPolicy::isAuthorized))
    }

    @Test
    fun `wrong conversation transition is not authorized as matching row`() {
        assertFalse(candidate(KakaoRowActivationPolicy.Role.ROW_SAME_BOUNDS, semanticText = "다른 사람 사진을 보냈습니다").let(KakaoRowActivationPolicy::isAuthorized))
    }

    @Test
    fun `exact leading conversation identity is authorized`() {
        assertTrue(candidate(KakaoRowActivationPolicy.Role.CLASSIFIED_NODE).let(KakaoRowActivationPolicy::isAuthorized))
    }

    @Test
    fun `section-prefixed selected row identity is authorized`() {
        assertTrue(candidate(KakaoRowActivationPolicy.Role.ROW_ANCESTOR, semanticText = "채팅방 $expected 사진을 보냈습니다").let(KakaoRowActivationPolicy::isAuthorized))
    }

    private fun candidate(
        role: KakaoRowActivationPolicy.Role,
        semanticText: String = "$expected 사진을 보냈습니다. 어제",
        hasClickAction: Boolean = true,
        alreadyTried: Boolean = false,
    ) = KakaoRowActivationPolicy.Candidate(
        role = role,
        hasClickAction = hasClickAction,
        semanticText = semanticText,
        expectedProviderDisplayName = expected,
        alreadyTried = alreadyTried,
    )
}
