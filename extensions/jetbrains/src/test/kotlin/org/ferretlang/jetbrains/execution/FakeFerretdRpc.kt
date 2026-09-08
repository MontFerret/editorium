package org.ferretlang.jetbrains.execution

import com.google.protobuf.Struct
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

internal class FakeFerretdRpc(
    private val version: String,
    private val root: Path,
    outcomes: List<Outcome>,
    private val onShutdown: () -> Unit = {},
) : FerretdRpc {
    enum class Outcome {
        COMPLETED,
        WAIT_FOR_CANCELLATION,
        MALFORMED_SEQUENCE,
    }

    val calls = Collections.synchronizedList(mutableListOf<String>())
    val createSessionEntered = CompletableDeferred<Unit>()
    val runExecutionEntered = CompletableDeferred<Unit>()
    val cancellationEntered = CompletableDeferred<Unit>()
    val getInfoEntered = CompletableDeferred<Unit>()
    val workspaceEntered = CompletableDeferred<Unit>()
    val closeEntered = CompletableDeferred<Unit>()
    val terminalEntered = CompletableDeferred<Unit>()
    var getInfoGate: CompletableDeferred<Unit>? = null
    var workspaceGate: CompletableDeferred<Unit>? = null
    var createSessionGate: CompletableDeferred<Unit>? = null
    var runExecutionGate: CompletableDeferred<Unit>? = null
    var closeGate: CompletableDeferred<Unit>? = null
    var terminalGate: CompletableDeferred<Unit>? = null
    var serverInfo = FerretdServerInfo(version, "instance", 1, 1)
    var getInfoFailure: Throwable? = null
    var closeExecutionFailure: Throwable? = null
    var closeSessionFailure: Throwable? = null
    var executionOptionsOverride: FerretdExecutionOptions? = null
    val requestedExecutionOptions = Collections.synchronizedList(mutableListOf<FerretdExecutionOptions>())
    private val nextSession = AtomicInteger()
    private val nextExecution = AtomicInteger()
    private val pendingOutcomes = ArrayDeque(outcomes)
    private val executions = Collections.synchronizedMap(mutableMapOf<String, ExecutionRecord>())

    override suspend fun getInfo(): FerretdServerInfo {
        calls += "getInfo"
        getInfoEntered.complete(Unit)
        getInfoGate?.await()
        getInfoFailure?.let { throw it }
        return serverInfo
    }

    override suspend fun shutdown() {
        calls += "shutdown"
        onShutdown()
    }

    override suspend fun openWorkspace(root: Path): FerretdWorkspace {
        calls += "openWorkspace"
        workspaceEntered.complete(Unit)
        workspaceGate?.await()
        return FerretdWorkspace("workspace", root)
    }

    override suspend fun createSession(workspaceId: String, relativePath: String): FerretdSession {
        val id = "session-${nextSession.incrementAndGet()}"
        calls += "createSession:$id"
        createSessionEntered.complete(Unit)
        createSessionGate?.await()
        return FerretdSession(id, workspaceId, relativePath, root.resolve(relativePath).toUri().toString(), 1)
    }

    override suspend fun createExecution(
        sessionId: String,
        parameters: Struct,
        options: FerretdExecutionOptions,
    ): FerretdExecutionSnapshot {
        val id = "execution-${nextExecution.incrementAndGet()}"
        calls += "createExecution:$id"
        requestedExecutionOptions += options
        val record = ExecutionRecord(
            id,
            sessionId,
            synchronized(pendingOutcomes) { pendingOutcomes.removeFirst() },
            executionOptionsOverride ?: options,
        )
        executions[id] = record
        return record.snapshot(FerretdExecutionState.CREATED)
    }

    override fun watchExecution(executionId: String): FerretdExecutionWatch {
        calls += "watchExecution:$executionId"
        val record = requireNotNull(executions[executionId])
        record.events.trySend(record.event(1, FerretdExecutionState.CREATED)).getOrThrow()
        return object : FerretdExecutionWatch {
            override suspend fun next(): FerretdExecutionEvent? {
                calls += "watchNext:$executionId"
                val result = record.events.receiveCatching()
                result.exceptionOrNull()?.let { throw it }
                return result.getOrNull()?.also { event ->
                    if (event.kind == FerretdExecutionState.COMPLETED) {
                        terminalEntered.complete(Unit)
                        terminalGate?.await()
                    }
                }
            }

            override fun cancel() {
                calls += "watchCancel:$executionId"
                record.events.close()
            }
        }
    }

    override suspend fun runExecution(executionId: String): FerretdExecutionSnapshot {
        calls += "runExecution:$executionId"
        runExecutionEntered.complete(Unit)
        runExecutionGate?.await()
        val record = requireNotNull(executions[executionId])
        synchronized(record) {
            if (record.state != FerretdExecutionState.CREATED) {
                throw FerretdRpcException("run-execution", "The execution is already terminal.")
            }
            record.state = FerretdExecutionState.RUNNING
            record.events.trySend(
                record.event(
                    if (record.outcome == Outcome.MALFORMED_SEQUENCE) 3 else 2,
                    FerretdExecutionState.RUNNING,
                ),
            ).getOrThrow()
            if (record.outcome == Outcome.COMPLETED) {
                record.state = FerretdExecutionState.COMPLETED
                record.events.trySend(record.event(3, FerretdExecutionState.COMPLETED)).getOrThrow()
                record.events.close()
            }
            return record.snapshot(FerretdExecutionState.RUNNING)
        }
    }

    override suspend fun cancelExecution(executionId: String): FerretdExecutionSnapshot {
        calls += "cancelExecution:$executionId"
        cancellationEntered.complete(Unit)
        val record = requireNotNull(executions[executionId])
        synchronized(record) {
            val state = record.state
            if (state != FerretdExecutionState.CREATED && state != FerretdExecutionState.RUNNING) return record.snapshot(state)
            record.state = FerretdExecutionState.CANCELLED
            record.events.trySend(record.event(if (state == FerretdExecutionState.CREATED) 2 else 3, FerretdExecutionState.CANCELLED))
            record.events.close()
            return record.snapshot(if (state == FerretdExecutionState.RUNNING) state else FerretdExecutionState.CANCELLED)
        }
    }

    override suspend fun closeExecution(executionId: String) {
        calls += "closeExecution:$executionId"
        executions.remove(executionId)?.events?.close()
        closeExecutionFailure?.let { throw it }
    }

    override suspend fun closeSession(sessionId: String) {
        calls += "closeSession:$sessionId"
        closeSessionFailure?.let { throw it }
    }

    override suspend fun close() {
        calls += "close"
        closeEntered.complete(Unit)
        closeGate?.await()
    }

    private class ExecutionRecord(
        val id: String,
        val sessionId: String,
        val outcome: Outcome,
        val options: FerretdExecutionOptions,
    ) {
        var state = FerretdExecutionState.CREATED
        val events = Channel<FerretdExecutionEvent>(Channel.UNLIMITED)

        fun snapshot(state: FerretdExecutionState): FerretdExecutionSnapshot = FerretdExecutionSnapshot(
            id,
            sessionId,
            state,
            options,
            if (state == FerretdExecutionState.COMPLETED) {
                FerretdExecutionOutput("application/json", "{\"id\":\"$id\"}".toByteArray(StandardCharsets.UTF_8))
            } else {
                null
            },
            null,
        )

        fun event(sequence: Long, state: FerretdExecutionState): FerretdExecutionEvent =
            FerretdExecutionEvent(id, sequence, state, snapshot(state))
    }
}
