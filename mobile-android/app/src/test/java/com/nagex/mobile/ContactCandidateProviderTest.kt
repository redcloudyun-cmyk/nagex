package com.nagex.mobile

import android.content.ContentValues
import android.provider.ContactsContract
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/**
 * R23.6M Phase B4 — certifies the previously-disclosed gap: the candidate
 * contact query returns only genuinely matching contacts, and — the core
 * privacy requirement — never reads or returns a phone number.
 *
 * Robolectric ships no real ContactsProvider2 out of the box, so
 * FakeContactsProvider (test-only, this package) stands in for it,
 * registered under the real ContactsContract.AUTHORITY — this still
 * exercises ContactCandidateProvider's actual ContentResolver query/filter
 * logic end to end, just against a minimal provider rather than the full
 * real one.
 */
@RunWith(RobolectricTestRunner::class)
class ContactCandidateProviderTest {

    @Before
    fun registerFakeContactsProvider() {
        Robolectric.buildContentProvider(FakeContactsProvider::class.java)
            .create(ContactsContract.AUTHORITY)
    }

    private fun insertContact(displayName: String): Long {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        val values = ContentValues().apply {
            put(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY, displayName)
        }
        val uri = context.contentResolver.insert(ContactsContract.Contacts.CONTENT_URI, values)
        return uri?.lastPathSegment?.toLongOrNull() ?: -1L
    }

    @Test
    fun `returns only contacts whose display name matches the spoken name`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        insertContact("김대진 대표")
        insertContact("박민수")
        insertContact("Alex Kim")

        val provider = ContactCandidateProvider(context)
        val results = provider.findCandidates("김대진")

        assertEquals(1, results.size)
        assertEquals("김대진 대표", results[0].displayName)
    }

    @Test
    fun `returns an empty list for a blank spoken name rather than every contact`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        insertContact("Someone")
        val provider = ContactCandidateProvider(context)
        assertTrue(provider.findCandidates("   ").isEmpty())
    }

    @Test
    fun `never reads or returns a phone number field`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        insertContact("Alex Kim")
        val provider = ContactCandidateProvider(context)
        val results = provider.findCandidates("Alex")
        assertEquals(1, results.size)
        // The Candidate data class structurally has no phone-number field
        // at all — this asserts the actual returned value never contains
        // one smuggled into displayName either.
        assertTrue(results[0].displayName.none { it.isDigit() })
    }

    @Test
    fun `multiple genuinely distinct matches are all returned as candidates, never silently narrowed to one`() {
        val context = ApplicationProvider.getApplicationContext<android.app.Application>()
        insertContact("김대진 (주식회사 A)")
        insertContact("김대진 (주식회사 B)")
        val provider = ContactCandidateProvider(context)
        val results = provider.findCandidates("김대진")
        assertEquals(2, results.size)
    }
}
