package org.ferretlang.jetbrains.integration

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.daemon.FerretdInstallation
import org.ferretlang.jetbrains.execution.FerretExecutionClient
import org.ferretlang.jetbrains.execution.FerretExecutionInput
import org.ferretlang.jetbrains.execution.FerretExecutionSink
import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.ferretlang.jetbrains.run.FerretParameterValue
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import java.nio.file.Files
import java.nio.file.Path
import java.util.Collections
import java.util.concurrent.TimeUnit

@Category(FerretdIntegrationTest::class)
class FerretExecutionIntegrationTest {
    private lateinit var scope: CoroutineScope
    private lateinit var connection: FerretdDaemonConnection
    private lateinit var root: Path

    @Before
    fun setUp() {
        val executable = Path.of(requireNotNull(System.getenv("FERRETD_TEST_PATH")))
        val version = executableVersion(executable)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        connection = FerretdDaemonConnection.testing(scope, FerretdInstallation(executable, version))
        root = Files.createTempDirectory("ferret-jetbrains-integration-")
    }

    @After
    fun tearDown() {
        runBlocking { connection.closeForTest() }
        scope.cancel()
        root.toFile().deleteRecursively()
    }

    @Test
    fun executesParametersFailuresSavedEditsAndNewFiles() = runBlocking {
        val source = write("main.fql", "RETURN { value: @value, nested: @nested }")
        val parameters = FerretParameterBindings.of(
            mapOf(
                "value" to FerretParameterValue.NumberValue(42.0),
                "nested" to FerretParameterValue.ObjectValue(
                    mapOf("enabled" to FerretParameterValue.BooleanValue(true)),
                ),
            ),
        )
        val first = execute(source, parameters)
        assertEquals(0, first.exit.awaitResult().also { if (it != 0) error(first.debug()) })
        assertTrue(first.stdout.joinToString("\n").contains("\"value\": 42"))
        assertTrue(first.stdout.joinToString("\n").contains("\"enabled\": true"))

        Files.writeString(source, "RETURN \"saved edit\"")
        val edited = execute(source)
        assertEquals(0, edited.exit.awaitResult().also { if (it != 0) error(edited.debug()) })
        assertTrue(edited.stdout.joinToString("\n").contains("saved edit"))

        val newFile = write("new file ü.fql", "RETURN \"new file\"")
        val created = execute(newFile)
        assertEquals(0, created.exit.awaitResult().also { if (it != 0) error(created.debug()) })
        assertTrue(created.stdout.joinToString("\n").contains("new file"))

        val compileFailure = execute(write("invalid.fql", "RETURN missing"))
        assertEquals(1, compileFailure.exit.awaitResult().also { if (it != 1) error(compileFailure.debug()) })
        assertTrue(compileFailure.stderr.any { it.contains("compilation", ignoreCase = true) })
        assertTrue(compileFailure.stderr.any { it.contains("invalid.fql") })

        val runtimeFailure = execute(write("runtime.fql", "RETURN @required"))
        assertEquals(1, runtimeFailure.exit.awaitResult().also { if (it != 1) error(runtimeFailure.debug()) })
        assertTrue(runtimeFailure.stderr.any { it.contains("missing parameter", ignoreCase = true) })
    }

    @Test
    fun cancelsAndIsolatesConcurrentRuns() = runBlocking {
        val first = execute(write("first.fql", "WAIT(10s)\nRETURN 1"))
        val second = execute(write("second.fql", "WAIT(10s)\nRETURN 2"))
        first.awaitStarted()
        second.awaitStarted()
        assertTrue(first.handle.cancel())
        assertEquals(130, first.exit.awaitResult().also { if (it != 130) error(first.debug()) })
        assertTrue(!second.exit.isCompleted)
        assertTrue(second.handle.cancel())
        assertEquals(130, second.exit.awaitResult().also { if (it != 130) error(second.debug()) })
    }

    @Test
    fun daemonCrashFailsCurrentRunAndRestartsOnlyOnLaterRun() = runBlocking {
        val running = execute(write("long.fql", "WAIT(10s)\nRETURN 1"))
        running.awaitStarted()
        val oldGeneration = connection.generation()
        oldGeneration.process.destroyForcibly()
        assertEquals(1, running.exit.awaitResult().also { if (it != 1) error(running.debug()) })

        val recovered = execute(write("recovered.fql", "RETURN \"recovered\""))
        assertEquals(0, recovered.exit.awaitResult().also { if (it != 0) error(recovered.debug()) })
        val newGeneration = connection.generation()
        assertNotEquals(oldGeneration.number, newGeneration.number)
    }

    private fun execute(
        source: Path,
        parameters: FerretParameterBindings = FerretParameterBindings.EMPTY,
    ): RecordingExecution {
        val sink = RecordingExecution()
        sink.handle = FerretExecutionClient(connection).start(
            FerretExecutionInput(source.toString(), root.toString(), null, parameters),
            sink,
        )
        return sink
    }

    private fun write(relativePath: String, source: String): Path {
        val path = root.resolve(relativePath)
        Files.createDirectories(path.parent)
        return Files.writeString(path, source)
    }

    private fun executableVersion(executable: Path): String {
        val process = ProcessBuilder(executable.toString(), "--version").redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText().trim()
        check(process.waitFor(5, TimeUnit.SECONDS) && process.exitValue() == 0) {
            "Cannot read ferretd version from $executable: $output"
        }
        return output.removePrefix("ferretd ").trim().also { check(it.isNotBlank()) }
    }

    private class RecordingExecution : FerretExecutionSink {
        val system = Collections.synchronizedList(mutableListOf<String>())
        val stdout = Collections.synchronizedList(mutableListOf<String>())
        val stderr = Collections.synchronizedList(mutableListOf<String>())
        val internal = Collections.synchronizedList(mutableListOf<String>())
        val exit = CompletableDeferred<Int>()
        lateinit var handle: org.ferretlang.jetbrains.execution.FerretExecutionHandle

        override fun system(message: String) {
            system += message
        }

        override fun stdout(message: String) {
            stdout += message
        }

        override fun stderr(message: String) {
            stderr += message
        }

        override fun internal(message: String, cause: Throwable?) {
            internal += "$message: ${cause?.javaClass?.name}: ${cause?.message}"
        }

        override fun terminate(exitCode: Int) {
            internal += "terminated=$exitCode"
            exit.complete(exitCode)
        }

        suspend fun awaitStarted() {
            withTimeout(15_000L) {
                while (system.none { it == "Ferret execution started." }) {
                    if (exit.isCompleted) {
                        error("Execution terminated before starting: ${debug()}")
                    }
                    delay(10L)
                }
            }
        }

        fun debug(): String = "system=$system stdout=$stdout stderr=$stderr internal=$internal"
    }

    private suspend fun <T> CompletableDeferred<T>.awaitResult(): T = withTimeout(20_000L) { this@awaitResult.await() }
}
