package org.ferretlang.jetbrains.execution

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import java.net.URI

internal class FerretExecutionClient(
    private val connection: FerretdDaemonConnection,
) {
    fun start(input: FerretExecutionInput, sink: FerretExecutionSink): FerretExecutionHandle {
        val handle = FerretExecutionHandle()
        connection.launchRun {
            val exitCode = try {
                val request = withContext(kotlinx.coroutines.Dispatchers.IO) {
                    FerretExecutionRequest.resolve(input)
                }
                sink.system("Source: ${request.source}")
                sink.system("Working directory: ${request.workspaceRoot}")
                if (handle.isCancellationRequested()) {
                    handle.commit(FerretExecutionHandle.CANCELLED_EXIT_CODE)
                } else {
                    run(request, handle, sink)
                }
            } catch (error: Throwable) {
                val code = handle.commit(1)
                if (code != FerretExecutionHandle.CANCELLED_EXIT_CODE) {
                    reportError(error, sink)
                }
                code
            }
            sink.terminate(exitCode)
        }
        return handle
    }

    private suspend fun run(
        request: FerretExecutionRequest,
        handle: FerretExecutionHandle,
        sink: FerretExecutionSink,
    ): Int {
        var sessionId: String? = null
        var executionId: String? = null
        var watch: FerretdExecutionWatch? = null
        var cancellationJob: Job? = null
        val generation = connection.generation()
        return try {
            val workspaceId = connection.workspace(generation, request.workspaceRoot)
            if (handle.isCancellationRequested()) {
                return handle.commit(FerretExecutionHandle.CANCELLED_EXIT_CODE)
            }
            val session = generation.rpc.createSession(workspaceId, request.relativeSourcePath)
            sessionId = session.id
            if (
                session.workspaceId != workspaceId ||
                session.relativePath != request.relativeSourcePath ||
                !sessionUriMatches(session.uri, request.source) ||
                session.revision < 1L
            ) {
                throw FerretdRpcException("create-session", "The Ferret daemon returned a session for another source.")
            }
            if (handle.isCancellationRequested()) {
                return handle.commit(FerretExecutionHandle.CANCELLED_EXIT_CODE)
            }
            val created = generation.rpc.createExecution(session.id, FerretStructMapper.map(request.bindings))
            executionId = created.id
            validateExecution(created, created.id, session.id, FerretdExecutionState.CREATED)
            if (handle.isCancellationRequested()) {
                return handle.commit(FerretExecutionHandle.CANCELLED_EXIT_CODE)
            }
            watch = generation.rpc.watchExecution(created.id)
            val initial = nextEvent(watch, generation.lost)
                ?: throw FerretdRpcException(
                    "watch-execution",
                    "The Ferret execution watch ended before its created event.",
                )
            validateEvent(initial, created.id, session.id, 1L, FerretdExecutionState.CREATED)
            cancellationJob = CoroutineScope(currentCoroutineContext()).launch {
                handle.cancellation.await()
                if (handle.claimCancelRpc()) {
                    try {
                        val cancelled = generation.rpc.cancelExecution(created.id)
                        validateExecution(cancelled, created.id, session.id, FerretdExecutionState.CANCELLED)
                    } catch (error: Throwable) {
                        sink.internal("Cancelling Ferret execution ${created.id} failed", error)
                    }
                }
            }
            if (handle.isCancellationRequested()) {
                return handle.commit(FerretExecutionHandle.CANCELLED_EXIT_CODE)
            }
            sink.system("Starting Ferret execution...")
            val started = try {
                generation.rpc.runExecution(created.id)
            } catch (error: Throwable) {
                if (!handle.isCancellationRequested()) {
                    throw error
                }
                null
            }
            if (started != null) {
                validateExecution(started, created.id, session.id, FerretdExecutionState.RUNNING)
            }
            observe(created.id, session.id, watch, generation.lost, handle, sink)
        } catch (error: Throwable) {
            val code = handle.commit(1)
            if (code != FerretExecutionHandle.CANCELLED_EXIT_CODE) {
                reportError(error, sink)
            }
            code
        } finally {
            if (handle.isCancellationRequested()) {
                cancellationJob?.join()
            } else {
                cancellationJob?.cancelAndJoin()
            }
            watch?.cancel()
            withContext(NonCancellable) {
                executionId?.let { id ->
                    try {
                        generation.rpc.closeExecution(id)
                    } catch (error: Throwable) {
                        sink.stderr("Warning: Ferret execution cleanup failed.")
                        sink.internal("Closing Ferret execution $id failed", error)
                    }
                }
                sessionId?.let { id ->
                    try {
                        generation.rpc.closeSession(id)
                    } catch (error: Throwable) {
                        sink.stderr("Warning: Ferret session cleanup failed.")
                        sink.internal("Closing Ferret session $id failed", error)
                    }
                }
            }
        }
    }

    private suspend fun observe(
        executionId: String,
        sessionId: String,
        watch: FerretdExecutionWatch,
        lost: Deferred<Throwable>,
        handle: FerretExecutionHandle,
        sink: FerretExecutionSink,
    ): Int {
        var sequence = 1L
        var started = false
        while (true) {
            val event = nextEvent(watch, lost)
                ?: throw FerretdRpcException("watch-execution", "The Ferret execution watch ended before a terminal event.")
            validateEvent(event, executionId, sessionId, sequence + 1L)
            sequence = event.sequence
            if (!started) {
                if (event.kind != FerretdExecutionState.RUNNING) {
                    throw FerretdRpcException("watch-execution", "The Ferret daemon returned an invalid execution lifecycle order.")
                }
                sink.system("Ferret execution started.")
                started = true
                continue
            }
            if (event.kind !in TERMINAL_STATES) {
                throw FerretdRpcException("watch-execution", "The Ferret daemon returned an event after execution started.")
            }
            val trailing = try {
                kotlinx.coroutines.withTimeout(5_000L) { watch.next() }
            } catch (_: kotlinx.coroutines.TimeoutCancellationException) {
                throw FerretdRpcException(
                    "watch-execution",
                    "The Ferret execution watch did not end after its terminal event.",
                )
            }
            if (trailing != null) {
                throw FerretdRpcException("watch-execution", "The Ferret daemon returned an event after its terminal event.")
            }
            return when (event.kind) {
                FerretdExecutionState.COMPLETED -> {
                    val output = event.execution.output
                        ?: throw FerretdRpcException("watch-execution", "The completed Ferret execution has no output.")
                    val formatted = FerretExecutionOutputFormatter.format(output)
                    val code = handle.commit(0)
                    if (code == 0) {
                        sink.stdout(formatted)
                        sink.system("Ferret execution completed.")
                    } else {
                        sink.system("Ferret execution cancelled.")
                    }
                    code
                }
                FerretdExecutionState.FAILED -> {
                    val code = handle.commit(1)
                    if (code == 1) {
                        renderFailure(event.execution.failure, sink)
                    } else {
                        sink.system("Ferret execution cancelled.")
                    }
                    code
                }
                FerretdExecutionState.CANCELLED -> {
                    val code = handle.commit(1)
                    if (code == 1) {
                        sink.stderr("The Ferret execution was cancelled unexpectedly.")
                    } else {
                        sink.system("Ferret execution cancelled.")
                    }
                    code
                }
                else -> error("unreachable")
            }
        }
    }

    private fun validateEvent(
        event: FerretdExecutionEvent,
        executionId: String,
        sessionId: String,
        expectedSequence: Long,
        expectedState: FerretdExecutionState? = null,
    ) {
        if (event.executionId != executionId || event.execution.id != executionId) {
            throw FerretdRpcException("watch-execution", "The Ferret daemon returned an event for another execution.")
        }
        if (event.sequence != expectedSequence) {
            throw FerretdRpcException("watch-execution", "The Ferret daemon returned an out-of-order execution event.")
        }
        if (expectedState != null && event.kind != expectedState) {
            throw FerretdRpcException("watch-execution", "The Ferret daemon returned an invalid execution lifecycle order.")
        }
        validateExecution(event.execution, executionId, sessionId, event.kind)
    }

    private suspend fun nextEvent(
        watch: FerretdExecutionWatch,
        lost: Deferred<Throwable>,
    ): FerretdExecutionEvent? = coroutineScope {
        val next = async { watch.next() }
        try {
            select {
                next.onAwait { it }
                lost.onAwait { throw it }
            }
        } finally {
            next.cancel()
        }
    }

    private fun validateExecution(
        value: FerretdExecutionSnapshot,
        executionId: String,
        sessionId: String,
        state: FerretdExecutionState,
    ) {
        if (
            value.id != executionId ||
            value.sessionId != sessionId ||
            value.state != state ||
            value.outputContentType != "application/json"
        ) {
            throw FerretdRpcException("execution", "The Ferret daemon returned a contradictory execution snapshot.")
        }
    }

    private fun sessionUriMatches(value: String, source: java.nio.file.Path): Boolean = try {
        val uri = URI(value)
        uri.scheme == "file" && java.nio.file.Path.of(uri).toRealPath() == source
    } catch (_: Exception) {
        false
    }

    private fun renderFailure(failure: FerretdFailure?, sink: FerretExecutionSink) {
        if (failure == null) {
            sink.stderr("Ferret execution failed.")
            return
        }
        if (failure.message.isNotBlank()) {
            sink.stderr(failure.message)
        }
        renderDiagnostics(failure.diagnostics, sink)
        if (failure.message.isBlank() && failure.diagnostics.isEmpty()) {
            sink.stderr("Ferret execution failed.")
        }
    }

    private fun reportError(error: Throwable, sink: FerretExecutionSink) {
        val rpc = error as? FerretdRpcException
        if (rpc != null && rpc.diagnostics.isNotEmpty()) {
            sink.stderr(rpc.message ?: "Ferret compilation failed.")
            renderDiagnostics(rpc.diagnostics, sink)
        } else {
            sink.stderr(error.message ?: "Ferret execution failed.")
        }
        sink.internal("Ferret execution failed", error)
    }

    private fun renderDiagnostics(diagnostics: List<FerretdDiagnostic>, sink: FerretExecutionSink) {
        diagnostics.forEach { diagnostic ->
            val code = diagnostic.code.takeUnless(String::isBlank)?.let { " [$it]" }.orEmpty()
            sink.stderr("${displayUri(diagnostic.uri)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}$code")
            sink.stderr(diagnostic.message)
            diagnostic.relatedInformation.forEach { related ->
                sink.stderr(
                    "Related: ${displayUri(related.uri)}:${related.range.start.line + 1}:" +
                        "${related.range.start.character + 1}",
                )
                sink.stderr(related.message)
            }
        }
    }

    private fun displayUri(value: String): String = try {
        val uri = URI(value)
        if (uri.scheme == "file") java.nio.file.Path.of(uri).toString() else value
    } catch (_: Exception) {
        value
    }

    companion object {
        private val TERMINAL_STATES = setOf(
            FerretdExecutionState.COMPLETED,
            FerretdExecutionState.FAILED,
            FerretdExecutionState.CANCELLED,
        )
    }
}
