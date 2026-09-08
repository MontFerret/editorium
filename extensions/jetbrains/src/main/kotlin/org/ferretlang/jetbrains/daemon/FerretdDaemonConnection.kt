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
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.ferretlang.jetbrains.execution.FerretdRpc
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

@Service(Service.Level.PROJECT)
internal class FerretdDaemonConnection private constructor(
    private val coroutineScope: CoroutineScope,
    private val launcher: FerretdDaemonLauncher,
) {
    constructor(
        @Suppress("UNUSED_PARAMETER") project: Project,
        coroutineScope: CoroutineScope,
    ) : this(
        coroutineScope,
        FerretdDaemonLauncher(coroutineScope),
    )

    private val mutex = Mutex()
    private val sequence = AtomicLong()
    private var active: Generation? = null
    private val generations = mutableSetOf<Generation>()
    private var starting: Deferred<Generation>? = null
    private var closed = false
    private val lifetime = coroutineScope.launch(start = CoroutineStart.UNDISPATCHED) {
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
            checkOpen()
            active?.let { generation ->
                if (!generation.process.isAlive) {
                    generation.lost.complete(FerretdConnectionException("The Ferret daemon exited unexpectedly."))
                }
                if (!generation.lost.isCompleted) return generation
            }
            starting ?: coroutineScope.async(start = CoroutineStart.LAZY) {
                try {
                    startGeneration(sequence.incrementAndGet())
                } finally {
                    withContext(NonCancellable) {
                        mutex.withLock { starting = null }
                    }
                }
            }.also { starting = it }
        }
        // Awaiters borrow startup. Only the project-owned job publishes or discards it.
        return pending.await().also { ensureCurrent(it) }
    }

    internal suspend fun workspace(generation: Generation, root: Path): String {
        ensureCurrent(generation)
        val pending = generation.workspaceMutex.withLock {
            generation.workspaces[root] ?: coroutineScope.async(start = CoroutineStart.LAZY) {
                try {
                    val workspace = generation.rpc.openWorkspace(root)
                    if (workspace.root != root) {
                        throw FerretdConnectionException("The Ferret daemon opened a different workspace than requested.")
                    }
                    workspace.id
                } catch (error: Throwable) {
                    withContext(NonCancellable) {
                        generation.workspaceMutex.withLock { generation.workspaces.remove(root) }
                    }
                    throw error
                }
            }.also { generation.workspaces[root] = it }
        }
        return pending.await().also { ensureCurrent(generation) }
    }

    internal suspend fun shutdown() {
        val (owned, pending) = mutex.withLock {
            closed = true
            val current = generations.toList()
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
        owned.forEach { stopGeneration(it) }
        if (started != null && started !in owned) {
            stopGeneration(started)
        }
    }

    internal suspend fun closeForTest() {
        lifetime.cancelAndJoin()
    }

    private suspend fun startGeneration(number: Long): Generation {
        val generation = Generation(number, launcher.start())
        try {
            mutex.withLock {
                checkOpen()
                if (generation.lost.isCompleted) throw generation.lost.await()
                generations.add(generation)
                active = generation
            }
            coroutineScope.launch {
                val cause = generation.lost.await()
                withContext(NonCancellable) { invalidate(generation, cause) }
            }
            return generation
        } catch (error: Throwable) {
            withContext(NonCancellable) { stopGeneration(generation, graceful = false) }
            throw error
        }
    }

    private suspend fun invalidate(generation: Generation, cause: Throwable) {
        if (generation.stopping.get()) return
        mutex.withLock {
            if (active === generation) active = null
        }
        stopGeneration(generation, graceful = false)
        LOG.warn("Project Ferret execution daemon was lost", cause)
    }

    private suspend fun stopGeneration(generation: Generation, graceful: Boolean = true) {
        generation.stopping.set(true)
        if (!generation.cleanupStarted.compareAndSet(false, true)) {
            generation.stopped.await()
            return
        }
        try {
            generation.workspaceMutex.withLock {
                generation.workspaces.values.forEach { it.cancel() }
                generation.workspaces.clear()
            }
            if (graceful && generation.process.isAlive && !generation.lost.isCompleted) {
                try {
                    generation.rpc.shutdown()
                } catch (error: Throwable) {
                    LOG.warn("Graceful Ferret daemon shutdown failed", error)
                }
            }
            try {
                generation.rpc.close()
            } catch (error: Throwable) {
                LOG.warn("Closing the Ferret daemon channel failed", error)
            }
            withContext(Dispatchers.IO) {
                if (!graceful && generation.process.isAlive) generation.process.destroy()
                if (!generation.process.waitFor(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    generation.process.destroy()
                    if (!generation.process.waitFor(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                        generation.process.destroyForcibly()
                        if (!generation.process.waitFor(SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                            LOG.warn("The Ferret daemon did not exit after forced termination")
                        }
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
            mutex.withLock { generations.remove(generation) }
        }
    }

    private fun checkOpen() {
        if (closed || !coroutineScope.isActive) {
            throw FerretdConnectionException("The Ferret project is closing; execution is unavailable.")
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
        daemon: StartedFerretdDaemon,
    ) {
        val process: Process = daemon.process
        val rpc: FerretdRpc = daemon.rpc
        val lost: CompletableDeferred<Throwable> = daemon.lost
        val stopping: AtomicBoolean = daemon.stopping
        val stderr: Job = daemon.stderr
        val stdout: Job = daemon.stdout
        val processWaiter: Job = daemon.processWaiter
        val workspaceMutex = Mutex()
        val workspaces = mutableMapOf<Path, Deferred<String>>()
        val cleanupStarted = AtomicBoolean()
        val stopped = CompletableDeferred<Unit>()
    }

    companion object {
        private val LOG = Logger.getInstance(FerretdDaemonConnection::class.java)
        private const val SHUTDOWN_TIMEOUT_SECONDS = 5L

        internal fun testing(
            coroutineScope: CoroutineScope,
            launcher: FerretdDaemonLauncher,
        ): FerretdDaemonConnection = FerretdDaemonConnection(coroutineScope, launcher)

        internal fun testing(
            coroutineScope: CoroutineScope,
            installation: FerretdInstallation,
        ): FerretdDaemonConnection = FerretdDaemonConnection(
            coroutineScope,
            FerretdDaemonLauncher(coroutineScope, installation),
        )
    }
}
