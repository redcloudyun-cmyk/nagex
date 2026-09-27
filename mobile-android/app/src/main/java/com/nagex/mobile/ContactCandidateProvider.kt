package com.nagex.mobile

import android.content.ContentResolver
import android.content.Context
import android.provider.ContactsContract

/**
 * R23.6M Phase B3 — queries Android's ContactsContract for candidates
 * plausibly matching a spoken name, WITHOUT ever reading or returning a
 * phone number. Only `contactId` (ContactsContract's own local _ID, opaque
 * outside this device) and `displayName` ever leave this class — this is
 * the device-side half of the "do not upload the entire address book"
 * privacy boundary the R23.6M directive requires; the other half
 * (server-side re-validation) lives in ContactResolver.resolve() on the
 * server.
 */
class ContactCandidateProvider(private val context: Context) {

    data class Candidate(val contactId: String, val displayName: String)

    /** A simple, deterministic substring match against
     * ContactsContract.Contacts.DISPLAY_NAME — intentionally not a fuzzy
     * search. The server independently re-validates every candidate this
     * returns against the spoken name again before treating any of them as
     * a real match (ContactResolver.resolve()), so this method's job is
     * only to keep the candidate set small and privacy-preserving, not to
     * be the final authority on matching. */
    fun findCandidates(spokenName: String): List<Candidate> {
        val trimmed = spokenName.trim()
        if (trimmed.isEmpty()) return emptyList()

        val resolver: ContentResolver = context.contentResolver
        val candidates = mutableListOf<Candidate>()
        val projection = arrayOf(
            ContactsContract.Contacts._ID,
            ContactsContract.Contacts.DISPLAY_NAME_PRIMARY,
        )
        val selection = "${ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} LIKE ?"
        val selectionArgs = arrayOf("%$trimmed%")

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
}
