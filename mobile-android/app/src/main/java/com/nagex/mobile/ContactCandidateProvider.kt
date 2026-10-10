package com.nagex.mobile

import android.content.ContentResolver
import android.content.Context
import android.provider.ContactsContract
import kotlin.math.abs

class ContactCandidateProvider(private val context: Context) {
    data class Candidate(val contactId: String, val displayName: String)

    fun findCandidates(spokenName: String): List<Candidate> {
        val trimmed = spokenName.trim()
        if (trimmed.isEmpty()) return emptyList()

        val exact = queryByLike("%$trimmed%")
        if (exact.isNotEmpty()) return exact

        val first = trimmed.firstOrNull() ?: return emptyList()
        return queryByLike("$first%")
            .filter { isNearLength(trimmed, it.displayName) }
            .take(MAX_FALLBACK_CANDIDATES)
    }

    private fun queryByLike(pattern: String): List<Candidate> {
        val resolver: ContentResolver = context.contentResolver
        val projection = arrayOf(
            ContactsContract.Contacts._ID,
            ContactsContract.Contacts.DISPLAY_NAME_PRIMARY,
        )
        val selection = "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} LIKE ?"
        val selectionArgs = arrayOf(pattern)
        val candidates = mutableListOf<Candidate>()

        resolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            projection,
            selection,
            selectionArgs,
            null,
        )?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(ContactsContract.Contacts._ID)
            val nameIndex = cursor.getColumnIndexOrThrow(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY)
            while (cursor.moveToNext()) {
                val contactId = cursor.getString(idIndex) ?: continue
                val displayName = cursor.getString(nameIndex) ?: continue
                candidates.add(Candidate(contactId, displayName))
            }
        }

        return candidates
    }

    private fun isNearLength(spokenName: String, displayName: String): Boolean {
        val compact = displayName.replace(Regex("\\s+"), "")
        return abs(compact.length - spokenName.length) <= 4
    }

    companion object {
        private const val MAX_FALLBACK_CANDIDATES = 8
    }
}
