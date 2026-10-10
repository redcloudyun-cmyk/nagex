package com.nagex.mobile

import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import java.time.Instant

enum class DeviceAgentHealth {
    STARTING,
    HEALTHY,
    DEGRADED,
    STOPPED,
}

data class DeviceAgentHealthSnapshot(
    val health: DeviceAgentHealth,
    val running: Boolean,
    val workerGeneration: Long,
    val lastHeartbeatAttemptAt: String?,
    val lastHeartbeatSuccessAt: String?,
    val lastPollAttemptAt: String?,
    val lastPollSuccessAt: String?,
    val lastCommandReceivedAt: String?,
    val lastDispatcherInvocationAt: String?,
    val consecutivePollFailures: Int,
    val lastStopReason: String?,
)

interface DeviceAgentPollTransport {
    fun heartbeat(): JSONObject
    fun ack(commandId: String, stage: String, resultCode: String? = null)
}

interface DeviceAgentCommandDispatcher {
    fun dispatch(command: JSONObject): NagexAccessibilityExecutionService.ActionResult
}

class DeviceAgentPollingOwner(
    private val transportFactory: () -> DeviceAgentPollTransport?,
    private val dispatcher: DeviceAgentCommandDispatcher,
    private val sleep: (Long) -> Unit = { SystemClock.sleep(it) },
    private val now: () -> String = { Instant.now().toString() },
    private val elapsedRealtime: () -> Long = { SystemClock.elapsedRealtime() },
    private val logger: DeviceAgentPollLogger = AndroidDeviceAgentPollLogger,
    private val pollIntervalMs: Long = DEFAULT_POLL_INTERVAL_MS,
    private val maxBackoffMs: Long = DEFAULT_MAX_BACKOFF_MS,
    private val stalePollThresholdMs: Long = DEFAULT_STALE_POLL_THRESHOLD_MS,
) {
    private val lock = Any()
    private var running = false
    private var workerThread: Thread? = null
    private var watchdogThread: Thread? = null
    private var watchdogRunning = false
    private var workerGeneration = 0L
    private var health = DeviceAgentHealth.STOPPED
    private var lastHeartbeatAttemptAt: String? = null
    private var lastHeartbeatSuccessAt: String? = null
    private var lastHeartbeatAttemptElapsedMs: Long? = null
    private var lastPollAttemptAt: String? = null
    private var lastPollSuccessAt: String? = null
    private var lastCommandReceivedAt: String? = null
    private var lastDispatcherInvocationAt: String? = null
    private var lastPollAttemptElapsedMs: Long? = null
    private var consecutivePollFailures = 0
    private var lastStopReason: String? = "NOT_STARTED"

    fun ensureDeviceAgentRunning(reason: String = "ensure"): DeviceAgentHealthSnapshot {
        synchronized(lock) {
            val existing = workerThread
            if (running && existing?.isAlive == true) return snapshotLocked()
            if (running && existing?.isAlive != true) {
                logger.warn("DEVICE_AGENT_POLL_STALLED reason=worker_dead ensureReason=$reason")
                health = DeviceAgentHealth.DEGRADED
                running = false
            }
            running = true
            health = DeviceAgentHealth.STARTING
            lastStopReason = null
            workerGeneration += 1
            val generation = workerGeneration
            workerThread = Thread({ runLoop(generation) }, "nagex-device-agent-poll-$generation").apply {
                isDaemon = true
                start()
            }
            startWatchdogLocked()
            logger.info("DEVICE_AGENT_POLL_STARTED generation=$generation reason=$reason")
            return snapshotLocked()
        }
    }

    fun stop(reason: String) {
        synchronized(lock) {
            running = false
            watchdogRunning = false
            health = DeviceAgentHealth.STOPPED
            lastStopReason = reason
            logger.info("DEVICE_AGENT_POLL_STOPPED reason=$reason")
        }
    }

    fun watchdogTick(): DeviceAgentHealthSnapshot {
        synchronized(lock) {
            val elapsed = lastPollAttemptElapsedMs ?: lastHeartbeatAttemptElapsedMs
            if (running && elapsed != null && elapsedRealtime() - elapsed > stalePollThresholdMs) {
                logger.warn("DEVICE_AGENT_POLL_STALLED lastPollAttemptAt=$lastPollAttemptAt")
                health = DeviceAgentHealth.DEGRADED
                running = false
            }
        }
        val snapshot = ensureDeviceAgentRunning("watchdog")
        if (snapshot.health == DeviceAgentHealth.STARTING) {
            logger.info("DEVICE_AGENT_POLL_RESTARTED generation=${snapshot.workerGeneration}")
        }
        return snapshot
    }

    fun snapshot(): DeviceAgentHealthSnapshot = synchronized(lock) { snapshotLocked() }

    private fun startWatchdogLocked() {
        val existing = watchdogThread
        if (watchdogRunning && existing?.isAlive == true) return
        watchdogRunning = true
        watchdogThread = Thread({
            while (isWatchdogRunning()) {
                sleep(stalePollThresholdMs.coerceAtMost(5_000L).coerceAtLeast(1_000L))
                if (isWatchdogRunning()) watchdogTick()
            }
        }, "nagex-device-agent-watchdog").apply {
            isDaemon = true
            start()
        }
    }

    private fun runLoop(generation: Long) {
        var activeCommand: JSONObject? = null
        var activeCommandClaimed = false
        while (isCurrentGenerationRunning(generation)) {
            val transport = transportFactory()
            if (transport == null) {
                recordFailure("DEVICE_AGENT_NOT_CONFIGURED")
                sleep(backoffMs())
                continue
            }
            try {
                markHeartbeatAttempt()
                val response = transport.heartbeat()
                markHeartbeatSuccess()
                markPollAttempt()
                if (activeCommand == null) {
                    activeCommand = response.optJSONObject("result")?.optJSONObject("pendingCommand")
                    activeCommandClaimed = false
                    if (activeCommand != null) markCommandReceived()
                }
                markPollSuccess()
                val command = activeCommand
                if (command != null) {
                    val terminal = handlePendingCommand(transport, command, activeCommandClaimed)
                    activeCommandClaimed = true
                    if (terminal) {
                        activeCommand = null
                        activeCommandClaimed = false
                    }
                }
                sleep(pollIntervalMs)
            } catch (e: Exception) {
                logger.warn("device command polling failed: ${e.message}")
                recordFailure(e.message ?: e.javaClass.simpleName)
                sleep(backoffMs())
            }
        }
        synchronized(lock) {
            if (workerGeneration == generation && health != DeviceAgentHealth.STOPPED) {
                health = DeviceAgentHealth.STOPPED
                lastStopReason = "LOOP_EXITED"
            }
        }
    }

    private fun handlePendingCommand(transport: DeviceAgentPollTransport, command: JSONObject, alreadyClaimed: Boolean): Boolean {
        val commandId = command.optString("commandId", "")
        if (commandId.isBlank()) return true
        if (!alreadyClaimed) transport.ack(commandId, "CLAIMED")
        transport.ack(commandId, "EXECUTING")
        markDispatcherInvocation()
        val result = dispatcher.dispatch(command)
        if (result.reasonCode == "WAITING_FOR_PRECONDITION") {
            transport.ack(commandId, "WAITING_FOR_PRECONDITION", result.reasonCode)
            return false
        }
        val finalStage = if (result.ok) "COMPLETED" else "FAILED"
        transport.ack(commandId, finalStage, result.reasonCode)
        return true
    }

    private fun isCurrentGenerationRunning(generation: Long): Boolean = synchronized(lock) {
        running && workerGeneration == generation
    }

    private fun isWatchdogRunning(): Boolean = synchronized(lock) { watchdogRunning }

    private fun markHeartbeatAttempt() = synchronized(lock) {
        lastHeartbeatAttemptAt = now()
        lastHeartbeatAttemptElapsedMs = elapsedRealtime()
        if (health == DeviceAgentHealth.STOPPED) health = DeviceAgentHealth.STARTING
    }

    private fun markHeartbeatSuccess() = synchronized(lock) {
        lastHeartbeatSuccessAt = now()
    }

    private fun markPollAttempt() = synchronized(lock) {
        lastPollAttemptAt = now()
        lastPollAttemptElapsedMs = elapsedRealtime()
    }

    private fun markPollSuccess() = synchronized(lock) {
        lastPollSuccessAt = now()
        consecutivePollFailures = 0
        health = DeviceAgentHealth.HEALTHY
    }

    private fun markCommandReceived() = synchronized(lock) {
        lastCommandReceivedAt = now()
        logger.info("DEVICE_AGENT_COMMAND_RECEIVED")
    }

    private fun markDispatcherInvocation() = synchronized(lock) {
        lastDispatcherInvocationAt = now()
        logger.info("DEVICE_AGENT_DISPATCHER_INVOKED")
    }

    private fun recordFailure(reason: String) = synchronized(lock) {
        consecutivePollFailures += 1
        health = DeviceAgentHealth.DEGRADED
        lastStopReason = reason
    }

    private fun backoffMs(): Long {
        val failures = synchronized(lock) { consecutivePollFailures.coerceAtLeast(1) }
        return (pollIntervalMs * failures).coerceAtMost(maxBackoffMs)
    }

    private fun snapshotLocked(): DeviceAgentHealthSnapshot = DeviceAgentHealthSnapshot(
        health = health,
        running = running && workerThread?.isAlive == true,
        workerGeneration = workerGeneration,
        lastHeartbeatAttemptAt = lastHeartbeatAttemptAt,
        lastHeartbeatSuccessAt = lastHeartbeatSuccessAt,
        lastPollAttemptAt = lastPollAttemptAt,
        lastPollSuccessAt = lastPollSuccessAt,
        lastCommandReceivedAt = lastCommandReceivedAt,
        lastDispatcherInvocationAt = lastDispatcherInvocationAt,
        consecutivePollFailures = consecutivePollFailures,
        lastStopReason = lastStopReason,
    )

    companion object {
        const val DEFAULT_POLL_INTERVAL_MS = 2_000L
        const val DEFAULT_MAX_BACKOFF_MS = 30_000L
        const val DEFAULT_STALE_POLL_THRESHOLD_MS = 15_000L
    }
}

interface DeviceAgentPollLogger {
    fun info(message: String)
    fun warn(message: String)
}

object AndroidDeviceAgentPollLogger : DeviceAgentPollLogger {
    private const val TAG = "NAgexDeviceAgent"

    override fun info(message: String) {
        Log.i(TAG, message)
    }

    override fun warn(message: String) {
        Log.w(TAG, message)
    }
}
