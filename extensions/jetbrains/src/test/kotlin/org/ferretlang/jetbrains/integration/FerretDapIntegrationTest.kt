package org.ferretlang.jetbrains.integration

import com.google.gson.JsonParser
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.ferretlang.jetbrains.debugger.FerretDapCommand
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.ferretlang.jetbrains.run.FerretParameterBindingsJson
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import java.nio.file.Files
import java.nio.file.Path

@Category(FerretdIntegrationTest::class)
class FerretDapIntegrationTest {
    private lateinit var scope: CoroutineScope
    private lateinit var root: Path
    private val launches = mutableListOf<RealDapLaunch>()

    @Before fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        root = Files.createTempDirectory("ferret-real-dap-").toRealPath()
    }

    @After fun tearDown() = runBlocking {
        try {
            withTimeout(20_000) {
                launches.forEach { it.session.stop() }
                launches.forEach { it.session.completion.await(); assertFalse(it.process.isAlive) }
            }
        } finally {
            scope.cancel()
            root.toFile().deleteRecursively()
        }
    }

    @Test fun stepsThroughFunctionsAndLoadsPagedStacksWithInspection() = runBlocking {
        withTimeout(15_000) {
            val launch = launch("steps.fql", """
                FUNC add(value) {
                  LET next = value + 1
                  RETURN next
                }
                LET input = @value
                LET first = add(input)
                LET second = add(first)
                RETURN second
            """.trimIndent(), FerretParameterBindingsJson.parse("""{"value":2}"""), 6)
            launch.session.launchCompleted.await()
            assertTrue(launch.listener.replacements.receive().second.single().isVerified)
            var stop = launch.stopped()
            assertEquals("breakpoint", stop.reason)
            assertEquals(listOf(6L), stop.hitKeys)
            val first = requireNotNull(launch.session.stackTrace(stop, 0, 1)).stackFrames.single()
            assertEquals(6, first.line)
            assertEquals(Path.of(launch.input.sourcePath).toString(), first.source.path)
            launch.replace(2)
            launch.listener.replacements.receive()
            for (command in listOf(FerretDapCommand.STEP_IN, FerretDapCommand.STEP_OUT, FerretDapCommand.NEXT)) {
                launch.session.command(command, stop)
                val next = launch.stopped()
                assertTrue(next.generation > stop.generation)
                val stack = requireNotNull(launch.session.stackTrace(next, 0, 1))
                assertTrue(stack.stackFrames.isNotEmpty())
                assertTrue(stack.stackFrames.first().name.isNotBlank())
                val frame = stack.stackFrames.first()
                val groups = requireNotNull(launch.session.scopes(next, frame.id)).scopes
                assertEquals(listOf("Locals", "Parameters"), groups.map { it.name })
                groups.forEach { assertNotNull(launch.session.variables(next, it.variablesReference)) }
                assertEquals("2", requireNotNull(launch.session.evaluate(next, frame.id, "@value")).result)
                if (command == FerretDapCommand.STEP_IN) {
                    val caller = requireNotNull(launch.session.stackTrace(next, 1, 1))
                    assertEquals(1, caller.stackFrames.size)
                    assertNotEquals(stack.stackFrames.first().id, caller.stackFrames.first().id)
                }
                stop = next
            }
            launch.session.command(FerretDapCommand.CONTINUE, stop)
            assertEquals(0, launch.session.completion.await())
            assertTrue(launch.listener.output.receive().first.contains("4"))
        }
    }

    @Test fun replacesBreakpointsWhileRunningAndPausesAfterResume() = runBlocking {
        withTimeout(15_000) {
            val launch = launch("live.fql", "RETURN FOR i IN 1..1000000\n LET delay = WAIT(10)\n LET value = i + 1\n RETURN value")
            launch.session.launchCompleted.await()
            launch.replace(1, 3)
            assertTrue(launch.listener.replacements.receive().second.single().isVerified)
            val hit = launch.stopped()
            assertEquals("breakpoint", hit.reason)
            assertEquals(listOf(3L), hit.hitKeys)
            assertEquals(3, requireNotNull(launch.session.stackTrace(hit, 0, 1)).stackFrames.single().line)
            val frame = requireNotNull(launch.session.stackTrace(hit, 0, 1)).stackFrames.single()
            val locals = requireNotNull(launch.session.scopes(hit, frame.id)).scopes.first()
            assertTrue(requireNotNull(launch.session.variables(hit, locals.variablesReference)).variables.isNotEmpty())
            assertNotNull(launch.session.evaluate(hit, frame.id, "i"))
            launch.replace(2)
            assertTrue(launch.listener.replacements.receive().second.isEmpty())
            launch.session.command(FerretDapCommand.CONTINUE, hit)
            launch.listener.resumed.receive()
            launch.session.command(FerretDapCommand.PAUSE)
            val paused = launch.stopped()
            assertEquals("pause", paused.reason)
            assertNull(launch.session.variables(hit, locals.variablesReference))
            val pausedFrame = requireNotNull(launch.session.stackTrace(paused, 0, 1)).stackFrames.single()
            assertNotNull(launch.session.scopes(paused, pausedFrame.id))
            launch.replace(3, 4)
            launch.listener.replacements.receive()
            launch.session.command(FerretDapCommand.CONTINUE, paused)
            assertEquals("breakpoint", launch.stopped().reason)
            launch.session.stop()
            launch.session.completion.await()
            assertFalse(launch.process.isAlive)
        }
    }

    @Test fun debugsExplicitExcludedSourcesWithOriginalIdentityAndWorkspace() = runBlocking {
        Files.writeString(root.resolve("value.txt"), "project workspace")
        Files.createDirectories(root.resolve("module"))
        Files.writeString(root.resolve("module/go.mod"), "module example.com/nested\n")
        for (relativePath in listOf(".tmp/test.fql", "testdata/test.fql", "module/test.fql")) {
            withTimeout(15_000) {
                val source = root.resolve(relativePath)
                Files.createDirectories(source.parent)
                Files.writeString(source.parent.resolve("value.txt"), "wrong source parent")
                val launch = launch(relativePath, "LET value = 7\nRETURN {value, root: TO_STRING(IO::FS::READ(\"value.txt\"))}", lines = intArrayOf(2))
                launch.session.launchCompleted.await()
                assertTrue(relativePath, launch.listener.replacements.receive().second.single().isVerified)
                val stop = launch.stopped()
                assertEquals("breakpoint", stop.reason)
                assertEquals(listOf(2L), stop.hitKeys)
                val frame = requireNotNull(launch.session.stackTrace(stop, 0, 1)).stackFrames.single()
                assertEquals(source.toString(), frame.source.path)
                assertEquals(2, frame.line)
                val locals = requireNotNull(launch.session.scopes(stop, frame.id)).scopes.single { it.name == "Locals" }
                val value = requireNotNull(launch.session.variables(stop, locals.variablesReference)).variables.single { it.name == "value" }
                assertEquals("7", value.value)
                assertEquals("8", requireNotNull(launch.session.evaluate(stop, frame.id, "value + 1")).result)
                launch.session.command(FerretDapCommand.CONTINUE, stop)
                assertEquals(0, launch.session.completion.await())
                assertEquals(JsonParser.parseString("""{"value":7,"root":"project workspace"}"""), JsonParser.parseString(launch.listener.output.receive().first))
                assertTrue(launch.listener.errors.tryReceive().isFailure)
                assertFalse(launch.process.isAlive)
            }
        }
    }

    @Test fun hitsVerifiedBreakpointAtFirstExecutableStatement() = runBlocking {
        withTimeout(15_000) {
            val launch = launch("first-statement.fql", "LET value = 1\nRETURN value", lines = intArrayOf(1))
            launch.session.launchCompleted.await()
            assertTrue(launch.listener.replacements.receive().second.single().isVerified)
            val stop = launch.stopped()
            assertEquals("breakpoint", stop.reason)
            assertEquals(listOf(1L), stop.hitKeys)
            val frame = requireNotNull(launch.session.stackTrace(stop, 0, 1)).stackFrames.single()
            assertEquals(launch.input.sourcePath, frame.source.path)
            assertEquals(1, frame.line)
            assertEquals(1, frame.column)
            assertTrue(launch.session.isCurrentStop(stop))
            assertFalse(launch.session.completion.isCompleted)
            launch.session.command(FerretDapCommand.CONTINUE, stop)
            assertEquals(0, launch.session.completion.await())
            assertEquals("1", launch.listener.output.receive().first.trim())
            assertTrue(launch.listener.stops.tryReceive().isFailure)
            assertTrue(launch.listener.errors.tryReceive().isFailure)
            assertFalse(launch.process.isAlive)
        }
    }

    @Test fun preservesUnicodeAndIndependentRuntimeDirectoryAndParameters() = runBlocking {
        withTimeout(15_000) {
            val runtime = Files.createTempDirectory("ferret-dap-runtime-")
            try {
                Files.writeString(runtime.resolve("value.txt"), "external 😀")
                Files.writeString(root.resolve("value.txt"), "wrong workspace")
                val source = Files.writeString(root.resolve("unicode.fql"), "LET text = \"😀\"\n\nLET value = TO_STRING(IO::FS::READ(@file))\nRETURN {value, text, params: @params}")
                val input = FerretLaunchInput(source.toString(), runtime.toString(), root.toString(),
                    FerretParameterBindingsJson.parse("""{"file":"value.txt","params":[null,true,1.25,{"name":"é"}]}"""))
                val launch = RealDapLaunch(input, scope, 2).also(launches::add)
                launch.session.launchCompleted.await()
                val result = launch.listener.replacements.receive().second.single()
                assertTrue(result.isVerified)
                assertEquals(3, result.line)
                val stop = launch.stopped()
                val frame = requireNotNull(launch.session.stackTrace(stop, 0, 1)).stackFrames.single()
                assertEquals(3, frame.line)
                assertEquals(source.toString(), frame.source.path)
                launch.session.command(FerretDapCommand.CONTINUE, stop)
                assertEquals(0, launch.session.completion.await())
                val output = launch.listener.output.receive().first
                assertTrue(output, output.contains("external 😀"))
                assertTrue(output, output.contains("1.25"))
                assertFalse(output, output.contains("wrong workspace"))
            } finally { runtime.toFile().deleteRecursively() }
        }
    }

    @Test fun stoppingOneAdapterLeavesAnotherSuspendedAndUsable() = runBlocking {
        withTimeout(15_000) {
            val first = launch("first.fql", "LET value = 1\nRETURN value", lines = intArrayOf(2))
            val second = launch("second.fql", "LET value = 2\nRETURN value", lines = intArrayOf(2))
            first.session.launchCompleted.await()
            second.session.launchCompleted.await()
            first.stopped()
            val stop = second.stopped()
            assertNotEquals(first.process.pid(), second.process.pid())
            first.session.stop()
            first.session.completion.await()
            assertTrue(second.process.isAlive)
            assertNotNull(second.session.stackTrace(stop, 0, 1))
            second.session.command(FerretDapCommand.CONTINUE, stop)
            assertEquals(0, second.session.completion.await())
        }
    }

    private fun launch(name: String, text: String, bindings: FerretParameterBindings = FerretParameterBindings.EMPTY, vararg lines: Int): RealDapLaunch {
        val source = Files.writeString(root.resolve(name), text)
        return RealDapLaunch(FerretLaunchInput(source.toString(), "", root.toString(), bindings), scope, *lines).also(launches::add)
    }
}
