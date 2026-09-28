package com.nagex.mobile

import android.content.Context
import android.provider.ContactsContract

/**
 * R23.6M Phase C — resolves a local androidContactId to its real phone
 * number(s). This is the ONLY class in the app that ever reads a phone
 * number, and the value it returns is used exclusively to call
 * SmsManager.sendTextMessage() locally — it is never sent to the NAgex
 * server, never logged, and never put in any request body.
 */
class PhoneNumberResolver(private val context: Context) {

    sealed class Result {
        data class Unique(val phoneNumber: String) : Result()
        data class Ambiguous(val phoneNumbers: List<String>) : Result()
        object NotFound : Result()
    }

    fun resolve(androidContactId: String): Result {
        val numbers = mutableListOf<String>()
        val projection = arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER)
        val selection = "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID} = ?"
        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            projection,
            selection,
            arrayOf(androidContactId),
            null,
        )?.use { cursor ->
            val numberIndex = cursor.getColumnIndexOrThrow(ContactsContract.CommonDataKinds.Phone.NUMBER)
            while (cursor.moveToNext()) {
                val raw = cursor.getString(numberIndex)?.trim()
                if (!raw.isNullOrEmpty() && raw !in numbers) numbers.add(raw)
            }
        }
        return when {
            numbers.isEmpty() -> Result.NotFound
            numbers.size == 1 -> Result.Unique(numbers[0])
            else -> Result.Ambiguous(numbers)
        }
    }

    /** Never logs/displays a full number — the last 4 digits are enough
     * for a user to tell two numbers apart in the ambiguity picker without
     * the full number sitting in a screenshot or accessibility tree any
     * longer than necessary. */
    fun maskForDisplay(phoneNumber: String): String {
        val digitsOnly = phoneNumber.filter { it.isDigit() }
        if (digitsOnly.length <= 4) return phoneNumber
        return "•••-${digitsOnly.takeLast(4)}"
    }
}
