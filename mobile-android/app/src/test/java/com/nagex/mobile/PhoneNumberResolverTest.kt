package com.nagex.mobile

import androidx.test.core.app.ApplicationProvider
import android.provider.ContactsContract
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/**
 * R23.6M Phase C — certifies PhoneNumberResolver's 0/1/many resolution
 * rules, which drive the Android-side "never silently choose a number"
 * requirement: 0 numbers must block, exactly 1 is eligible for SMS
 * execution, 2+ must force explicit clarification.
 */
@RunWith(RobolectricTestRunner::class)
class PhoneNumberResolverTest {

    @Before
    fun setUp() {
        FakeContactsProvider.reset()
        Robolectric.buildContentProvider(FakeContactsProvider::class.java)
            .create(ContactsContract.AUTHORITY)
    }

    @After
    fun tearDown() {
        FakeContactsProvider.reset()
    }

    private fun resolver(): PhoneNumberResolver =
        PhoneNumberResolver(ApplicationProvider.getApplicationContext())

    @Test
    fun `a contact with zero phone numbers resolves to NotFound`() {
        val result = resolver().resolve("contact_1")
        assertTrue(result is PhoneNumberResolver.Result.NotFound)
    }

    @Test
    fun `a contact with exactly one phone number resolves to Unique`() {
        FakeContactsProvider.addPhoneNumber("contact_1", "01011112222")
        val result = resolver().resolve("contact_1")
        assertTrue(result is PhoneNumberResolver.Result.Unique)
        assertEquals("01011112222", (result as PhoneNumberResolver.Result.Unique).phoneNumber)
    }

    @Test
    fun `a contact with two or more phone numbers resolves to Ambiguous, never a silent pick`() {
        FakeContactsProvider.addPhoneNumber("contact_1", "01011112222")
        FakeContactsProvider.addPhoneNumber("contact_1", "01033334444")
        val result = resolver().resolve("contact_1")
        assertTrue(result is PhoneNumberResolver.Result.Ambiguous)
        assertEquals(2, (result as PhoneNumberResolver.Result.Ambiguous).phoneNumbers.size)
    }

    @Test
    fun `duplicate identical numbers on the same contact collapse to Unique, not a fake Ambiguous`() {
        FakeContactsProvider.addPhoneNumber("contact_1", "01011112222")
        FakeContactsProvider.addPhoneNumber("contact_1", "01011112222")
        val result = resolver().resolve("contact_1")
        assertTrue(result is PhoneNumberResolver.Result.Unique)
    }

    @Test
    fun `numbers belonging to a different contactId are never returned`() {
        FakeContactsProvider.addPhoneNumber("contact_2", "01099998888")
        val result = resolver().resolve("contact_1")
        assertTrue(result is PhoneNumberResolver.Result.NotFound)
    }

    @Test
    fun `maskForDisplay never exposes the full number, only the last 4 digits`() {
        val masked = resolver().maskForDisplay("01011112222")
        assertEquals("•••-2222", masked)
        assertTrue("2222" in masked)
        assertTrue("011112222" !in masked)
    }
}
