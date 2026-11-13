package org.ferretlang.jetbrains.daemon

import com.intellij.execution.ExecutionException
import kotlinx.coroutines.*
import org.ferretlang.jetbrains.execution.FakeFerretdRpc
import org.ferretlang.jetbrains.runtime.CatalogStatus
import org.ferretlang.jetbrains.runtime.FerretRuntimeCatalog
import org.ferretlang.jetbrains.runtime.FerretRuntimeSettings
import org.ferretlang.jetbrains.runtime.FerretRuntimeDescriptor
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files
import org.ferretlang.jetbrains.debugger.DapTestLaunch
import java.nio.file.Path
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.CountDownLatch

class FerretdRuntimeDiscoveryTest {
    @get:Rule val folder = TemporaryFolder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val paths = CopyOnWriteArrayList<Path?>()
    private val version = "1.0.0-alpha.11"
    private lateinit var rpc: FakeFerretdRpc
    private lateinit var process: FakeDaemonProcess
    private var exitObservationGate: CountDownLatch? = null
    private var configure: (FakeFerretdRpc) -> Unit = {}
    private val settings = FerretRuntimeSettings()
    private val connection = FerretdDaemonConnection.testing(scope, FerretdDaemonLauncher.testing(
        scope, { FerretdInstallation(Path.of("ferretd"), version) },
        { _, _, path ->
            paths.add(path)
            FakeDaemonProcess.ready(version, exitObservationGate = exitObservationGate).also {
                process = it
                rpc = FakeFerretdRpc(version, folder.root.toPath(), emptyList(), it::destroy).also(configure)
            }
        },
        { _, _ -> rpc },
    ), settings)
    private val state get() = connection.catalogState.value

    @After
    fun close() = runBlocking {
        connection.closeForTest()
        scope.cancel()
    }

    @Test
    fun firstUseAdoptsLatestPathAndJoinsStartupAndDiscovery() = runBlocking {
        val first = folder.newFile().toPath()
        val second = folder.newFile().toPath()
        connection.applyConfigPath(first.toString())
        connection.applyConfigPath(second.toString())
        assertTrue(paths.isEmpty())
        val entered = CompletableDeferred<Unit>()
        val proceed = CompletableDeferred<Unit>()
        configure = { it.discover = { entered.complete(Unit); proceed.await(); catalog("App") } }
        val job = connection.ensureCatalog()!!
        withTimeout(5000) { entered.await() }
        assertSame(job, connection.ensureCatalog())
        connection.applyConfigPath(second.toString())
        proceed.complete(Unit)
        job.join()
        assertEquals("App", state.catalog?.defaultRuntime)
        assertNull(connection.ensureCatalog())
        assertEquals(listOf(second), paths)
        assertEquals(1, rpc.calls.count { it == "listRuntimes" })
    }

    @Test
    fun admissionCapturesConfigurationBeforeStartupAndProtectsItUntilRelease(): Unit = runBlocking {
        val launch = connection.admitDebug("")
        val config = folder.newFile().toPath()
        connection.applyConfigPath(config.toString())
        assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
        assertNull(connection.ensureCatalog())
        assertThrows(ExecutionException::class.java) { connection.admitDebug("") }
        assertThrows(ExecutionException::class.java) { connection.reloadRuntimes() }
        val original = launch.generation()
        assertNull(paths.single())
        launch.close()
        assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
        assertTrue(original.process.isAlive)
        connection.reloadRuntimes().join()
        assertFalse(original.process.isAlive)
        assertEquals(config, paths.last())
        connection.admitDebug("").close()
    }

    @Test
    fun failedReplacementDiscoveryRetriesOnTheSameDaemonAndUnblocksLaunchOnlyOnSuccess() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val proceed = CompletableDeferred<Unit>()
        configure = { it.discover = { entered.complete(Unit); proceed.await(); error("Catalog unavailable") } }
        val reload = connection.reloadRuntimes()
        withTimeout(5000) { entered.await() }
        assertSame(reload, connection.ensureCatalog())
        val loading = assertThrows(ExecutionException::class.java) { connection.admitRun("App") }
        assertTrue(loading.message.orEmpty().contains("Wait"))
        proceed.complete(Unit)
        reload.join()
        assertEquals(CatalogStatus.DISCOVERY_FAILED, state.status)
        assertEquals("Catalog unavailable", state.error)
        assertNull(connection.ensureCatalog())
        val failed = assertThrows(ExecutionException::class.java) { connection.admitRun("App") }
        assertTrue(failed.message.orEmpty().contains("Retry"))
        rpc.discover = { catalog("local") }
        connection.retryDiscovery()!!.join()
        assertEquals("local", state.catalog?.defaultRuntime)
        connection.admitDebug("").close()
        assertEquals(1, paths.size)
        assertEquals(2, rpc.calls.count { it == "listRuntimes" })
    }

    @Test
    fun failedFirstStartupKeepsItsAdoptedConfiguration() = runBlocking {
        val missing = folder.root.toPath().resolve("missing.json").toString()
        connection.applyConfigPath(missing)
        connection.ensureCatalog()!!.join()
        assertEquals(CatalogStatus.DISCOVERY_FAILED, state.status)
        connection.applyConfigPath("")
        assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
        assertThrows(ExecutionException::class.java) { connection.admitDebug("") }
        assertTrue(paths.isEmpty())
        connection.reloadRuntimes().join()
        connection.admitDebug("").close()
    }

    @Test
    fun replacementExitingDuringRetryAdmissionRequiresReload(): Unit = runBlocking {
        val observeExit = CountDownLatch(1)
        exitObservationGate = observeExit
        try {
            configure = { it.discover = { error("RPC unavailable") } }
            connection.reloadRuntimes().join()
            assertEquals(CatalogStatus.DISCOVERY_FAILED, state.status)
            // The OS can report exit between Retry choosing a generation and sending the request.
            // Keep the process observer from publishing the loss until Retry handles it.
            process.exitAfterNextLivenessCheck.set(true)
            configure = {}
            rpc.discover = { catalog("obsolete") }
            connection.retryDiscovery()!!.join()
            assertEquals(1, paths.size)
            assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
            assertNull(state.catalog)
            assertThrows(ExecutionException::class.java) { connection.admitDebug("") }
        } finally {
            observeExit.countDown()
        }
    }

    @Test
    fun ignoresLateMetadataAfterApplyReloadOrDisposal() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val proceed = CompletableDeferred<Unit>()
        configure = { it.discover = {
            entered.complete(Unit)
            withContext(NonCancellable) { proceed.await() }
            catalog("obsolete")
        } }
        val old = connection.ensureCatalog()!!
        withTimeout(5000) { entered.await() }
        connection.applyConfigPath(folder.newFile().path)
        assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
        configure = { it.discover = { catalog("current") } }
        connection.reloadRuntimes().join()
        proceed.complete(Unit)
        old.join()
        assertEquals("current", state.catalog?.defaultRuntime)

        val finalEntered = CompletableDeferred<Unit>()
        val finalReply = CompletableDeferred<Unit>()
        configure = { it.discover = {
            finalEntered.complete(Unit)
            withContext(NonCancellable) { finalReply.await() }
            catalog("disposed")
        } }
        val final = connection.reloadRuntimes()
        withTimeout(5000) { finalEntered.await() }
        connection.shutdown()
        finalReply.complete(Unit)
        final.join()
        assertNull(state.catalog)
    }

    @Test
    fun ordinaryDiscoverySharesAStartingRunButSupersededStartupCannotPublishACatalog() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val entered = CompletableDeferred<Unit>()
        configure = { it.getInfoGate = gate; entered.complete(Unit) }
        val launch = connection.admitDebug("")
        val generation = async { launch.generation() }
        withTimeout(5000) { entered.await() }
        val discovery = connection.ensureCatalog()!!
        connection.applyConfigPath(folder.newFile().path)
        gate.complete(Unit)
        assertTrue(generation.await().process.isAlive)
        discovery.join()
        assertEquals(1, paths.size)
        assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
        assertNull(state.catalog)
        launch.close()
    }

    @Test
    fun lostReplacementRequiresExplicitReloadAndOrdinaryFailureCanRetry() = runBlocking {
        configure = { it.discover = { error("RPC unavailable") } }
        connection.ensureCatalog()!!.join()
        assertEquals(CatalogStatus.DISCOVERY_FAILED, state.status)
        connection.admitDebug("").close()
        val generation = connection.generation()
        rpc.discover = { catalog("local") }
        connection.retryDiscovery()!!.join()
        assertSame(generation, connection.generation())
        connection.reloadRuntimes().join()
        assertEquals(CatalogStatus.DISCOVERY_FAILED, state.status)
        // Terminal loss is signalled by the connection's existing process observer.
        rpc.shutdown()
        connection.retryDiscovery()?.join()
        assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
        assertNull(connection.ensureCatalog())
        assertEquals(2, paths.size)
        configure = { it.discover = { catalog("local") } }
        connection.reloadRuntimes().join()
        assertEquals(CatalogStatus.READY, state.status)
        assertEquals(3, paths.size)
    }

    @Test
    fun restoredProjectSettingsParticipateInLaunchAdmissionAndCatalogInvalidation() = runBlocking {
        connection.ensureCatalog()!!.join()
        settings.loadState(FerretRuntimeSettings.Options().apply { runtimeConfigPath = folder.newFile().path })
        assertEquals(settings.state.runtimeConfigPath, connection.configPath)
        assertNull(state.catalog)
        assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
        assertThrows(ExecutionException::class.java) { connection.admitDebug("") }
        assertEquals(1, paths.size)
    }

    @Test
    fun detectsFileChangesAcrossGenerationStartupAndRequiresExplicitReload() = runBlocking {
        val file = folder.newFile().toPath()
        connection.applyConfigPath(file.toString())
        configure = { Files.writeString(file, "updated during startup") }
        connection.ensureCatalog()!!.join()
        assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
        assertTrue(process.waitFor(5, TimeUnit.SECONDS))
        assertNull(connection.retryDiscovery())
        assertFalse(state.error.orEmpty().contains("updated during startup"))
        configure = {}
        connection.reloadRuntimes().join()
        assertEquals(CatalogStatus.READY, state.status)
    }

    @Test
    fun restoringOldBytesOrRetryingCannotClearStaleness() = runBlocking {
        val file = folder.newFile().toPath()
        configure = { it.serverInfo = it.serverInfo.copy(apiMinor = 3) }
        connection.applyConfigPath(file.toString())
        connection.admitDebug("local").use { admitted ->
            val source = admitted.generation()
            // Start discovery against its cached catalog while Debug detects the edit.
            val runtime = admitted.prepareDebugRuntime()
            Files.delete(file)
            val discovery = connection.ensureCatalog()!!
            val stale = runCatching { runtime.verifyConfiguration() }.exceptionOrNull()
            assertTrue(stale is ExecutionException)
            discovery.join()
            assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
            assertNull(state.catalog)
            Files.writeString(file, "")
            assertTrue(runCatching { runtime.verifyConfiguration() }.isFailure)
            assertNull(connection.retryDiscovery())
            assertNull(connection.ensureCatalog())
            assertTrue(source.process.isAlive)
        }
        assertThrows(ExecutionException::class.java) { connection.admitRun("local") }
        connection.reloadRuntimes().join()
        assertEquals(CatalogStatus.READY, state.status)
    }

    @Test
    fun configuredDebugChecksTheAdmittedFileBeforeSpawnAndAgainAfterInitialize() = runBlocking {
        val file = folder.newFile().toPath()
        val other = folder.newFile().toPath()
        configure = { it.serverInfo = it.serverInfo.copy(apiMinor = 3) }
        connection.applyConfigPath(file.toString())
        for (editDuringInitialize in listOf(false, true)) {
            connection.reloadRuntimes().join()
            connection.admitDebug("").use { admitted ->
                val debug = DapTestLaunch(prepareRuntime = admitted::prepareDebugRuntime)
                try {
                    if (!editDuringInitialize) Files.writeString(file, "before adapter startup")
                    else debug.adapter.responseBody = { method, original ->
                        if (method == "initialize") {
                            connection.applyConfigPath(other.toString())
                            Files.delete(file)
                            mapOf("supportsConfigurationDoneRequest" to true, "supportsFerretRuntimeSelection" to true)
                        } else original
                    }
                    debug.start()
                    assertEquals(1, withTimeout(5000) { debug.session.completion.await() })
                    assertEquals(if (editDuringInitialize) listOf("initialize", "disconnect") else emptyList(), debug.adapter.history.toList())
                    if (editDuringInitialize) {
                        assertEquals(file.toString(), debug.command.last())
                        assertEquals(other.toString(), connection.configPath)
                        assertNull(state.error)
                    }
                    assertTrue(debug.listener.errors.receive().contains("Reload runtimes"))
                    assertEquals(CatalogStatus.RELOAD_REQUIRED, state.status)
                } finally { debug.close() }
            }
        }
    }

    @Test
    fun debugAndRunShareCatalogButCancellingOneWaiterDoesNotCancelItsSibling() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        val reply = CompletableDeferred<Unit>()
        val name = "  App  "
        configure = { fake ->
            fake.serverInfo = fake.serverInfo.copy(apiMinor = 3)
            fake.discover = { entered.complete(Unit); reply.await(); catalog(name) }
        }
        val file = folder.newFile().toPath()
        connection.applyConfigPath(file.toString())
        connection.admitDebug(name).use { debug ->
            connection.admitRun("").use { run ->
                val cancelled = async { debug.prepareDebugRuntime() }
                withTimeout(5000) { entered.await() }
                val sibling = async { run.resolveRuntime(run.generation()) }
                cancelled.cancelAndJoin()
                connection.applyConfigPath(folder.newFile().path)
                reply.complete(Unit)
                assertEquals(name, sibling.await().name)
                val prepared = debug.prepareDebugRuntime()
                assertEquals(name, prepared.descriptor.name)
                assertEquals(file, prepared.configFile)
                prepared.verifyConfiguration()
                assertEquals(1, rpc.calls.count { it == "listRuntimes" })
            }
        }
        connection.reloadRuntimes().join()
        connection.admitDebug(name.trim()).use { missing ->
            assertTrue(runCatching { missing.prepareDebugRuntime() }.exceptionOrNull()?.message.orEmpty().contains("unavailable"))
            assertEquals(name.trim(), missing.runtimeName)
        }
    }

    private fun catalog(name: String) = FerretRuntimeCatalog(name, listOf(FerretRuntimeDescriptor(name, name, "native")))
}
