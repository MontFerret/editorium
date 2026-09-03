package org.ferretlang.jetbrains.daemon

import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.execution.FerretdRpc
import java.nio.charset.StandardCharsets
import java.nio.file.Path
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

@Service(Service.Level.PROJECT)
internal class FerretdDaemonConnection private constructor(
    private val coroutineScope: CoroutineScope,
    private val installationProvider: () -> FerretdInstallation,
    private val processStarter: (FerretdInstallation, String) -> Process,
    private val rpcConnector: (Int, String) -> FerretdRpc,
    private val startupTimeoutMillis: Long,
) {
    constructor(
        @Suppress("UNUSED_PARAMETER") project: Project,
        coroutineScope: CoroutineScope,
    ) : this(
        coroutineScope,
        { FerretdBinary.installed().resolveInstallation() },
        ::startProcess,
        GrpcFerretdRpc::connect,
        STARTUP_TIMEOUT_MILLIS,
    )

    private val mutex = Mutex()
    private val sequence = AtomicLong()
    private var active: Generation? = null
    private var starting: Deferred<Generation>? = null
    private val lifetime = coroutineScope.launch {
        try {
            awaitCancellation()
        } finally {
            withContext(NonCancellable) {
                shutdown()
            }
        }
    }

    internal fun launchRun(block: suspend CoroutineScope.() -> Unit): Job = coroutineScope.launch(block = block)

    internal suspend fun generation(): Generation {
        val pending = mutex.withLock {
            active?.takeUnless { it.lost.isCompleted }?.let { return it }
            starting ?: coroutineScope.async(start = CoroutineStart.LAZY) {
                startGeneration(sequence.incrementAndGet())
            }.also { starting = it }
        }
        try {
            val generation = pending.await()
            val accepted = mutex.withLock {
                if (starting === pending) {
                    starting = null
                    if (!generation.lost.isCompleted) {
                        active = generation
                        true
                    } else {
                        false
                    }
                } else {
                    active === generation && !generation.lost.isCompleted
                }
            }
            if (!accepted) {
                val cause = if (generation.lost.isCompleted) {
                    generation.lost.await()
                } else {
                    FerretdConnectionException("The Ferret daemon startup was cancelled during project shutdown.")
                }
                withContext(NonCancellable) {
                    stopGeneration(generation)
                }
                throw cause
            }
            return generation
        } catch (error: Throwable) {
            mutex.withLock {
                if (starting === pending) {
                    starting = null
                }
            }
            throw error
        }
    }

    internal suspend fun workspace(generation: Generation, root: Path): String {
        ensureCurrent(generation)
        val pending = generation.workspaceMutex.withLock {
            generation.workspaces[root] ?: coroutineScope.async(start = CoroutineStart.LAZY) {
                val workspace = generation.rpc.openWorkspace(root)
                if (workspace.root != root) {
                    throw FerretdConnectionException(
                        "The Ferret daemon opened ${workspace.root} instead of the requested workspace $root.",
                    )
                }
                workspace.id
            }.also { generation.workspaces[root] = it }
        }
        return try {
            pending.await().also { ensureCurrent(generation) }
        } catch (error: Throwable) {
            generation.workspaceMutex.withLock {
                if (generation.workspaces[root] === pending) {
                    generation.workspaces.remove(root)
                }
            }
            throw error
        }
    }

    internal suspend fun shutdown() {
        val (generation, pending) = mutex.withLock {
            val current = active
            val startup = starting
            active = null
            starting = null
            current to startup
        }
        pending?.cancel()
        val started = withContext(NonCancellable) {
            try {
                pending?.await()
            } catch (_: Throwable) {
                null
            }
        }
        generation?.let { stopGeneration(it) }
        if (started != null && started !== generation) {
            stopGeneration(started)
        }
    }

    internal suspend fun closeForTest() {
        lifetime.cancelAndJoin()
    }

    private suspend fun startGeneration(number: Long): Generation {
        val installation = withContext(Dispatchers.IO) { installationProvider() }
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(TOKEN_BYTES).also(SecureRandom()::nextBytes))
        LOG.info("Starting project Ferret execution daemon")
        val process = try {
            withContext(Dispatchers.IO) { processStarter(installation, token) }
        } catch (error: Exception) {
            throw FerretdConnectionException("Cannot start the bundled Ferret daemon.", error)
        }
        val ready = CompletableDeferred<FerretdReadyEvent>()
        val lost = CompletableDeferred<Throwable>()
        val stopping = AtomicBoolean()
        val readySeen = AtomicBoolean()
        val stderr = readStderr(process, installation.version, ready, lost, readySeen)
        val stdout = drainStdout(process)
        val processWaiter = observeProcess(process, ready, lost, stopping)
        var rpc: FerretdRpc? = null
        try {
            val event = withTimeout(startupTimeoutMillis) { ready.await() }
            rpc = rpcConnector(event.port, token)
            val info = rpc.getInfo()
            if (
                info.version != installation.version ||
                info.instanceId.isBlank() ||
                info.apiMajor != GrpcFerretdRpc.API_MAJOR ||
                info.apiMinor != GrpcFerretdRpc.API_MINOR
            ) {
                throw FerretdConnectionException(
                    "Incompatible Ferret daemon: expected ${installation.version} API " +
                        "${GrpcFerretdRpc.API_MAJOR}.${GrpcFerretdRpc.API_MINOR}, got ${info.version} API " +
                        "${info.apiMajor}.${info.apiMinor}.",
                )
            }
            val generation = Generation(number, process, rpc, lost, stopping, stderr, stdout, processWaiter)
            coroutineScope.launch {
                val cause = lost.await()
                invalidate(generation, cause)
            }
            LOG.info("Project Ferret execution daemon started (${installation.version})")
            return generation
        } catch (error: Throwable) {
            stopping.set(true)
            try {
                rpc?.close()
            } catch (cleanup: Throwable) {
                LOG.warn("Closing a failed Ferret daemon channel failed", cleanup)
            }
            withContext(Dispatchers.IO) {
                process.destroy()
                if (!process.waitFor(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    process.destroyForcibly()
                }
            }
            stderr.cancel()
            stdout.cancel()
            processWaiter.cancel()
            throw if (error is FerretdConnectionException) error else {
                FerretdConnectionException("The Ferret daemon failed during startup: ${error.message}", error)
            }
        }
    }

    private fun readStderr(
        process: Process,
        version: String,
        ready: CompletableDeferred<FerretdReadyEvent>,
        lost: CompletableDeferred<Throwable>,
        readySeen: AtomicBoolean,
    ): Job = coroutineScope.launch(Dispatchers.IO) {
        try {
            process.errorStream.bufferedReader(StandardCharsets.UTF_8).useLines { lines ->
                lines.forEach { line ->
                    LOG.debug("ferretd stderr: $line")
                    val event = try {
                        FerretdReadyEvent.parse(line, version)
                    } catch (error: Throwable) {
                        ready.completeExceptionally(error)
                        return@forEach
                    }
                    if (event != null) {
                        if (readySeen.compareAndSet(false, true)) {
                            ready.complete(event)
                        } else {
                            lost.complete(FerretdConnectionException("The Ferret daemon reported readiness more than once."))
                        }
                    }
                }
            }
        } catch (error: Throwable) {
            if (!ready.isCompleted) {
                ready.completeExceptionally(error)
            }
        }
    }

    private fun drainStdout(process: Process): Job = coroutineScope.launch(Dispatchers.IO) {
        try {
            process.inputStream.bufferedReader(StandardCharsets.UTF_8).useLines { lines ->
                lines.forEach { LOG.debug("ferretd stdout: $it") }
            }
        } catch (error: Throwable) {
            LOG.debug("Reading Ferret daemon stdout stopped", error)
        }
    }

    private fun observeProcess(
        process: Process,
        ready: CompletableDeferred<FerretdReadyEvent>,
        lost: CompletableDeferred<Throwable>,
        stopping: AtomicBoolean,
    ): Job = coroutineScope.launch(Dispatchers.IO) {
        val exit = process.waitFor()
        if (!stopping.get()) {
            val error = FerretdConnectionException("The Ferret daemon exited unexpectedly with code $exit.")
            ready.completeExceptionally(error)
            lost.complete(error)
        }
    }

    private suspend fun invalidate(generation: Generation, cause: Throwable) {
        if (generation.stopping.get() || !generation.cleanupStarted.compareAndSet(false, true)) {
            return
        }
        try {
            mutex.withLock {
                if (active === generation) {
                    active = null
                }
            }
            generation.workspaceMutex.withLock { generation.workspaces.clear() }
            try {
                generation.rpc.close()
            } catch (error: Throwable) {
                LOG.warn("Closing a lost Ferret daemon channel failed", error)
            }
            generation.stderr.cancel()
            generation.stdout.cancel()
            generation.processWaiter.cancel()
            LOG.warn("Project Ferret execution daemon was lost", cause)
        } finally {
            generation.stopped.complete(Unit)
        }
    }

    private suspend fun stopGeneration(generation: Generation) {
        generation.stopping.set(true)
        if (!generation.cleanupStarted.compareAndSet(false, true)) {
            generation.stopped.await()
            return
        }
        try {
            generation.workspaceMutex.withLock { generation.workspaces.clear() }
            try {
                generation.rpc.shutdown()
            } catch (error: Throwable) {
                LOG.warn("Graceful Ferret daemon shutdown failed", error)
            }
            try {
                generation.rpc.close()
            } catch (error: Throwable) {
                LOG.warn("Closing the Ferret daemon channel failed", error)
            }
            withContext(Dispatchers.IO) {
                if (!generation.process.waitFor(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    generation.process.destroy()
                    if (!generation.process.waitFor(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                        generation.process.destroyForcibly()
                    }
                }
            }
            generation.stderr.cancel()
            generation.stdout.cancel()
            generation.processWaiter.cancel()
            generation.lost.complete(FerretdConnectionException("The Ferret daemon was shut down."))
            LOG.info("Project Ferret execution daemon stopped")
        } finally {
            generation.stopped.complete(Unit)
        }
    }

    private suspend fun ensureCurrent(generation: Generation) {
        if (generation.lost.isCompleted) {
            throw generation.lost.await()
        }
        if (mutex.withLock { active !== generation }) {
            throw FerretdConnectionException("The Ferret daemon generation is no longer active.")
        }
    }

    internal class Generation(
        val number: Long,
        val process: Process,
        val rpc: FerretdRpc,
        val lost: CompletableDeferred<Throwable>,
        val stopping: AtomicBoolean,
        val stderr: Job,
        val stdout: Job,
        val processWaiter: Job,
    ) {
        val workspaceMutex = Mutex()
        val workspaces = mutableMapOf<Path, Deferred<String>>()
        val cleanupStarted = AtomicBoolean()
        val stopped = CompletableDeferred<Unit>()
    }

    companion object {
        private val LOG = Logger.getInstance(FerretdDaemonConnection::class.java)
        private const val TOKEN_ENVIRONMENT = "FERRETD_AUTH_TOKEN"
        private const val TOKEN_BYTES = 32
        private const val STARTUP_TIMEOUT_MILLIS = 10_000L
        private const val SHUTDOWN_TIMEOUT_SECONDS = 5L

        internal fun testing(
            coroutineScope: CoroutineScope,
            installationProvider: () -> FerretdInstallation,
            processStarter: (FerretdInstallation, String) -> Process,
            rpcConnector: (Int, String) -> FerretdRpc,
        ): FerretdDaemonConnection = testing(
            coroutineScope,
            installationProvider,
            processStarter,
            rpcConnector,
            STARTUP_TIMEOUT_MILLIS,
        )

        internal fun testing(
            coroutineScope: CoroutineScope,
            installationProvider: () -> FerretdInstallation,
            processStarter: (FerretdInstallation, String) -> Process,
            rpcConnector: (Int, String) -> FerretdRpc,
            startupTimeoutMillis: Long = STARTUP_TIMEOUT_MILLIS,
        ): FerretdDaemonConnection = FerretdDaemonConnection(
            coroutineScope,
            installationProvider,
            processStarter,
            rpcConnector,
            startupTimeoutMillis,
        )

        internal fun testing(
            coroutineScope: CoroutineScope,
            installation: FerretdInstallation,
        ): FerretdDaemonConnection = FerretdDaemonConnection(
            coroutineScope,
            { installation },
            ::startProcess,
            GrpcFerretdRpc::connect,
            STARTUP_TIMEOUT_MILLIS,
        )

        private fun startProcess(installation: FerretdInstallation, token: String): Process {
            val command = listOf(
                installation.executable.toString(),
                "serve",
                "--endpoint",
                "tcp://127.0.0.1:0",
                "--auth-token-env=$TOKEN_ENVIRONMENT",
            )
            return ProcessBuilder(command).apply {
                environment()[TOKEN_ENVIRONMENT] = token
            }.start()
        }
    }
}
