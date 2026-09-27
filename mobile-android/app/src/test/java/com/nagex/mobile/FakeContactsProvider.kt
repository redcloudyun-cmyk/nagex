package com.nagex.mobile

import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentValues
import android.database.MatrixCursor
import android.database.Cursor
import android.net.Uri
import android.provider.ContactsContract

/**
 * R23.6M Phase B4 test support — Robolectric ships no real
 * ContactsProvider2 (the actual production provider is a large, complex
 * AOSP component well outside the scope of a unit-test fake). This is a
 * minimal, honest in-memory substitute that serves exactly the query
 * shape ContactCandidateProvider actually issues (_ID + DISPLAY_NAME_PRIMARY,
 * a LIKE %name% selection against ContactsContract.Contacts.CONTENT_URI) —
 * it does not attempt to simulate raw contacts, aggregation, phone
 * numbers, or any other real ContactsProvider2 behavior, so it can only
 * ever be used to certify ContactCandidateProvider's own query/filter
 * logic, never anything about real device contact aggregation.
 */
class FakeContactsProvider : ContentProvider() {
    private val rows = mutableListOf<Pair<Long, String>>()
    private var nextId = 1L

    override fun onCreate(): Boolean = true

    override fun insert(uri: Uri, values: ContentValues?): Uri {
        val name = values?.getAsString(ContactsContract.Contacts.DISPLAY_NAME_PRIMARY).orEmpty()
        val id = nextId++
        rows.add(id to name)
        return ContentUris.withAppendedId(ContactsContract.Contacts.CONTENT_URI, id)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
        val cursor = MatrixCursor(arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY))
        // Mirrors the real "DISPLAY_NAME_PRIMARY LIKE ?" / "%name%" shape
        // ContactCandidateProvider builds — a substring match, nothing
        // fuzzier.
        val likePattern = selectionArgs?.firstOrNull()?.removePrefix("%")?.removeSuffix("%")
        for ((id, name) in rows) {
            if (likePattern == null || name.contains(likePattern)) {
                cursor.addRow(arrayOf(id, name))
            }
        }
        return cursor
    }

    override fun getType(uri: Uri): String? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
