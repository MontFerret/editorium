package org.ferretlang.jetbrains.daemon

import com.intellij.execution.ExecutionException
import com.intellij.openapi.components.service
import com.intellij.openapi.components.Service
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.ferretlang.jetbrains.runtime.CatalogStatus
import org.ferretlang.jetbrains.runtime.FerretCatalogState
import org.ferretlang.jetbrains.runtime.FerretRuntimeConfigFile
import org.ferretlang.jetbrains.runtime.FerretRuntimeSettings
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
import kotlin.coroutines.CoroutineContext
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

@Service(Service.Level.PROJECT)
internal class FerretdDaemonConnection private constructor(
    private val coroutineScope: CoroutineScope,
    private val launcher: FerretdDaemonLauncher,
    private val settings: FerretRuntimeSettings = FerretRuntimeSettings(),
    private val projectBase: () -> String? = { null },
) {
    constructor(
        project: Project,
        coroutineScope: CoroutineScope,
    ) : this(
        coroutineScope,
        FerretdDaemonLauncher(coroutineScope),
        project.service<FerretRuntimeSettings>(),
        { project.basePath },
    )

    // Shared by synchronous IDE admission/Apply and background publication. Never do I/O under this lock.
    private val lock = settings
    private val replacement = Mutex()
    private var saved = Configuration("")
    private var adopted = saved
    private var launches = 0
    private var pendingReload = false
    private var catalogJob: Job? = null
    private var catalogGeneration: Generation? = null
    private val state = MutableStateFlow(FerretCatalogState())
    val catalogState = state.asStateFlow()
    val configPath: String get() = synchronized(lock) { saved.path }

    private val sequence = AtomicLong()
    private var active: Generation? = null
    private val generations = mutableSetOf<Generation>()
    private var starting: Deferred<Generation>? = null
    private var closed = false
    init {
        synchronized(lock) {
            updateSavedPath(settings.state.runtimeConfigPath.orEmpty())
            settings.pathRestored = ::updateSavedPath
        }
    }

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

    internal val isProjectActive: Boolean
        get() = coroutineScope.isActive

    fun applyConfigPath(path: String) = synchronized(lock) {
        checkOpen()
        settings.state.runtimeConfigPath = path
        updateSavedPath(path)
    }

    private fun updateSavedPath(path: String) {
        if (path == saved.path) return
        pendingReload = pendingReload || active != null || starting != null || catalogJob != null || launches > 0
        saved = Configuration(path)
        if (!pendingReload) adopted = saved
        discardCatalog()
        publish(if (pendingReload) CatalogStatus.RELOAD_REQUIRED else CatalogStatus.UNLOADED)
    }

    fun admitLocalLaunch(runtimeName: String): LocalLaunch = synchronized(lock) {
        checkOpen()
        if (pendingReload || adopted !== saved) {
            val action = when (state.value.status) {
                CatalogStatus.RELOADING -> "Wait for runtime discovery to finish."
                CatalogStatus.DISCOVERY_FAILED -> "Retry discovery for the saved runtime configuration."
                else -> "Reload runtimes for the saved runtime configuration."
            }
            throw ExecutionException("$action $LOCAL_LIMITATION")
        }
        if (saved.path.isNotEmpty() || runtimeName.isNotEmpty()) throw ExecutionException(LOCAL_LIMITATION)
        launches++
        state.value = state.value.copy(busy = true)
        LocalLaunch(this, adopted)
    }

    private fun releaseLaunch() = synchronized(lock) {
        launches--
        state.value = state.value.copy(busy = launches > 0)
    }

    internal class Configuration(val path: String)

    internal class LocalLaunch internal constructor(
        private val owner: FerretdDaemonConnection,
        private val config: Configuration,
    ) : AutoCloseable {
        private val closed = AtomicBoolean()
        suspend fun generation(): Generation = owner.generation(config)
        override fun close() {
            if (closed.compareAndSet(false, true)) owner.releaseLaunch()
        }
    }

    fun observeCatalog(context: CoroutineContext, observer: (FerretCatalogState) -> Unit): Job =
        coroutineScope.launch(context) { catalogState.collect(observer) }

    fun ensureCatalog(): Job? = synchronized(lock) {
        checkOpen()
        catalogJob?.let { return it }
        if (state.value.status == CatalogStatus.READY && !isLive(catalogGeneration)) {
            catalogGeneration = null
            publish(CatalogStatus.UNLOADED)
        }
        if (state.value.status == CatalogStatus.UNLOADED) discover() else null
    }

    fun retryDiscovery(): Job? = synchronized(lock) {
        checkOpen()
        catalogJob?.let { return it }
        if (state.value.status != CatalogStatus.DISCOVERY_FAILED) return null
        if (pendingReload && !isLive(catalogGeneration)) {
            publish(CatalogStatus.RELOAD_REQUIRED)
            return null
        }
        discover(retryGeneration = catalogGeneration?.takeIf(::isLive))
    }

    fun reloadRuntimes(): Job = synchronized(lock) {
        checkOpen()
        if (launches > 0) throw ExecutionException("Finish or stop Ferret sessions, then reload runtimes.")
        if (state.value.status == CatalogStatus.RELOADING) return checkNotNull(catalogJob)
        discardCatalog()
        pendingReload = true
        // A same-path reload is a new snapshot too.
        saved = Configuration(saved.path)
        discover(replace = true)
    }

    private fun discardCatalog() {
        catalogJob?.cancel()
        catalogJob = null
        catalogGeneration = null
    }

    private fun publish(status: CatalogStatus, error: String? = null) {
        state.value = FerretCatalogState(status = status, error = error, busy = launches > 0)
    }

    private fun isLive(generation: Generation?): Boolean =
        generation != null && active === generation && generation.process.isAlive && !generation.lost.isCompleted

    // The project owns the job. Editors subscribe to its state and can leave independently.
    private fun discover(replace: Boolean = false, retryGeneration: Generation? = null): Job {
        val config = saved
        publish(if (pendingReload) CatalogStatus.RELOADING else CatalogStatus.LOADING)
        val job = coroutineScope.launch(Dispatchers.Default, start = CoroutineStart.LAZY) {
            val request = coroutineContext[Job]
            var source = retryGeneration
            try {
                if (replace) retireGeneration(config)
                val generation = source ?: generation(config)
                source = generation
                val catalog = generation.rpc.listRuntimes()
                synchronized(lock) {
                    if (!ownsDiscovery(config, request)) return@launch
                    if (!isLive(generation)) throw FerretdConnectionException("The Ferret daemon exited during runtime discovery.")
                    catalogJob = null
                    catalogGeneration = generation
                    pendingReload = false
                    state.value = FerretCatalogState(CatalogStatus.READY, catalog, busy = launches > 0)
                }
            } catch (error: Exception) {
                synchronized(lock) {
                    if (!ownsDiscovery(config, request)) return@launch
                    catalogJob = null
                    catalogGeneration = source?.takeIf(::isLive)
                    val status = if (pendingReload && catalogGeneration == null) CatalogStatus.RELOAD_REQUIRED
                        else CatalogStatus.DISCOVERY_FAILED
                    publish(status, error.message ?: "Runtime discovery failed.")
                }
            } finally {
                synchronized(lock) {
                    if (catalogJob === request) catalogJob = null
                }
            }
        }
        catalogJob = job
        job.start()
        return job
    }

    private fun ownsDiscovery(config: Configuration, request: Job?): Boolean =
        !closed && coroutineScope.isActive && saved === config && catalogJob === request

    private suspend fun retireGeneration(config: Configuration) = replacement.withLock {
        val (old, startup) = synchronized(lock) {
            checkOpen()
            check(saved === config)
            adopted = config
            val prior = active to starting
            active = null
            starting = null
            prior
        }
        withContext(NonCancellable) {
            startup?.cancelAndJoin()
            old?.let { stopGeneration(it) }
        }
    }

    internal suspend fun generation(): Generation = generation(synchronized(lock) {
        check(!pendingReload) { "Reload runtimes before using the Ferret daemon." }
        adopted
    })

    private suspend fun generation(config: Configuration): Generation {
        val pending = synchronized(lock) {
            checkOpen()
            check(adopted === config) { "The Ferret runtime configuration has changed." }
            active?.let { generation ->
                if (!generation.process.isAlive) {
                    generation.lost.complete(FerretdConnectionException("The Ferret daemon exited unexpectedly."))
                }
                if (isLive(generation)) return generation
            }
            starting ?: coroutineScope.async(Dispatchers.Default, start = CoroutineStart.LAZY) {
                val file = withContext(Dispatchers.IO) { FerretRuntimeConfigFile.resolve(config.path, projectBase()) }
                startGeneration(sequence.incrementAndGet(), config, file)
            }.also { startup ->
                starting = startup
                startup.invokeOnCompletion { synchronized(lock) { if (starting === startup) starting = null } }
            }
        }
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
        val (owned, pending) = synchronized(lock) {
            closed = true
            settings.pathRestored = null
            discardCatalog()
            publish(CatalogStatus.UNLOADED)
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
        // A replacement may already have detached a startup that still owns a process.
        replacement.withLock { }
        owned.forEach { stopGeneration(it) }
        if (started != null && started !in owned) {
            stopGeneration(started)
        }
    }

    internal suspend fun closeForTest() {
        lifetime.cancelAndJoin()
    }

    private suspend fun startGeneration(number: Long, config: Configuration, file: Path?): Generation {
        val generation = Generation(number, launcher.start(file))
        try {
            if (generation.lost.isCompleted) throw generation.lost.await()
            synchronized(lock) {
                checkOpen()
                check(adopted === config) { "The Ferret runtime configuration changed during startup." }
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
        synchronized(lock) {
            if (active === generation) active = null
            if (catalogGeneration === generation) {
                catalogGeneration = null
                publish(if (pendingReload) CatalogStatus.RELOAD_REQUIRED else CatalogStatus.UNLOADED, cause.message)
            }
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
            synchronized(lock) { generations.remove(generation) }
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
        if (synchronized(lock) { active !== generation }) {
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
        const val LOCAL_LIMITATION = "To run or debug, clear the Runtime configuration file field and select Daemon default."
        private val LOG = Logger.getInstance(FerretdDaemonConnection::class.java)
        private const val SHUTDOWN_TIMEOUT_SECONDS = 5L

        internal fun testing(
            coroutineScope: CoroutineScope,
            launcher: FerretdDaemonLauncher,
            settings: FerretRuntimeSettings = FerretRuntimeSettings(),
        ): FerretdDaemonConnection = FerretdDaemonConnection(coroutineScope, launcher, settings)

        internal fun testing(
            coroutineScope: CoroutineScope,
            installation: FerretdInstallation,
        ): FerretdDaemonConnection = FerretdDaemonConnection(
            coroutineScope,
            FerretdDaemonLauncher(coroutineScope, installation),
        )
    }
}
