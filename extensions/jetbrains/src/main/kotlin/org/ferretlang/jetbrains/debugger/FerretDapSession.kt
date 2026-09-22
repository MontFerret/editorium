package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.future.await
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.eclipse.lsp4j.debug.*
import org.eclipse.lsp4j.debug.services.IDebugProtocolClient
import org.eclipse.lsp4j.debug.services.IDebugProtocolServer
import org.ferretlang.jetbrains.daemon.FerretdBinary
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.launch.FerretLaunchInputResolver
import org.ferretlang.jetbrains.launch.FerretResolvedLaunchInput
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** One launch's state. Only the event loop mutates protocol state; requests never block that loop. */
internal class FerretDapSession(
    private val input: FerretLaunchInput,
    private val listener: FerretDapListener,
    private val executable: () -> Path = { FerretdBinary.installed().resolve() },
    private val startProcess: (Path) -> Process = { ProcessBuilder(it.toString(), "dap").start() },
    private val timeouts: FerretDapTimeouts = FerretDapTimeouts(),
) : IDebugProtocolClient {
    private val events = Channel<() -> Unit>(Channel.UNLIMITED)
    private val stopRequested = AtomicBoolean()
    private val started = AtomicBoolean()
    private lateinit var scope: CoroutineScope
    private var process: Process? = null
    private var transport: FerretDapTransport? = null
    private val server: IDebugProtocolServer get() = requireNotNull(transport).server
    private var startupTimer: Job? = null
    private var capabilities: Capabilities? = null
    private var initializedSeen = false
    private var initialCollected = false
    private var configuring = false
    private var launched = false
    private var ending = false
    private var targetTerminated = false
    private var exitCode: Int? = null
    private var failure = false
    @Volatile private var generation = 0L
    private var commandSequence = 0L
    @Volatile private var pendingCommand: Long? = null
    private var pendingBreakpoints = 0
    private val sourceRevisions = mutableMapOf<Path, Long>()
    private val breakpointKeys = mutableMapOf<Int, Long>()
    private val inspections = mutableMapOf<CompletableDeferred<*>, () -> Unit>()
    private val inspectionEnded = CompletableDeferred<Unit>()
    @Volatile private var confirmedStop: FerretDapStop? = null
    @Volatile private var inspectable = false
    @Volatile var ready: Boolean = false
        private set
    @Volatile var resolvedInput: FerretResolvedLaunchInput? = null
        private set
    val completion = CompletableDeferred<Int>()
    val launchCompleted = CompletableDeferred<Unit>()

    suspend fun run(): Unit = coroutineScope {
        check(started.compareAndSet(false, true)) { "A Ferret DAP session can only be launched once." }
        scope = this
        try {
            startupTimer = launch {
                delay(timeouts.startupMillis)
                enqueue { fail(IllegalStateException("The Ferret debug launch timed out.")) }
            }
            val resolved = withContext(Dispatchers.IO) { FerretLaunchInputResolver.resolve(input) }
            resolvedInput = resolved
            if (!stopRequested.get()) {
                val binary = withContext(Dispatchers.IO) { executable() }
                // Publish ownership inside the non-cancellable region: cancellation must not discard a new child.
                withContext(NonCancellable) {
                    withContext(Dispatchers.IO) { process = startProcess(binary) }
                }
                val adapter = requireNotNull(process)
                if (!stopRequested.get()) {
                    transport = FerretDapTransport(this, adapter.inputStream, adapter.outputStream, this@FerretDapSession) {
                        enqueue { fail(IllegalStateException("The Ferret debug adapter connection failed.", it)) }
                    }
                    launch(Dispatchers.IO) {
                        try {
                            // Drain diagnostics without copying potentially sensitive runtime text into IDE logs.
                            adapter.errorStream.use { it.copyTo(java.io.OutputStream.nullOutputStream()) }
                        } catch (error: Exception) {
                            FerretDapErrors.log("diagnostic stream", error)
                        }
                    }
                    launch(Dispatchers.IO) {
                        runInterruptible { adapter.waitFor() }
                        // Drain terminal events before classifying process exit as unexpected.
                        withTimeoutOrNull(timeouts.shutdownMillis) { transport?.reader?.join() }
                        enqueue { fail(IllegalStateException("The Ferret debug adapter exited unexpectedly.")) }
                    }
                    request("initialize", {
                        server.initialize(InitializeRequestArguments().apply {
                            clientID = "ferret-jetbrains"
                            adapterID = "ferretd"
                            linesStartAt1 = true
                            columnsStartAt1 = true
                            pathFormat = "path"
                            supportsVariableType = true
                            supportsRunInTerminalRequest = false
                        })
                    }) { result ->
                        capabilities = result
                        check(result.supportsConfigurationDoneRequest == true) { "The Ferret adapter does not support configurationDone." }
                        launched = true
                        request("launch", { server.launch(FerretDapLaunchArguments.from(resolved)) }, startup = true) {
                            ready = true
                            startupTimer?.cancel()
                            launchCompleted.complete(Unit)
                        }
                    }
                    while (!ending && !stopRequested.get()) events.receive().invoke()
                }
            }
        } catch (_: CancellationException) {
            stopRequested.set(true)
        } catch (error: Throwable) {
            fail(error)
        } finally {
            ending = true
            ready = false
            invalidateInspection()
            confirmedStop = null
            inspectionEnded.complete(Unit)
            // Completed consoles can retain this session; release queued responses and their runtime values.
            events.cancel()
            coroutineContext.cancelChildren()
            withContext(NonCancellable) {
                try {
                    withContext(Dispatchers.IO) { cleanup() }
                } catch (error: Exception) {
                    failure = true
                    FerretDapErrors.log("cleanup", error)
                }
                val code = exitCode ?: when {
                    failure -> 1
                    stopRequested.get() -> 130
                    targetTerminated -> 0
                    else -> 1
                }
                try {
                    listener.terminated(code)
                } finally {
                    completion.complete(code)
                    if (!launchCompleted.isCompleted) launchCompleted.completeExceptionally(CancellationException("Ferret Debug did not launch."))
                }
            }
        }
    }

    fun stop() {
        stopRequested.set(true)
        enqueue { ending = true }
    }

    fun isCurrentStop(stop: FerretDapStop): Boolean =
        inspectable && confirmedStop === stop && !stopRequested.get() && scope.isActive

    fun canPerformCommands(): Boolean = ready && pendingCommand == null && !stopRequested.get()

    fun isRunningAfter(generation: Long): Boolean =
        ready && !inspectable && confirmedStop == null && this.generation == generation && !stopRequested.get()

    fun replaceBreakpoints(batch: FerretDapBreakpoints) = enqueue {
        check(initializedSeen) { "Breakpoints cannot be synchronized before initialized." }
        sourceRevisions[batch.source] = batch.revision
        pendingBreakpoints++
        val arguments = SetBreakpointsArguments().apply {
            source = Source().apply { path = batch.source.toString() }
            breakpoints = batch.entries.map { entry -> SourceBreakpoint().apply { line = entry.line } }.toTypedArray()
        }
        request("setBreakpoints", { server.setBreakpoints(arguments) }, failed = { error ->
            listener.breakpoints(batch, emptyList(), error.message ?: "Breakpoint synchronization failed.")
            fail(error)
        }) { response ->
            val results = response.breakpoints?.toList()
                ?: throw IllegalStateException("The Ferret adapter omitted breakpoint results.")
            check(results.size == batch.entries.size) { "The Ferret adapter returned an incomplete breakpoint replacement." }
            results.zip(batch.entries).forEach { (result, entry) ->
                result.id?.let { breakpointKeys[it] = entry.key }
            }
            if (sourceRevisions[batch.source] == batch.revision) listener.breakpoints(batch, results, null)
            pendingBreakpoints--
            finishConfiguration()
        }
    }

    fun command(command: FerretDapCommand, stop: FerretDapStop? = null) = enqueue {
        if (!ready || pendingCommand != null) return@enqueue
        val pausing = command == FerretDapCommand.PAUSE
        if (pausing && confirmedStop != null) return@enqueue
        if (!pausing && (stop == null || !isCurrentStop(stop))) return@enqueue
        val previous = confirmedStop
        val sequence = ++commandSequence
        pendingCommand = sequence
        if (!pausing) invalidateInspection()
        val thread = previous?.threadId ?: FERRET_THREAD
        request("${command.name.lowercase()}", {
            when (command) {
                FerretDapCommand.CONTINUE -> server.continue_(ContinueArguments().apply { threadId = thread })
                FerretDapCommand.PAUSE -> server.pause(PauseArguments().apply { threadId = thread })
                FerretDapCommand.NEXT -> server.next(NextArguments().apply { threadId = thread })
                FerretDapCommand.STEP_IN -> server.stepIn(StepInArguments().apply { threadId = thread })
                FerretDapCommand.STEP_OUT -> server.stepOut(StepOutArguments().apply { threadId = thread })
            }
        }, failed = { error ->
            if (error !is org.eclipse.lsp4j.jsonrpc.ResponseErrorException) {
                fail(error)
                return@request
            }
            if (pendingCommand == sequence) {
                pendingCommand = null
                // Rejection preserves the backend stop, but must never revive old requests or UI handles.
                confirmedStop = previous?.copy(generation = ++generation)
                inspectable = confirmedStop != null
                confirmedStop?.let(listener::stopped)
            }
            listener.error("Ferret ${command.name.lowercase()} failed: ${error.message}")
        }) {
            if (pendingCommand == sequence) {
                pendingCommand = null
                if (!pausing && confirmedStop === previous) {
                    confirmedStop = null
                    previous?.let { listener.resumed(it.generation) }
                }
            }
        }
    }

    suspend fun stackTrace(stop: FerretDapStop, start: Int, count: Int): StackTraceResponse? =
        inspect(stop, "stackTrace") {
            server.stackTrace(StackTraceArguments().apply {
                threadId = stop.threadId
                startFrame = start
                levels = count
            })
        }

    suspend fun scopes(stop: FerretDapStop, frameId: Int): ScopesResponse? = inspect(stop, "scopes") {
        server.scopes(ScopesArguments().apply { this.frameId = frameId })
    }

    suspend fun variables(stop: FerretDapStop, reference: Int): VariablesResponse? {
        if (!isCurrentStop(stop)) return null
        // Leaf values have no remote children, including summarized collections.
        if (reference <= 0) return VariablesResponse().apply { variables = emptyArray() }
        return inspect(stop, "variables") {
            server.variables(VariablesArguments().apply { variablesReference = reference })
        }
    }

    suspend fun evaluate(stop: FerretDapStop, frameId: Int, expression: String): EvaluateResponse? =
        inspect(stop, "evaluate") {
            server.evaluate(EvaluateArguments().apply {
                this.frameId = frameId
                this.expression = expression
            })
        }

    private suspend fun <T> inspect(stop: FerretDapStop, name: String, operation: () -> CompletableFuture<T>): T? {
        if (!isCurrentStop(stop)) return null
        val result = CompletableDeferred<T?>()
        if (!enqueue {
            if (!isCurrentStop(stop)) {
                result.complete(null)
            } else {
                val abandon = request(name, operation, fatalTimeout = false, failed = {
                    inspections.remove(result)
                    if (isCurrentStop(stop)) {
                        FerretDapErrors.log(name, it)
                        result.completeExceptionally(it)
                    } else result.complete(null)
                }) {
                    inspections.remove(result)
                    result.complete(if (isCurrentStop(stop)) it else null)
                }
                if (!result.isCompleted) inspections[result] = { abandon(); result.complete(null) }
            }
        }) return null
        try {
            return select {
                result.onAwait { it }
                inspectionEnded.onAwait { null }
            }
        } finally {
            enqueue { inspections.remove(result)?.invoke() }
        }
    }

    private fun invalidateInspection() {
        inspectable = false
        inspections.values.forEach { it() }
        inspections.clear()
    }

    override fun initialized() { enqueue {
        check(!initializedSeen && launched) { "The Ferret adapter sent initialized outside launch." }
        initializedSeen = true
        scope.launch {
            try {
                listener.initializeBreakpoints()
                enqueue {
                    initialCollected = true
                    finishConfiguration()
                }
            } catch (error: Exception) {
                enqueue { fail(error) }
            }
        }
    } }

    override fun stopped(args: StoppedEventArguments) { enqueue {
        invalidateInspection()
        val stop = FerretDapStop(
            ++generation, args.threadId ?: FERRET_THREAD, args.reason,
            args.description ?: args.text, args.hitBreakpointIds.orEmpty().mapNotNull(breakpointKeys::get),
        )
        pendingCommand = null
        confirmedStop = stop
        inspectable = true
        listener.stopped(stop)
    } }

    override fun output(args: OutputEventArguments) { enqueue {
        listener.output(args.output, args.category == "stderr")
    } }

    override fun exited(args: ExitedEventArguments) { enqueue { exitCode = args.exitCode } }

    override fun terminated(args: TerminatedEventArguments?) { enqueue {
        invalidateInspection()
        targetTerminated = true
        ending = true
    } }

    private fun finishConfiguration() {
        if (!initialCollected || pendingBreakpoints != 0 || configuring || ending || stopRequested.get()) return
        configuring = true
        request("configurationDone", { server.configurationDone(ConfigurationDoneArguments()) }) { }
    }

    private fun <T> request(
        name: String,
        operation: () -> CompletableFuture<T>,
        startup: Boolean = false,
        fatalTimeout: Boolean = true,
        failed: (Throwable) -> Unit = ::fail,
        succeeded: (T) -> Unit,
    ): () -> Unit {
        var delivered = false
        val future = try {
            operation()
        } catch (error: Exception) {
            failed(error)
            return {}
        }
        val timer = if (startup) null else scope.launch {
            delay(timeouts.requestMillis)
            enqueue {
                if (!delivered) {
                    delivered = true
                    // Control acceptance is unknown after a timeout; read-only inspection can fail locally.
                    val error = IllegalStateException("Ferret DAP $name timed out.")
                    failed(error)
                    if (fatalTimeout) fail(error)
                }
            }
        }
        future.whenComplete { value, error -> enqueue {
            if (!delivered) {
                delivered = true
                timer?.cancel()
                if (error == null) {
                    try { succeeded(value) } catch (invalid: Exception) { failed(invalid) }
                } else failed(error.cause ?: error)
            }
        } }
        // Called only by the state queue. Do not emit unsupported DAP cancellation requests.
        return { delivered = true; timer?.cancel() }
    }

    private fun enqueue(event: () -> Unit): Boolean = events.trySend {
        if (!ending && !stopRequested.get()) event()
    }.isSuccess

    private fun fail(error: Throwable) {
        if (ending || stopRequested.get()) return
        failure = true
        ending = true
        invalidateInspection()
        launchCompleted.completeExceptionally(error)
        FerretDapErrors.log("session", error)
        LOG.warn("Ferret Debug session failed (${error.javaClass.simpleName}).")
        listener.error(error.message ?: "Ferret Debug failed. See the IDE log for details.")
    }

    private suspend fun cleanup() {
        val connection = transport
        if (connection != null) {
            if (launched && !targetTerminated && capabilities?.supportsTerminateRequest == true) {
                cleanupRequest("terminate") { connection.server.terminate(TerminateArguments()) }
            }
            cleanupRequest("disconnect") { connection.server.disconnect(DisconnectArguments().apply { terminateDebuggee = true }) }
            try { connection.close() } catch (error: Exception) { FerretDapErrors.log("transport cleanup", error) }
        }
        process?.let { adapter ->
            try {
                runCatching { adapter.outputStream.close() }
                if (!adapter.waitFor(timeouts.shutdownMillis, TimeUnit.MILLISECONDS)) {
                    adapter.destroy()
                    if (!adapter.waitFor(timeouts.shutdownMillis, TimeUnit.MILLISECONDS)) {
                        adapter.destroyForcibly()
                        if (!adapter.waitFor(timeouts.shutdownMillis, TimeUnit.MILLISECONDS)) {
                            LOG.warn("The owned Ferret DAP process did not exit after forced termination.")
                        }
                    }
                }
            } finally {
                runCatching { adapter.inputStream.close() }
                runCatching { adapter.errorStream.close() }
            }
        }
        breakpointKeys.clear()
        sourceRevisions.clear()
        transport = null
        process = null
        resolvedInput = null
    }

    private suspend fun cleanupRequest(name: String, operation: () -> CompletableFuture<*>) {
        try {
            withTimeout(timeouts.shutdownMillis) { operation().await() }
        } catch (error: Exception) {
            FerretDapErrors.log("$name cleanup", error)
        }
    }

    companion object {
        private const val FERRET_THREAD = 1
        private val LOG = Logger.getInstance(FerretDapSession::class.java)
    }
}
