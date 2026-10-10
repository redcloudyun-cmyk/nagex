package com.nagex.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class R2gRuntimeDiagnosticReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action != ACTION_DRY_RUN) return
        val expectedProviderDisplayName = intent.getStringExtra(EXTRA_EXPECTED_PROVIDER_DISPLAY_NAME).orEmpty()
        val result = NagexAccessibilityExecutionService.active()
            ?.dryRunSelectUniqueKakaoDirectConversation(expectedProviderDisplayName)
            ?: NagexAccessibilityExecutionService.ActionResult(false, "ACCESSIBILITY_UNAVAILABLE")
        Log.i(TAG, "dry_run_result marker=${NagexAccessibilityExecutionService.R2G_REACQUIRE_IMPL_VERSION} ok=${result.ok} reason=${result.reasonCode}")
        resultCode = if (result.ok) 0 else 1
        resultData = result.reasonCode
    }

    companion object {
        const val ACTION_DRY_RUN = "com.nagex.mobile.R2G_DRY_RUN_SELECT_KAKAO_DIRECT"
        const val EXTRA_EXPECTED_PROVIDER_DISPLAY_NAME = "expectedProviderDisplayName"
        private const val TAG = "NAgexR2GDiagnostic"
    }
}
