package org.ferretlang.jetbrains.debugger

import com.intellij.execution.ExecutionException
import com.intellij.openapi.components.service
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.testFramework.replaceService
import com.intellij.xdebugger.XDebugSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.junit.Assert
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger

class FerretDebugStartupTest : BasePlatformTestCase() {
    private val runner = FerretDebugRunner()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val adapter = DapTestAdapter()
    private val starts = AtomicInteger()
    private lateinit var input: FerretLaunchInput
    private var adapterProcess: DapTestProcess? = null
    private var debugProcess: FerretDebugProcess? = null
    private val connection get() = project.service<FerretdDaemonConnection>()

    override fun setUp() {
        super.setUp()
        val source = Files.createTempFile("ferret-debug-startup-", ".fql")
        Files.writeString(source, "RETURN 1")
        input = FerretLaunchInput(source.toString(), "", source.parent.toString(), FerretParameterBindings.EMPTY)
        project.replaceService(FerretDebugLauncher::class.java, FerretDebugLauncher.testing(scope) { launch, listener ->
            FerretDapSession(launch, listener, { source }, {
                starts.incrementAndGet()
                DapTestProcess(adapter).also { adapterProcess = it }
            })
        }, testRootDisposable)
    }

    override fun tearDown() {
        try {
            adapter.terminateResponse.complete(null)
            scope.cancel()
            PlatformTestUtil.waitWithEventsDispatching("Debug reservation still busy", { !connection.catalogState.value.busy }, 10)
            adapterProcess?.close()
            debugProcess?.let { Disposer.dispose(it.createConsole()) }
            Files.deleteIfExists(Path.of(input.sourcePath))
        } finally {
            super.tearDown()
        }
    }

    fun testFailureBeforeHandoffReleasesRunnerReservation() {
        val failure = ExecutionException("Cannot construct the debug session")
        val thrown = Assert.assertThrows(ExecutionException::class.java) {
            runner.startSession(project, input) {
                assertTrue(connection.catalogState.value.busy)
                throw failure
            }
        }
        assertSame(failure, thrown)
        assertFalse(connection.catalogState.value.busy)
        assertEquals(0, starts.get())
    }

    fun testFailureAfterConstructionPreventsLateInitialization() {
        val failure = ExecutionException("Cannot initialize the debug session")
        val thrown = Assert.assertThrows(ExecutionException::class.java) {
            runner.startSession(project, input) { starter ->
                debugProcess = starter.start(session()) as FerretDebugProcess
                throw failure
            }
        }
        assertSame(failure, thrown)
        assertFalse(connection.catalogState.value.busy)
        val process = requireNotNull(debugProcess)
        process.processHandler.startNotify()
        assertEquals(130, process.processHandler.exitCode)
        process.sessionInitialized()
        assertTrue(process.processHandler.isProcessTerminated)
        assertEquals(0, starts.get())
    }

    fun testFailureAfterDapStartupHoldsReservationUntilCleanup() {
        adapter.autoTerminate = false
        val failure = ExecutionException("Cannot finish debug tab setup")
        val thrown = Assert.assertThrows(ExecutionException::class.java) {
            runner.startSession(project, input) { starter ->
                val process = starter.start(session()) as FerretDebugProcess
                debugProcess = process
                process.processHandler.startNotify()
                process.sessionInitialized()
                PlatformTestUtil.waitWithEventsDispatching("DAP launch did not start", { adapter.launched.isDone }, 10)
                throw failure
            }
        }
        assertSame(failure, thrown)
        PlatformTestUtil.waitWithEventsDispatching("DAP cleanup did not start", { adapter.history.contains("terminate") }, 10)
        assertThrows(ExecutionException::class.java) { connection.reloadRuntimes() }
        assertTrue(connection.catalogState.value.busy)
        adapter.terminateResponse.complete(null)
        PlatformTestUtil.waitWithEventsDispatching("DAP cleanup did not finish", { !connection.catalogState.value.busy }, 10)
        assertEquals(1, starts.get())
        assertFalse(requireNotNull(adapterProcess).isAlive)
        assertTrue(adapter.disconnected.isDone)
    }

    private fun session(): XDebugSession =
        Proxy.newProxyInstance(XDebugSession::class.java.classLoader, arrayOf(XDebugSession::class.java)) { _, method, _ ->
            when (method.name) {
                "getProject" -> project
                "initBreakpoints" -> null
                else -> error("Unexpected XDebugger callback: ${method.name}")
            }
        } as XDebugSession
}
