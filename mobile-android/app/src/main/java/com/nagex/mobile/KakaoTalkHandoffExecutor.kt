package com.nagex.mobile

import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity

/** Human handoff only. A launch request is neither handoff success nor send success. */
class KakaoTalkHandoffExecutor(private val activity: AppCompatActivity) {
    sealed class Result { data object Started : Result(); data object Unavailable : Result() }
    fun start(approvedHandoffText: String, onResult: (Result) -> Unit) {
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, approvedHandoffText)
            setPackage(KAKAOTALK_PACKAGE)
        }
        val resolved = intent.resolveActivity(activity.packageManager)
        if (resolved == null || resolved.className.endsWith(MEMO_CHAT_ACTIVITY)) {
            onResult(Result.Unavailable)
            return
        }
        activity.startActivity(intent)
        // Some KakaoTalk versions resolve ACTION_SEND but immediately close
        // their share Activity. Only report a started handoff if the external
        // UI still owns focus after the launch-settle window. This does not
        // infer recipient selection or send completion.
        Handler(Looper.getMainLooper()).postDelayed({
            onResult(if (activity.hasWindowFocus()) Result.Unavailable else Result.Started)
        }, HANDOFF_SETTLE_MS)
    }
    companion object {
        const val KAKAOTALK_PACKAGE = "com.kakao.talk"
        const val MEMO_CHAT_ACTIVITY = "MemoChatConnectActivity"
        const val HANDOFF_SETTLE_MS = 1_000L
    }
}
