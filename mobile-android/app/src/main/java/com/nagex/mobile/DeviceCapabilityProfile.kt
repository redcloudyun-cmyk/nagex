package com.nagex.mobile

import android.accessibilityservice.AccessibilityService
import android.content.res.Configuration
import android.os.Build
import android.view.accessibility.AccessibilityNodeInfo

data class DeviceCapabilityProfile(
    val platform: String,
    val modelMetadata: String?,
    val widthPx: Int,
    val heightPx: Int,
    val density: Float,
    val orientation: String,
    val posture: String,
    val windowMode: String,
    val rotation: Int,
    val accessibilityTreeAvailable: Boolean,
    val screenshotAvailable: Boolean,
    val visionAvailable: Boolean,
    val semanticTextAvailable: Boolean,
    val structuredUiAvailable: Boolean,
    val semanticClickAvailable: Boolean,
    val textInputAvailable: Boolean,
    val imeActionAvailable: Boolean,
    val appLaunchAvailable: Boolean,
    val deepLinkAvailable: Boolean,
    val backNavigationAvailable: Boolean,
    val foregroundControlAvailable: Boolean,
    val backgroundExecutionAvailable: Boolean,
    val browserControlAvailable: Boolean,
    val nativeAppControlAvailable: Boolean,
    val protectedSurface: Boolean,
    val biometricRequired: Boolean,
    val osPermissionGate: Boolean,
    val screenshotBlocked: Boolean,
    val accessibilityLimited: Boolean,
) {
    fun toInventory(): List<String> = listOf(
        "platform:$platform",
        "deviceModelMetadata:${modelMetadata ?: "UNKNOWN"}",
        "display:${widthPx}x$heightPx",
        "density:$density",
        "orientation:$orientation",
        "posture:$posture",
        "windowMode:$windowMode",
        "rotation:$rotation",
        "accessibilityTree:${if (accessibilityTreeAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "screenshot:${if (screenshotAvailable) "AVAILABLE" else if (screenshotBlocked) "BLOCKED" else "UNKNOWN"}",
        "vision:${if (visionAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "semanticText:${if (semanticTextAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "structuredUi:${if (structuredUiAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "semanticClick:${if (semanticClickAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "textInput:${if (textInputAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "imeAction:${if (imeActionAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "appLaunch:${if (appLaunchAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "deepLink:${if (deepLinkAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "backNavigation:${if (backNavigationAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "foregroundControl:${if (foregroundControlAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "backgroundExecution:${if (backgroundExecutionAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "browserControl:${if (browserControlAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "nativeAppControl:${if (nativeAppControlAvailable) "AVAILABLE" else "UNAVAILABLE"}",
        "protectedSurface:${if (protectedSurface) "YES" else "NO"}",
        "biometricRequired:${if (biometricRequired) "YES" else "NO"}",
        "osPermissionGate:${if (osPermissionGate) "YES" else "NO"}",
        "screenshotBlocked:${if (screenshotBlocked) "YES" else "NO"}",
        "accessibilityLimited:${if (accessibilityLimited) "YES" else "NO"}",
    )
}

object AndroidDeviceCapabilityDiscovery {
    fun discover(service: AccessibilityService, screenshotCapability: AdaptiveUiPerception.ScreenCaptureCapability): DeviceCapabilityProfile {
        val metrics = service.resources.displayMetrics
        val orientation = if (
            service.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE ||
            metrics.widthPixels > metrics.heightPixels
        ) {
            "LANDSCAPE"
        } else {
            "PORTRAIT"
        }
        val posture = when {
            metrics.widthPixels >= 1600 -> "UNFOLDED"
            metrics.widthPixels >= 1000 -> "TABLET"
            metrics.widthPixels > 0 -> "FOLDED"
            else -> "UNKNOWN"
        }
        val root = service.rootInActiveWindow
        val structuredUiAvailable = root != null
        val textAvailable = root?.let { hasAnyText(it) } ?: false
        val screenshotAvailable = screenshotCapability == AdaptiveUiPerception.ScreenCaptureCapability.AVAILABLE
        val screenshotBlocked = screenshotCapability == AdaptiveUiPerception.ScreenCaptureCapability.BLOCKED_BY_APP ||
            screenshotCapability == AdaptiveUiPerception.ScreenCaptureCapability.BLOCKED_BY_OS ||
            screenshotCapability == AdaptiveUiPerception.ScreenCaptureCapability.SECURE_SURFACE
        return DeviceCapabilityProfile(
            platform = "ANDROID",
            modelMetadata = "${Build.MANUFACTURER}/${Build.MODEL}",
            widthPx = metrics.widthPixels,
            heightPx = metrics.heightPixels,
            density = metrics.density,
            orientation = orientation,
            posture = posture,
            windowMode = "FULLSCREEN",
            rotation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) service.display?.rotation ?: 0 else 0,
            accessibilityTreeAvailable = structuredUiAvailable,
            screenshotAvailable = screenshotAvailable,
            visionAvailable = screenshotAvailable,
            semanticTextAvailable = textAvailable,
            structuredUiAvailable = structuredUiAvailable,
            semanticClickAvailable = structuredUiAvailable,
            textInputAvailable = structuredUiAvailable,
            imeActionAvailable = true,
            appLaunchAvailable = true,
            deepLinkAvailable = true,
            backNavigationAvailable = true,
            foregroundControlAvailable = true,
            backgroundExecutionAvailable = false,
            browserControlAvailable = true,
            nativeAppControlAvailable = structuredUiAvailable,
            protectedSurface = screenshotCapability == AdaptiveUiPerception.ScreenCaptureCapability.SECURE_SURFACE ||
                screenshotCapability == AdaptiveUiPerception.ScreenCaptureCapability.BLOCKED_BY_APP,
            biometricRequired = false,
            osPermissionGate = !structuredUiAvailable,
            screenshotBlocked = screenshotBlocked,
            accessibilityLimited = !structuredUiAvailable,
        )
    }

    private fun hasAnyText(node: AccessibilityNodeInfo): Boolean {
        if (!node.text.isNullOrBlank() || !node.contentDescription.isNullOrBlank()) return true
        for (index in 0 until node.childCount) {
            val child = node.getChild(index) ?: continue
            if (hasAnyText(child)) return true
        }
        return false
    }
}
