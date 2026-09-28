package com.nagex.mobile

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.telephony.SmsManager
import java.util.UUID

/**
 * R23.6M Phase C — the one place this app ever calls SmsManager. Nothing
 * upstream of this class (LLM, server, voice layer) can reach SmsManager
 * directly; this class itself only ever runs after
 * NagexApiClient.sendDeviceMessage(MOBILE_MESSAGE_EXECUTE) has returned a
 * real server-side "you are cleared to send" — invoking that API is what
 * actually consumes the one-time approval, not this class.
 *
 * Canonical result distinction the R23.6M directive requires: invoking
 * SmsManager.sendTextMessage()/sendMultipartTextMessage() is never itself
 * treated as success. The real SENT/DELIVERED broadcast results (or their
 * absence) are what determine SENT_CONFIRMED / SEND_FAILED /
 * SEND_STATUS_UNKNOWN, reported back to the server via
 * MOBILE_MESSAGE_STATUS.
 *
 * Handles both single-part and multipart messages transparently — a
 * message exceeding one SMS segment is split via SmsManager.divideMessage()
 * and sent as one multipart message with one PendingIntent per part;
 * SENT_CONFIRMED requires every part to individually report success, one
 * part failing is reported as SEND_FAILED for the whole message (never a
 * partially-sent message silently reported as fully sent).
 */
class SmsSendExecutor(private val activity: Activity) {

    sealed class SendOutcome {
        object SentConfirmed : SendOutcome()
        data class SendFailed(val reason: String) : SendOutcome()
        object StatusUnknown : SendOutcome()
    }

    private val sentAction = "com.nagex.mobile.SMS_SENT_${UUID.randomUUID()}"
    private val deliveredAction = "com.nagex.mobile.SMS_DELIVERED_${UUID.randomUUID()}"

    /** Sends exactly once. [onSentResult] fires once every part's SENT
     * broadcast has arrived (or a timeout elapses with one or more parts
     * still outstanding, reported as StatusUnknown — never guessed into
     * success). [onDeliveredResult], if it ever fires, always arrives
     * later, independently, and only if the carrier/device actually
     * supports delivery reports for every part — its absence is not
     * itself a failure signal. */
    fun send(phoneNumber: String, message: String, timeoutMs: Long = 20_000, onSentResult: (SendOutcome) -> Unit, onDeliveredResult: (Boolean) -> Unit) {
        val smsManager = SmsManager.getDefault()
        val parts = smsManager.divideMessage(message)
        if (parts.isEmpty()) {
            onSentResult(SendOutcome.SendFailed("EMPTY_MESSAGE"))
            return
        }

        var resolved = false
        val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
        val sentResultsByPart = IntArray(parts.size) { PART_PENDING }
        val deliveredResultsByPart = IntArray(parts.size) { PART_PENDING }
        val registeredReceivers = mutableListOf<BroadcastReceiver>()

        fun cleanup() {
            for (receiver in registeredReceivers) {
                try { activity.unregisterReceiver(receiver) } catch (_: IllegalArgumentException) {}
            }
            registeredReceivers.clear()
        }

        fun maybeResolveSent() {
            if (resolved) return
            if (sentResultsByPart.any { it == PART_PENDING }) return
            resolved = true
            val firstFailure = sentResultsByPart.firstOrNull { it != Activity.RESULT_OK && it != PART_PENDING }
            val outcome = if (firstFailure == null) SendOutcome.SentConfirmed else SendOutcome.SendFailed(smsResultCodeName(firstFailure))
            onSentResult(outcome)
        }

        fun maybeResolveDelivered() {
            if (deliveredResultsByPart.any { it == PART_PENDING }) return
            val allDelivered = deliveredResultsByPart.all { it == Activity.RESULT_OK }
            onDeliveredResult(allDelivered)
        }

        val sentPIs = ArrayList<PendingIntent>(parts.size)
        val deliveredPIs = ArrayList<PendingIntent>(parts.size)
        val piFlags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

        for (index in parts.indices) {
            val sentReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    sentResultsByPart[index] = resultCode
                    maybeResolveSent()
                }
            }
            val deliveredReceiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    deliveredResultsByPart[index] = resultCode
                    maybeResolveDelivered()
                }
            }
            registeredReceivers.add(sentReceiver)
            registeredReceivers.add(deliveredReceiver)
            activity.registerReceiver(sentReceiver, IntentFilter("$sentAction.$index"), Context.RECEIVER_NOT_EXPORTED)
            activity.registerReceiver(deliveredReceiver, IntentFilter("$deliveredAction.$index"), Context.RECEIVER_NOT_EXPORTED)
            sentPIs.add(PendingIntent.getBroadcast(activity, index, Intent("$sentAction.$index").setPackage(activity.packageName), piFlags))
            deliveredPIs.add(PendingIntent.getBroadcast(activity, index, Intent("$deliveredAction.$index").setPackage(activity.packageName), piFlags))
        }

        // No fabricated success path: if the send call itself throws (e.g.
        // no SIM, airplane mode), that is a real, immediate failure —
        // reported the same as any other SendFailed, never silently
        // swallowed and never treated as "attempted, so probably fine".
        try {
            if (parts.size == 1) {
                smsManager.sendTextMessage(phoneNumber, null, parts[0], sentPIs[0], deliveredPIs[0])
            } else {
                smsManager.sendMultipartTextMessage(phoneNumber, null, parts, sentPIs, deliveredPIs)
            }
        } catch (e: Exception) {
            if (!resolved) {
                resolved = true
                cleanup()
                onSentResult(SendOutcome.SendFailed(e.message ?: "SEND_THREW"))
            }
            return
        }

        // A bounded wait for every part's SENT broadcast — any part still
        // outstanding within a reasonable window is reported as genuinely
        // unknown (the crash-window case SEND_STATUS_UNKNOWN exists for),
        // never silently assumed to have succeeded.
        mainHandler.postDelayed({
            if (!resolved) {
                resolved = true
                cleanup()
                onSentResult(SendOutcome.StatusUnknown)
            }
        }, timeoutMs)
    }

    companion object {
        private const val PART_PENDING = Int.MIN_VALUE

        private fun smsResultCodeName(resultCode: Int): String = when (resultCode) {
            SmsManager.RESULT_ERROR_GENERIC_FAILURE -> "GENERIC_FAILURE"
            SmsManager.RESULT_ERROR_NO_SERVICE -> "NO_SERVICE"
            SmsManager.RESULT_ERROR_NULL_PDU -> "NULL_PDU"
            SmsManager.RESULT_ERROR_RADIO_OFF -> "RADIO_OFF"
            else -> "ERROR_CODE_$resultCode"
        }
    }
}
