package org.ferretlang.jetbrains.daemon

import com.intellij.openapi.diagnostic.Logger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.execution.FerretdRpc
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal class FerretdDaemonLauncher private constructor(
    private val coroutineScope: CoroutineScope,
    private val installationProvider: () -> FerretdInstallation,
    private val processStarter: (FerretdInstallation, String) -> Process,
    private val rpcConnector: (Int, String) -> FerretdRpc,
    private val startupTimeoutMillis: Long,
) {
    constructor(coroutineScope: CoroutineScope) : this(
        coroutineScope,
        { FerretdBinary.installed().resolveInstallation() },
        ::startProcess,
        GrpcFerretdRpc::connect,
        STARTUP_TIMEOUT_MILLIS,
    )

    internal constructor(
        coroutineScope: CoroutineScope,
        installation: FerretdInstallation,
    ) : this(
        coroutineScope,
        { installation },
        ::startProcess,
        GrpcFerretdRpc::connect,
        STARTUP_TIMEOUT_MILLIS,
    )

    suspend fun start(): StartedFerretdDaemon {
        val installation = withContext(Dispatchers.IO) { installationProvider() }
        val token = Base64.getUrlEncoder().withoutPadding().encodeToString(
            ByteArray(TOKEN_BYTES).also(SecureRandom()::nextBytes),
        )
        LOG.info("Starting project Ferret execution daemon")
        currentCoroutineContext().ensureActive()
        val process = try {
            // Keep these contexts nested: switching dispatchers in the outer context
            // would let cancellation discard the newly created process on return.
            withContext(NonCancellable) {
                withContext(Dispatchers.IO) { processStarter(installation, token) }
            }
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
            LOG.info("Project Ferret execution daemon started (${installation.version})")
            return StartedFerretdDaemon(process, rpc, lost, stopping, stderr, stdout, processWaiter)
        } catch (error: Throwable) {
            withContext(NonCancellable) {
                stopping.set(true)
                try {
                    rpc?.close()
                } catch (cleanup: Throwable) {
                    LOG.warn("Closing a failed Ferret daemon channel failed", cleanup)
                }
                try {
                    withContext(Dispatchers.IO) {
                        process.destroy()
                        if (!process.waitFor(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                            process.destroyForcibly()
                        }
                    }
                } catch (cleanup: Throwable) {
                    LOG.warn("Stopping a failed Ferret daemon process failed", cleanup)
                }
                stderr.cancel()
                stdout.cancel()
                processWaiter.cancel()
            }
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
                    LOG.debug("ferretd stderr: ${redactCredentials(line)}")
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
                lines.forEach { LOG.debug("ferretd stdout: ${redactCredentials(it)}") }
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

    private fun redactCredentials(value: String): String = CREDENTIAL_PATTERN.replace(value) { match ->
        match.groupValues[1] + "<redacted>"
    }

    companion object {
        private val LOG = Logger.getInstance(FerretdDaemonLauncher::class.java)
        private val CREDENTIAL_PATTERN = Regex(
            "(?i)(authorization\\s*[:=]\\s*Bearer\\s+|FERRETD_AUTH_TOKEN\\s*[:=]\\s*)[A-Za-z0-9_-]+",
        )
        private const val TOKEN_ENVIRONMENT = "FERRETD_AUTH_TOKEN"
        private const val TOKEN_BYTES = 32
        private const val STARTUP_TIMEOUT_MILLIS = 10_000L
        private const val SHUTDOWN_TIMEOUT_SECONDS = 5L

        internal fun testing(
            coroutineScope: CoroutineScope,
            installationProvider: () -> FerretdInstallation,
            processStarter: (FerretdInstallation, String) -> Process,
            rpcConnector: (Int, String) -> FerretdRpc,
            startupTimeoutMillis: Long = STARTUP_TIMEOUT_MILLIS,
        ): FerretdDaemonLauncher = FerretdDaemonLauncher(
            coroutineScope,
            installationProvider,
            processStarter,
            rpcConnector,
            startupTimeoutMillis,
        )

        internal fun command(installation: FerretdInstallation): List<String> = listOf(
            installation.executable.toString(),
            "serve",
            "--endpoint",
            "tcp://127.0.0.1:0",
            "--auth-token-env=$TOKEN_ENVIRONMENT",
        )

        private fun startProcess(installation: FerretdInstallation, token: String): Process {
            return ProcessBuilder(command(installation)).apply {
                environment()[TOKEN_ENVIRONMENT] = token
            }.start()
        }
    }
}
