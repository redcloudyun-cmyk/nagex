package com.nagex.mobile

import android.content.Intent
import android.net.Uri
import androidx.appcompat.app.AppCompatActivity

/**
 * M3 app-link route executor. This opens only an already server-authorized
 * package/URI pair; it never interprets arbitrary intent://, file://,
 * javascript:, content://, or package names from voice/model output.
 *
 * Launching an app link is weak evidence only. It never proves downstream
 * completion inside the target app.
 */
class AndroidAppLinkExecutor(private val activity: AppCompatActivity) {
    sealed class Result {
        data object AppLaunched : Result()
        data object FailedToLaunch : Result()
    }

    fun open(packageName: String, uri: String, onResult: (Result) -> Unit) {
        val parsed = try { Uri.parse(uri) } catch (_: Exception) {
            onResult(Result.FailedToLaunch)
            return
        }
        val intent = Intent(Intent.ACTION_VIEW, parsed).apply {
            setPackage(packageName)
            addCategory(Intent.CATEGORY_BROWSABLE)
        }
        if (intent.resolveActivity(activity.packageManager) == null) {
            onResult(Result.FailedToLaunch)
            return
        }
        activity.startActivity(intent)
        onResult(Result.AppLaunched)
    }
}
