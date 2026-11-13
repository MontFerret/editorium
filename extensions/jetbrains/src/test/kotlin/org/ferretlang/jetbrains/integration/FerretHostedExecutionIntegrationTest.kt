package org.ferretlang.jetbrains.integration

import com.google.gson.JsonParser
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.debugger.FerretDapCommand
import org.ferretlang.jetbrains.debugger.FerretDapStop
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.junit.Assert.*
import org.junit.Test
import org.junit.experimental.categories.Category
import java.nio.file.Files
import java.nio.file.Path

@Category(FerretdIntegrationTest::class)
internal class FerretHostedExecutionIntegrationTest : RealExecutionTestCase() {
    @Test
    fun readsApplicationFilesThroughRunAndDebugWithLocalSources() = runBlocking {
        val application = Files.createDirectory(root.resolve("application"))
        val explicit = Files.createDirectory(root.resolve("override"))
        for ((dir, marker) in listOf(root to "workspace", application to "application", explicit to "override")) {
            Files.writeString(dir.resolve("value.txt"), marker)
        }
        val source = write("queries/files.fql", "LET marker = TO_STRING(IO::FS::READ(\"value.txt\"))\nRETURN marker")
        WireHost.start(application).use { host ->
            connection.applyConfigPath(host.configure(root.resolve("runtime.json")).toString())
            for ((dir, marker) in listOf(null to "application", explicit to "override")) {
                val ordinal = host.count("connected") + 1
                val run = execute(source, workingDirectory = dir)
                assertEquals(0, run.exit.awaitResult().also { if (it != 0) error(run.debug()) })
                assertEquals(marker, JsonParser.parseString(run.stdout.single()).asString)
                assertTrue(run.debug.contains("Workspace root: ${root.toRealPath()}"))
                assertTrue(Files.notExists((dir ?: application).resolve("queries/files.fql")))
                host.released(host.connection(ordinal))
                withDebug(source, directory = dir) { debug, stop ->
                    val frame = requireNotNull(debug.session.stackTrace(stop, 0, 1)).stackFrames.single()
                    assertEquals(source.toRealPath(), Path.of(frame.source.path).toRealPath())
                    assertEquals(2, frame.line)
                    debug.session.command(FerretDapCommand.CONTINUE, stop)
                    assertEquals(0, debug.session.completion.await())
                    val (out, stderr) = debug.listener.output.receive()
                    assertFalse(stderr)
                    assertEquals(marker, JsonParser.parseString(out).asString)
                }
                host.released(host.connection(ordinal + 1))
            }
            freshQuery(host)
        }
    }

    @Test
    fun stoppedRunReleasesItsCallWhileSuspendedSiblingCanEvaluateAndFinish() = runBlocking {
        WireHost.start(root).use { host ->
            connection.applyConfigPath(host.configure(root.resolve("runtime.json")).toString())
            val run = blockedRun(host)
            val runID = host.connection(1)
            withDebug(debugSource()) { debug, stop ->
                val debugID = host.connection(2)
                assertTrue(run.handle.cancel())
                assertEquals(130, run.exit.awaitResult())
                host.await("cancelled", token = "owned-run")
                host.released(runID)
                assertEquals(1, host.count("released"))
                val frame = requireNotNull(debug.session.stackTrace(stop, 0, 1)).stackFrames.single()
                assertEquals("42", requireNotNull(debug.session.evaluate(stop, frame.id, "answer + 1")).result)
                debug.session.command(FerretDapCommand.CONTINUE, stop)
                assertEquals(0, debug.session.completion.await())
                assertEquals("41" to false, debug.listener.output.receive().let { it.first.trim() to it.second })
                host.released(debugID)
            }
            freshQuery(host)
        }
    }

    @Test
    fun stoppingSuspendedDebugPreservesApplication() = runBlocking {
        WireHost.start(root).use { host ->
            connection.applyConfigPath(host.configure(root.resolve("runtime.json"), default = "local").toString())
            withDebug(debugSource()) { debug, _ ->
                debug.session.stop()
                assertEquals(130, debug.session.completion.await())
            }
            host.released(host.connection(1))
            freshQuery(host)
        }
    }

    @Test
    fun lostApplicationFailsRunningQueriesUntilDeliberateRelaunch() = runBlocking {
        val file = root.resolve("runtime.json")
        WireHost.start(root).use { host ->
            connection.applyConfigPath(host.configure(file).toString())
            val run = blockedRun(host)
            val source = write("running-debug.fql", "LET answer = DEMO::IDENTITY(41)\nRETURN DEMO::BLOCK(\"owned-debug\")")
            withDebug(source) { debug, stop ->
                debug.session.command(FerretDapCommand.CONTINUE, stop)
                host.await("entered", token = "owned-debug")
                host.kill()
                assertEquals(1, run.exit.awaitResult())
                assertEquals(listOf("terminated:1"), run.events.toList())
                assertTrue(run.stderr.isNotEmpty())
                assertDebugHostLoss(debug)
            }
            withTimeout(5000) { connection.catalogState.first { !it.busy } }
        }
        WireHost.start(root).use { restored ->
            restored.configure(file)
            connection.reloadRuntimes().join()
            assertEquals(0, restored.count("connected"))
            freshQuery(restored)
            assertEquals(1, restored.count("connected"))
            assertEquals(0, restored.count("entered"))
        }
    }

    @Test
    fun lostApplicationEndsSuspendedDebugWithoutAnotherCommand() = runBlocking {
        WireHost.start(root).use { host ->
            connection.applyConfigPath(host.configure(root.resolve("runtime.json")).toString())
            withDebug(debugSource()) { debug, _ ->
                host.kill()
                assertDebugHostLoss(debug)
            }
        }
    }

    private suspend fun assertDebugHostLoss(debug: RealDapLaunch) {
        val code = kotlinx.coroutines.withTimeoutOrNull(20_000) { debug.session.completion.await() }
        assertEquals("Acquired Wire host was killed; DAP did not report a failing exit (adapter alive=${debug.process.isAlive})", 1, code)
        assertEquals(1, debug.listener.terminated.awaitResult())
        val output = generateSequence { debug.listener.output.tryReceive().getOrNull() }.toList()
        assertTrue("Unexpected successful Debug output: $output", output.all { it.second })
    }

    private fun blockedRun(host: WireHost): RecordingExecution {
        val run = execute(write("blocked.fql", "RETURN DEMO::BLOCK(\"owned-run\")"), workingDirectory = null)
        host.await("entered", token = "owned-run")
        return run
    }

    private fun debugSource(): Path = write("debug.fql", "LET answer = DEMO::IDENTITY(41)\nRETURN answer")

    private suspend fun withDebug(
        source: Path,
        directory: Path? = null,
        action: suspend (RealDapLaunch, FerretDapStop) -> Unit,
    ) {
        connection.admitDebug("App").use { admitted ->
            val input = FerretLaunchInput(source.toString(), directory?.toString().orEmpty(), root.toString(), FerretParameterBindings.EMPTY, "App")
            val debug = RealDapLaunch(input, scope, 2, prepareRuntime = admitted::prepareDebugRuntime)
            try {
                withTimeout(25_000) {
                    val stop = debug.stopped()
                    assertEquals("breakpoint", stop.reason)
                    action(debug, stop)
                }
            } finally {
                debug.session.stop()
                withTimeout(10_000) { debug.session.completion.await() }
            }
            assertFalse(debug.process.isAlive)
        }
    }

    private suspend fun freshQuery(host: WireHost) {
        withTimeout(5000) { connection.catalogState.first { !it.busy } }
        val ordinal = host.count("connected") + 1
        val run = execute(write("fresh.fql", "RETURN DEMO::IDENTITY(73)"), workingDirectory = null, runtimeName = "App")
        assertEquals(0, run.exit.awaitResult().also { if (it != 0) error(run.debug()) })
        assertEquals("73", run.stdout.single().trim())
        host.released(host.connection(ordinal))
    }
}
