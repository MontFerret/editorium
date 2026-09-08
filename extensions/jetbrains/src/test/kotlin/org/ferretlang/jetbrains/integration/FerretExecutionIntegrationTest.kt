package org.ferretlang.jetbrains.integration

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.daemon.FerretdInstallation
import org.ferretlang.jetbrains.daemon.FerretdDaemonLauncher
import org.ferretlang.jetbrains.daemon.GrpcFerretdRpc
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
import com.google.gson.JsonParser
import org.ferretlang.jetbrains.run.FerretParameterBindingsJson

@Category(FerretdIntegrationTest::class)
class FerretExecutionIntegrationTest {
    private lateinit var scope: CoroutineScope
    private lateinit var connection: FerretdDaemonConnection
    private lateinit var root: Path
    private lateinit var installation: FerretdInstallation
    private var port = 0

    @Before
    fun setUp() {
        val executable = Path.of(requireNotNull(System.getenv("FERRETD_TEST_PATH")))
        val version = executableVersion(executable)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        installation = FerretdInstallation(executable, version)
        connection = FerretdDaemonConnection.testing(scope, FerretdDaemonLauncher.testing(
            scope,
            { installation },
            { installed, credential ->
                ProcessBuilder(FerretdDaemonLauncher.command(installed)).apply {
                    environment()["FERRETD_AUTH_TOKEN"] = credential
                }.start()
            },
            { readyPort, credential ->
                port = readyPort
                GrpcFerretdRpc.connect(readyPort, credential)
            },
        ))
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
        val second = execute(write("second.fql", "WAIT(2s)\nRETURN 2"))
        first.awaitStarted()
        second.awaitStarted()
        assertTrue(first.handle.cancel())
        assertEquals(130, first.exit.awaitResult().also { if (it != 130) error(first.debug()) })
        assertEquals(0, second.exit.awaitResult().also { if (it != 0) error(second.debug()) })
        assertEquals(JsonParser.parseString("2"), JsonParser.parseString(second.stdout.single()))
        assertTrue(first.internal.none { it.contains("Cancelling") })
    }

    @Test
    fun separatesWorkspaceFromProjectAndExternalRuntimeDirectories() = runBlocking {
        val query = write("queries/query.fql", "RETURN TO_STRING(IO::FS::READ(\"value.txt\"))")
        val projectRuntime = Files.createDirectories(root.resolve("runtime"))
        Files.writeString(projectRuntime.resolve("value.txt"), "project runtime")

        val projectExecution = execute(query, workingDirectory = projectRuntime)
        assertEquals(0, projectExecution.exit.awaitResult().also { if (it != 0) error(projectExecution.debug()) })
        assertTrue(projectExecution.stdout.joinToString("\n").contains("project runtime"))
        assertTrue(projectExecution.debug.any { it == "Workspace root: ${root.toRealPath()}" })
        assertTrue(projectExecution.debug.any { it == "Working directory: ${projectRuntime.toRealPath()}" })

        val writer = write(
            "queries/write.fql",
            "RETURN IO::FS::WRITE(\"created.txt\", TO_BINARY(\"runtime write\"))",
        )
        val written = execute(writer, workingDirectory = projectRuntime)
        assertEquals(0, written.exit.awaitResult().also { if (it != 0) error(written.debug()) })
        assertEquals("runtime write", Files.readString(projectRuntime.resolve("created.txt")))
        assertTrue(Files.notExists(root.resolve("created.txt")))

        val externalRuntime = Files.createTempDirectory("ferret-jetbrains-external-runtime-")
        try {
            Files.writeString(externalRuntime.resolve("value.txt"), "external runtime")
            val externalExecution = execute(query, workingDirectory = externalRuntime)
            assertEquals(0, externalExecution.exit.awaitResult().also { if (it != 0) error(externalExecution.debug()) })
            assertTrue(externalExecution.stdout.joinToString("\n").contains("external runtime"))
        } finally {
            externalRuntime.toFile().deleteRecursively()
        }

        Files.writeString(root.resolve("value.txt"), "workspace default")
        val inherited = execute(query, workingDirectory = null)
        assertEquals(0, inherited.exit.awaitResult().also { if (it != 0) error(inherited.debug()) })
        assertTrue(inherited.stdout.joinToString("\n").contains("workspace default"))
        assertTrue(
            inherited.debug.any {
                it == "Working directory: ${root.toRealPath()} (daemon default)"
            },
        )
    }

    @Test
    fun concurrentRunsUseIndependentRuntimeDirectories() = runBlocking {
        val query = write("concurrent.fql", "RETURN TO_STRING(IO::FS::READ(\"value.txt\"))")
        val firstRoot = Files.createTempDirectory("ferret-jetbrains-runtime-first-")
        val secondRoot = Files.createTempDirectory("ferret-jetbrains-runtime-second-")
        try {
            Files.writeString(firstRoot.resolve("value.txt"), "first root")
            Files.writeString(secondRoot.resolve("value.txt"), "second root")
            val first = execute(query, workingDirectory = firstRoot)
            val second = execute(query, workingDirectory = secondRoot)

            assertEquals(0, first.exit.awaitResult().also { if (it != 0) error(first.debug()) })
            assertEquals(0, second.exit.awaitResult().also { if (it != 0) error(second.debug()) })
            assertTrue(first.stdout.joinToString("\n").contains("first root"))
            assertTrue(second.stdout.joinToString("\n").contains("second root"))
        } finally {
            firstRoot.toFile().deleteRecursively()
            secondRoot.toFile().deleteRecursively()
        }
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
        withTimeout(5_000L) { oldGeneration.stopped.await() }
        assertTrue(!oldGeneration.process.isAlive)
    }

    @Test
    fun roundTripsAllParameterTypesWithoutStringification() = runBlocking {
        val json = """{"text":"hello ü","flag":false,"number":1.25,"nothing":null,"array":[1,true,null,"x"],"nested":{"child":{"value":42}}}"""
        val bindings = FerretParameterBindingsJson.parse("{\"value\":$json}")
        val result = execute(write("parameters.fql", "RETURN @value"), bindings)
        assertEquals(0, result.exit.awaitResult().also { if (it != 0) error(result.debug()) })
        assertEquals(JsonParser.parseString(json), JsonParser.parseString(result.stdout.single()))
        assertEquals(listOf("Ferret execution completed."), result.system.toList())
        assertEquals(listOf("output", "terminated:0"), result.events.toList())
    }

    @Test
    fun renamesMovesAndReopensSourcesWithoutReusingCompiledState() = runBlocking {
        var source = write("original.fql", "RETURN \"original\"")
        assertEquals(0, execute(source).exit.awaitResult())
        val generation = connection.generation()
        source = Files.move(source, root.resolve("renamed ü.fql"))
        Files.writeString(source, "RETURN \"renamed\"")
        val renamed = execute(source)
        assertEquals(0, renamed.exit.awaitResult())
        assertEquals(JsonParser.parseString("\"renamed\""), JsonParser.parseString(renamed.stdout.single()))
        Files.createDirectories(root.resolve("nested"))
        source = Files.move(source, root.resolve("nested/moved.fql"))
        Files.writeString(source, "RETURN \"moved\"")
        val moved = execute(source)
        assertEquals(0, moved.exit.awaitResult())
        assertEquals(JsonParser.parseString("\"moved\""), JsonParser.parseString(moved.stdout.single()))
        assertEquals(generation.number, connection.generation().number)
        connection.closeForTest()
        scope.cancel()
        assertTrue(!generation.process.isAlive)
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        connection = FerretdDaemonConnection.testing(scope, installation)
        val reopened = execute(source)
        assertEquals(0, reopened.exit.awaitResult())
        assertEquals(moved.stdout.toList(), reopened.stdout.toList())
    }

    @Test
    fun reportsSyntaxRuntimeMissingParameterAndWorkspaceErrors() = runBlocking {
        val syntax = execute(write("syntax.fql", "RETURN {"))
        assertEquals(1, syntax.exit.awaitResult())
        assertTrue(syntax.stderr.any { it.contains("syntax.fql") })
        val runtime = execute(write("division.fql", "RETURN 1 / @divisor"), FerretParameterBindingsJson.parse("{\"divisor\":0}"))
        assertEquals(1, runtime.exit.awaitResult().also { if (it != 1) error(runtime.debug()) })
        assertTrue(runtime.stderr.any { it.contains("division by zero") })
        val missing = execute(write("missing.fql", "RETURN @required"))
        assertEquals(1, missing.exit.awaitResult())
        assertTrue(missing.stderr.any { it.contains("parameter") })
        val external = Files.createTempFile("outside-workspace-", ".fql")
        try {
            Files.writeString(external, "RETURN 1")
            val outside = execute(external)
            assertEquals(1, outside.exit.awaitResult())
            assertTrue(outside.stderr.any { it.contains("outside") && it.contains("workspace") })
        } finally {
            Files.deleteIfExists(external)
        }
        val invalid = execute(root.resolve("absent.fql"))
        assertEquals(1, invalid.exit.awaitResult())
        assertTrue(invalid.stderr.any { it.contains("source file") })
    }

    @Test
    fun immediateStopLeavesDaemonReusableAndTerminatesExactlyOnce() = runBlocking {
        val source = write("stop.fql", "WAIT(10s)\nRETURN 1")
        repeat(5) {
            val running = execute(source)
            running.handle.cancel()
            running.handle.cancel()
            assertEquals(130, running.exit.awaitResult())
            assertEquals(listOf("terminated:130"), running.events.toList())
        }
        val recovered = execute(write("after-stop.fql", "RETURN true"))
        assertEquals(0, recovered.exit.awaitResult())
    }

    @Test
    fun separateProjectsOwnIndependentProcessesAndClosingOneLeavesTheOtherUsable() = runBlocking {
        val secondScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val secondConnection = FerretdDaemonConnection.testing(secondScope, installation)
        val secondRoot = Files.createTempDirectory("ferret-second-project-").toRealPath()
        try {
            val first = execute(write("first-project.fql", "WAIT(10s)\nRETURN 1"))
            val otherSource = Files.writeString(secondRoot.resolve("second.fql"), "WAIT(2s)\nRETURN 2")
            val second = execute(otherSource, workingDirectory = secondRoot, projectRoot = secondRoot, daemon = secondConnection)
            first.awaitStarted()
            second.awaitStarted()
            val firstGeneration = connection.generation()
            val secondGeneration = secondConnection.generation()
            assertNotEquals(firstGeneration.process.pid(), secondGeneration.process.pid())
            assertNotEquals(
                connection.workspace(firstGeneration, root.toRealPath()),
                secondConnection.workspace(secondGeneration, secondRoot),
            )
            scope.cancel()
            assertEquals(130, first.exit.awaitResult())
            withTimeout(10_000L) { scope.coroutineContext[kotlinx.coroutines.Job]!!.join() }
            assertTrue(!firstGeneration.process.isAlive)
            assertTrue(secondGeneration.process.isAlive)
            assertEquals(0, second.exit.awaitResult())
            val again = execute(otherSource, workingDirectory = secondRoot, projectRoot = secondRoot, daemon = secondConnection)
            assertEquals(0, again.exit.awaitResult())
            assertEquals(secondGeneration.number, secondConnection.generation().number)
            secondConnection.closeForTest()
            assertTrue(!secondGeneration.process.isAlive)
        } finally {
            secondConnection.closeForTest()
            secondScope.cancel()
            secondRoot.toFile().deleteRecursively()
        }
    }

    @Test
    fun authenticatedTcpRejectsMissingAndWrongCredentials() = runBlocking {
        connection.generation()
        val channel = io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder.forAddress("127.0.0.1", port).usePlaintext().build()
        try {
            val stub = org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.DaemonServiceGrpc.newBlockingStub(channel)
            val request = org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.GetInfoRequest.newBuilder()
                .setClientApi(org.ferretlang.jetbrains.protocol.ferretd.daemon.v1.ApiVersion.newBuilder().setMajor(1).setMinor(1)).build()
            for (credential in listOf<String?>(null, "wrong-credential")) {
                val headers = io.grpc.Metadata()
                if (credential != null) headers.put(io.grpc.Metadata.Key.of("authorization", io.grpc.Metadata.ASCII_STRING_MARSHALLER), "Bearer $credential")
                try {
                    stub.withInterceptors(io.grpc.stub.MetadataUtils.newAttachHeadersInterceptor(headers))
                        .withDeadlineAfter(5, TimeUnit.SECONDS).getInfo(request)
                    error("Unauthenticated TCP must be rejected")
                } catch (error: io.grpc.StatusRuntimeException) {
                    assertEquals(io.grpc.Status.Code.UNAUTHENTICATED, error.status.code)
                }
            }
        } finally {
            channel.shutdownNow()
            assertTrue(channel.awaitTermination(5, TimeUnit.SECONDS))
        }
    }

    private fun execute(
        source: Path,
        parameters: FerretParameterBindings = FerretParameterBindings.EMPTY,
        workingDirectory: Path? = root,
        projectRoot: Path = root,
        daemon: FerretdDaemonConnection = connection,
    ): RecordingExecution {
        val sink = RecordingExecution()
        sink.handle = FerretExecutionClient(daemon).start(
            FerretExecutionInput(
                source.toString(),
                workingDirectory?.toString().orEmpty(),
                projectRoot.toString(),
                parameters,
            ),
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
        val started = CompletableDeferred<Unit>()
        val events = Collections.synchronizedList(mutableListOf<String>())
        val debug = Collections.synchronizedList(mutableListOf<String>())
        val system = Collections.synchronizedList(mutableListOf<String>())
        val stdout = Collections.synchronizedList(mutableListOf<String>())
        val stderr = Collections.synchronizedList(mutableListOf<String>())
        val internal = Collections.synchronizedList(mutableListOf<String>())
        val exit = CompletableDeferred<Int>()
        lateinit var handle: org.ferretlang.jetbrains.execution.FerretExecutionHandle

        override fun started() { started.complete(Unit) }

        override fun debug(message: String) { debug += message }

        override fun system(message: String) {
            system += message
        }

        override fun stdout(message: String) {
            stdout += message
            events += "output"
        }

        override fun stderr(message: String) {
            stderr += message
        }

        override fun internal(message: String, cause: Throwable?) {
            internal += "$message: ${cause?.javaClass?.name}: ${cause?.message}"
        }

        override fun terminate(exitCode: Int) {
            events += "terminated:$exitCode"
            internal += "terminated=$exitCode"
            exit.complete(exitCode)
        }

        suspend fun awaitStarted() {
            withTimeout(15_000L) { started.await() }
        }

        fun debug(): String = "system=$system stdout=$stdout stderr=$stderr internal=$internal"
    }

    private suspend fun <T> CompletableDeferred<T>.awaitResult(): T = withTimeout(20_000L) { this@awaitResult.await() }
}
