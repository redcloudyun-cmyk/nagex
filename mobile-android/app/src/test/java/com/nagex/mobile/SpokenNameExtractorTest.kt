package com.nagex.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class SpokenNameExtractorTest {

    @Test
    fun `extracts a Korean name before the 에게 particle`() {
        assertEquals("김대진 대표", SpokenNameExtractor.extract("김대진 대표에게 20분 늦는다고 보내줘"))
    }

    @Test
    fun `extracts a Korean name before the 한테 particle`() {
        assertEquals("엄마", SpokenNameExtractor.extract("엄마한테 30분 늦는다고 문자 보내줘"))
    }

    @Test
    fun `extracts an English name after a lead-in phrase`() {
        assertEquals("Alex", SpokenNameExtractor.extract("Tell Alex I'm running late"))
    }

    @Test
    fun `falls back to the whole utterance when no known pattern matches`() {
        val utterance = "무슨 말인지 모르겠어"
        assertEquals(utterance, SpokenNameExtractor.extract(utterance))
    }

    @Test
    fun `blank input returns blank`() {
        assertEquals("", SpokenNameExtractor.extract("   "))
    }
}
