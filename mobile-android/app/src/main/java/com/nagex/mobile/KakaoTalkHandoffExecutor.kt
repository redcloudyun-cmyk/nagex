package com.nagex.mobile

import android.content.Context
import android.content.Intent

/** Human handoff only. Launch success is not send success. */
class KakaoTalkHandoffExecutor(private val context: Context) {
    sealed class Result { data object Started : Result(); data object Unavailable : Result() }
    fun start(approvedHandoffText: String): Result {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, approvedHandoffText)
            setPackage(KAKAOTALK_PACKAGE)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        if (intent.resolveActivity(context.packageManager) == null) return Result.Unavailable
        context.startActivity(intent)
        return Result.Started
    }
    companion object { const val KAKAOTALK_PACKAGE = "com.kakao.talk" }
}
