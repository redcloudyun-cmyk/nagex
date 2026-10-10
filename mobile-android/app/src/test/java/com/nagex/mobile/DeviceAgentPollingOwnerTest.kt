package com.nagex.mobile

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

class DeviceAgentPollingOwnerTest {
    @Test
    fun `agent starts on cold start and repeated ensure does not duplicate loops`() {
        val transport = FakeTransport()
        val owner = owner(transport = transport)

        val first = owner.ensureDeviceAgentRunning("cold_start")
        val second = owner.ensureDeviceAgentRunning("activity_recreated")

        assertEquals(first.workerGeneration, second.workerGeneration)
        waitUntil { transport.heartbeats.get() > 0 }
        assertEquals(DeviceAgentHealth.HEALTHY, owner.snapshot().health)
        owner.stop("test")
    }

    @Test
    fun `recoverable poll exception retries and becomes healthy`() {
        val transport = FakeTransport(failuresBeforeSuccess = 1)
        val owner = owner(transport = transport)

        owner.ensureDeviceAgentRunning("service_restart")

        waitUntil { transport.heartbeats.get() >= 2 }
        val snapshot = owner.snapshot()
        assertEquals(DeviceAgentHealth.HEALTHY, snapshot.health)
        assertEquals(0, snapshot.consecutivePollFailures)
        assertNotNull(snapshot.lastHeartbeatSuccessAt)
        owner.stop("test")
    }

    @Test
    fun `polling resumes after worker death is detected`() {
        val transport = FakeTransport()
        val owner = owner(transport = transport)
        val first = owner.ensureDeviceAgentRunning("first")
        owner.stop("simulated_service_destroy")

        val restarted = owner.ensureDeviceAgentRunning("process_recreated")

        assertNotEquals(first.workerGeneration, restarted.workerGeneration)
        waitUntil { transport.heartbeats.get() > 0 }
        owner.stop("test")
    }

    @Test
    fun `lock or unavailable UI does not prevent dequeue and waits for precondition`() {
        val command = command("cmd_lock_state")
        val transport = FakeTransport(command = command)
        val dispatcher = FakeDispatcher(NagexAccessibilityExecutionService.ActionResult(false, "WAITING_FOR_PRECONDITION"))
        val owner = owner(transport = transport, dispatcher = dispatcher)

        owner.ensureDeviceAgentRunning("locked_device")

        waitUntil { transport.acks.contains("cmd_lock_state:WAITING_FOR_PRECONDITION:WAITING_FOR_PRECONDITION") }
        assertTrue(transport.acks.contains("cmd_lock_state:CLAIMED:null"))
        assertTrue(transport.acks.contains("cmd_lock_state:EXECUTING:null"))
        assertEquals(1, dispatcher.invocations.get())
        assertNotNull(owner.snapshot().lastCommandReceivedAt)
        assertNotNull(owner.snapshot().lastDispatcherInvocationAt)
        owner.stop("test")
    }

    @Test
    fun `queued command payload is received exactly once while waiting for precondition`() {
        val transport = FakeTransport(command = command("cmd_once"))
        val dispatcher = FakeDispatcher(NagexAccessibilityExecutionService.ActionResult(false, "WAITING_FOR_PRECONDITION"))
        val owner = owner(transport = transport, dispatcher = dispatcher)

        owner.ensureDeviceAgentRunning("deliver_once")

        waitUntil { dispatcher.invocations.get() >= 1 }
        Thread.sleep(40)
        assertTrue(dispatcher.invocations.get() >= 1)
        assertEquals(1, transport.deliveredCommands.get())
        owner.stop("test")
    }

    @Test
    fun `heartbeat success and stale poll marks agent degraded and watchdog restarts`() {
        val transport = FakeTransport()
        val owner = owner(transport = transport, stalePollThresholdMs = 1)
        owner.ensureDeviceAgentRunning("initial")
        waitUntil { owner.snapshot().lastPollAttemptAt != null }

        Thread.sleep(5)
        val afterWatchdog = owner.watchdogTick()

        assertTrue(afterWatchdog.workerGeneration >= 1)
        assertTrue(afterWatchdog.running)
        owner.stop("test")
    }

    @Test
    fun `invalid device credential fails closed as degraded`() {
        val owner = DeviceAgentPollingOwner(
            transportFactory = { null },
            dispatcher = FakeDispatcher(NagexAccessibilityExecutionService.ActionResult(true, "UNUSED")),
            sleep = { Thread.sleep(1) },
            elapsedRealtime = { System.currentTimeMillis() },
            logger = NoopLogger,
            pollIntervalMs = 1,
            maxBackoffMs = 1,
        )

        owner.ensureDeviceAgentRunning("missing_credentials")

        waitUntil { owner.snapshot().consecutivePollFailures > 0 }
        assertEquals(DeviceAgentHealth.DEGRADED, owner.snapshot().health)
        assertEquals("DEVICE_AGENT_NOT_CONFIGURED", owner.snapshot().lastStopReason)
        owner.stop("test")
    }

    private fun owner(
        transport: FakeTransport,
        dispatcher: FakeDispatcher = FakeDispatcher(NagexAccessibilityExecutionService.ActionResult(true, "OK")),
        stalePollThresholdMs: Long = 5_000,
    ): DeviceAgentPollingOwner = DeviceAgentPollingOwner(
        transportFactory = { transport },
        dispatcher = dispatcher,
        sleep = { Thread.sleep(it.coerceAtMost(5)) },
        elapsedRealtime = { System.currentTimeMillis() },
        logger = NoopLogger,
        pollIntervalMs = 5,
        maxBackoffMs = 5,
        stalePollThresholdMs = stalePollThresholdMs,
    )

    private fun command(commandId: String): JSONObject = JSONObject()
        .put("commandId", commandId)
        .put("commandType", "ACCESSIBILITY_EXECUTE_PLAN")
        .put("data", JSONObject().put("steps", org.json.JSONArray()))

    private fun waitUntil(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 2_000
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(10)
        }
        throw AssertionError("condition was not met")
    }

    private class FakeTransport(
        private val command: JSONObject? = null,
        private val failuresBeforeSuccess: Int = 0,
    ) : DeviceAgentPollTransport {
        val heartbeats = AtomicInteger(0)
        val deliveredCommands = AtomicInteger(0)
        val acks = CopyOnWriteArrayList<String>()

        override fun heartbeat(): JSONObject {
            val count = heartbeats.incrementAndGet()
            if (count <= failuresBeforeSuccess) throw IllegalStateException("recoverable network failure")
            val pendingCommand = if (count == failuresBeforeSuccess + 1 && command != null) {
                deliveredCommands.incrementAndGet()
                command
            } else {
                null
            }
            return JSONObject()
                .put("result", JSONObject().put("pendingCommand", pendingCommand))
        }

        override fun ack(commandId: String, stage: String, resultCode: String?) {
            acks.add("$commandId:$stage:$resultCode")
        }
    }

    private class FakeDispatcher(
        private val result: NagexAccessibilityExecutionService.ActionResult,
    ) : DeviceAgentCommandDispatcher {
        val invocations = AtomicInteger(0)

        override fun dispatch(command: JSONObject): NagexAccessibilityExecutionService.ActionResult {
            invocations.incrementAndGet()
            return result
        }
    }

    private object NoopLogger : DeviceAgentPollLogger {
        override fun info(message: String) = Unit
        override fun warn(message: String) = Unit
    }
}
