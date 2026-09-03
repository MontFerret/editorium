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
) : FerretdRpc {
    enum class Outcome {
        COMPLETED,
        WAIT_FOR_CANCELLATION,
        MALFORMED_SEQUENCE,
    }

    val calls = Collections.synchronizedList(mutableListOf<String>())
    var createSessionGate: CompletableDeferred<Unit>? = null
    var runExecutionGate: CompletableDeferred<Unit>? = null
    var serverInfo = FerretdServerInfo(version, "instance", 1, 1)
    var getInfoFailure: Throwable? = null
    var closeExecutionFailure: Throwable? = null
    var closeSessionFailure: Throwable? = null
    private val nextSession = AtomicInteger()
    private val nextExecution = AtomicInteger()
    private val pendingOutcomes = ArrayDeque(outcomes)
    private val executions = Collections.synchronizedMap(mutableMapOf<String, ExecutionRecord>())

    override suspend fun getInfo(): FerretdServerInfo {
        calls += "getInfo"
        getInfoFailure?.let { throw it }
        return serverInfo
    }

    override suspend fun shutdown() {
        calls += "shutdown"
    }

    override suspend fun openWorkspace(root: Path): FerretdWorkspace {
        calls += "openWorkspace"
        return FerretdWorkspace("workspace", root)
    }

    override suspend fun createSession(workspaceId: String, relativePath: String): FerretdSession {
        val id = "session-${nextSession.incrementAndGet()}"
        calls += "createSession:$id"
        createSessionGate?.await()
        return FerretdSession(id, workspaceId, relativePath, root.resolve(relativePath).toUri().toString(), 1)
    }

    override suspend fun createExecution(sessionId: String, parameters: Struct): FerretdExecutionSnapshot {
        val id = "execution-${nextExecution.incrementAndGet()}"
        calls += "createExecution:$id"
        val record = ExecutionRecord(id, sessionId, synchronized(pendingOutcomes) { pendingOutcomes.removeFirst() })
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
                return result.getOrNull()
            }

            override fun cancel() {
                calls += "watchCancel:$executionId"
                record.events.close()
            }
        }
    }

    override suspend fun runExecution(executionId: String): FerretdExecutionSnapshot {
        calls += "runExecution:$executionId"
        runExecutionGate?.await()
        val record = requireNotNull(executions[executionId])
        record.events.send(
            record.event(
                if (record.outcome == Outcome.MALFORMED_SEQUENCE) 3 else 2,
                FerretdExecutionState.RUNNING,
            ),
        )
        if (record.outcome == Outcome.COMPLETED) {
            record.events.send(record.event(3, FerretdExecutionState.COMPLETED))
            record.events.close()
        }
        return record.snapshot(FerretdExecutionState.RUNNING)
    }

    override suspend fun cancelExecution(executionId: String): FerretdExecutionSnapshot {
        calls += "cancelExecution:$executionId"
        val record = requireNotNull(executions[executionId])
        val cancelled = record.snapshot(FerretdExecutionState.CANCELLED)
        record.events.send(record.event(3, FerretdExecutionState.CANCELLED))
        record.events.close()
        return cancelled
    }

    override suspend fun closeExecution(executionId: String) {
        calls += "closeExecution:$executionId"
        closeExecutionFailure?.let { throw it }
    }

    override suspend fun closeSession(sessionId: String) {
        calls += "closeSession:$sessionId"
        closeSessionFailure?.let { throw it }
    }

    override suspend fun close() {
        calls += "close"
    }

    private class ExecutionRecord(
        val id: String,
        val sessionId: String,
        val outcome: Outcome,
    ) {
        val events = Channel<FerretdExecutionEvent>(Channel.UNLIMITED)

        fun snapshot(state: FerretdExecutionState): FerretdExecutionSnapshot = FerretdExecutionSnapshot(
            id,
            sessionId,
            state,
            "application/json",
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
