package com.nagex.mobile

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.time.Instant

/**
 * The checks that run BEFORE any accessibility action: a command is only ever acted on when it is addressed to this enrolled device, tenant and user, a semantic
 * plan has not expired or been seen before, and a governed KakaoTalk plan names its approved conversation and provider display name. (Steps that need a live
 * AccessibilityService are covered by the source-level contract tests in tests/r23_6m_phase_m4c_r2a_plan_delivery_dispatch.test.ts.)
 */
@RunWith(RobolectricTestRunner::class)
class AccessibilityExecutionPlanDispatcherTest {
    private lateinit var context: Context
    private lateinit var config: NagexServerConfig
    private lateinit var dispatcher: AccessibilityExecutionPlanDispatcher

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences("nagex_accessibility_plan_replay", Context.MODE_PRIVATE).edit().clear().apply()
        config = NagexServerConfig(context)
        config.deviceId = "dev_1"
        config.tenantId = "ten_1"
        config.principalId = "usr_1"
        dispatcher = AccessibilityExecutionPlanDispatcher(context, config)
    }

    private fun semanticCommand(
        commandId: String = "cmd_1",
        deviceId: String = "dev_1",
        tenantId: String = "ten_1",
        ownerId: String = "usr_1",
        queuedAt: String = Instant.now().toString(),
        steps: String = """[{"action":"OPEN_APP"}]""",
    ): JSONObject = JSONObject(
        """{"commandId":"$commandId","commandType":"ACCESSIBILITY_EXECUTE_PLAN","deviceId":"$deviceId","tenantId":"$tenantId","ownerId":"$ownerId","queuedAt":"$queuedAt",
            "data":{"planId":"plan_1","deviceId":"$deviceId","tenantId":"$tenantId","principalId":"$ownerId","packageName":"com.kakao.talk","targetPackage":"com.kakao.talk",
            "displayName":"Test Person","timeoutMs":120000,"steps":$steps}}""",
    )

    private fun governedCommand(conversationRef: String = "cvr_abc", expectedName: String = "Test Person", deviceId: String = "dev_1"): JSONObject = JSONObject(
        """{"commandId":"cmd_2","commandType":"ACCESSIBILITY_EXECUTE_PLAN","deviceId":"$deviceId","tenantId":"ten_1","ownerId":"usr_1","queuedAt":"${Instant.now()}",
            "data":{"planId":"plan_2","packageName":"com.kakao.talk","targetPackage":"com.kakao.talk","conversationRef":"$conversationRef","expectedProviderDisplayName":"$expectedName",
            "steps":[{"action":"SELECT_KAKAO_DIRECT_CONVERSATION","conversationRef":"$conversationRef","expectedProviderDisplayName":"$expectedName"}]}}""",
    )

    @Test
    fun `a command addressed to another device tenant or user is refused before anything runs`() {
        assertEquals("WRONG_DEVICE", dispatcher.dispatch(semanticCommand(deviceId = "dev_other")).reasonCode)
        assertEquals("WRONG_TENANT", dispatcher.dispatch(semanticCommand(tenantId = "ten_other")).reasonCode)
        assertEquals("WRONG_USER", dispatcher.dispatch(semanticCommand(ownerId = "usr_other")).reasonCode)
        // the governed KakaoTalk plan is gated the same way
        assertEquals("WRONG_DEVICE", dispatcher.dispatch(governedCommand(deviceId = "dev_other")).reasonCode)
        assertFalse(dispatcher.dispatch(semanticCommand(deviceId = "dev_other")).ok)
    }

    @Test
    fun `a semantic plan is rejected when its own device tenant or user fields disagree with the command`() {
        val command = semanticCommand()
        command.getJSONObject("data").put("deviceId", "dev_other")
        assertEquals("WRONG_DEVICE", dispatcher.dispatchSemanticPlan(command).reasonCode)
        val tenant = semanticCommand()
        tenant.getJSONObject("data").put("tenantId", "ten_other")
        assertEquals("WRONG_TENANT", dispatcher.dispatchSemanticPlan(tenant).reasonCode)
        val user = semanticCommand()
        user.getJSONObject("data").put("principalId", "usr_other")
        assertEquals("WRONG_USER", dispatcher.dispatchSemanticPlan(user).reasonCode)
    }

    @Test
    fun `only the allow-listed package is accepted`() {
        val command = semanticCommand()
        command.getJSONObject("data").put("targetPackage", "com.evil.app")
        assertEquals("PACKAGE_NOT_ALLOWLISTED", dispatcher.dispatchSemanticPlan(command).reasonCode)
    }

    @Test
    fun `an expired semantic plan is rejected and a plan without a queue time is treated as expired`() {
        val old = semanticCommand(queuedAt = Instant.now().minusSeconds(3600).toString())
        assertEquals("COMMAND_EXPIRED", dispatcher.dispatchSemanticPlan(old).reasonCode)
        val noTime = semanticCommand()
        noTime.remove("queuedAt")
        assertEquals("COMMAND_EXPIRED", dispatcher.dispatchSemanticPlan(noTime).reasonCode)
    }

    @Test
    fun `a command id that was already seen is a replay and is rejected`() {
        context.getSharedPreferences("nagex_accessibility_plan_replay", Context.MODE_PRIVATE).edit().putBoolean("cmd_seen", true).apply()
        assertEquals("REPLAY_REJECTED", dispatcher.dispatchSemanticPlan(semanticCommand(commandId = "cmd_seen")).reasonCode)
    }

    @Test
    fun `without a connected accessibility service a valid semantic plan is blocked, never reported as prepared`() {
        val result = dispatcher.dispatchSemanticPlan(semanticCommand(commandId = "cmd_fresh"))
        assertEquals("BLOCKED", result.status)
        assertEquals("ACCESSIBILITY_UNAVAILABLE", result.reasonCode)
        assertFalse(result.toActionResult().ok)
    }

    @Test
    fun `a governed KakaoTalk plan must name the approved conversation and provider display name`() {
        assertEquals("KAKAO_CONVERSATION_REF_REQUIRED", dispatcher.dispatch(governedCommand(conversationRef = "not_a_ref")).reasonCode)
        assertEquals("KAKAO_DIRECT_TARGET_IDENTITY_REQUIRED", dispatcher.dispatch(governedCommand(expectedName = "")).reasonCode)
    }

    @Test
    fun `an unknown command type and a missing plan are refused`() {
        assertEquals("UNKNOWN_COMMAND", dispatcher.dispatch(JSONObject("""{"commandType":"SOMETHING_ELSE"}""")).reasonCode)
        assertEquals("MALFORMED_PLAN", dispatcher.dispatch(JSONObject("""{"commandType":"ACCESSIBILITY_EXECUTE_PLAN","deviceId":"dev_1","tenantId":"ten_1","ownerId":"usr_1"}""")).reasonCode)
    }
}
