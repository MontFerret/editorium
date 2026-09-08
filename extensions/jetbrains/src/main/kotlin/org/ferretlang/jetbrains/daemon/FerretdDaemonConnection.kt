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
        val generation = Generation(number, launcher.start())
        coroutineScope.launch {
            val cause = generation.lost.await()
            invalidate(generation, cause)
        }
        return generation
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
