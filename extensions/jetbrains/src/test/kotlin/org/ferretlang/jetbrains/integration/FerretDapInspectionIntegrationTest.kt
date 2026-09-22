package org.ferretlang.jetbrains.integration

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.eclipse.lsp4j.debug.Variable
import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import org.ferretlang.jetbrains.debugger.FerretDapCommand
import org.ferretlang.jetbrains.debugger.FerretDapStop
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.run.FerretParameterBindingsJson
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.experimental.categories.Category
import java.nio.file.Files
import java.nio.file.Path

@Category(FerretdIntegrationTest::class)
class FerretDapInspectionIntegrationTest {
    private lateinit var scope: CoroutineScope
    private lateinit var root: Path
    private val launches = mutableListOf<RealDapLaunch>()

    @Before fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        root = Files.createTempDirectory("ferret-real-inspection-").toRealPath()
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

    @Test fun selectedFramesExposeDistinctBindingsCanonicalParametersAndNestedValues() = runBlocking {
        withTimeout(15_000) {
            val launch = launch("frames.fql")
            val stop = launch.stopped()
            assertEquals(stop.description, "breakpoint", stop.reason)
            val session = launch.session
            val frames = requireNotNull(session.stackTrace(stop, 0, 10)).stackFrames
            assertEquals(listOf("inner", "outer", "<main>"), frames.map { it.name })
            val callerPage = requireNotNull(session.stackTrace(stop, 1, 1)).stackFrames.single()
            assertEquals("outer", callerPage.name)
            val locals = frames.map { launch.values(stop, it.id, "Locals") }
            assertEquals("5", locals[0].getValue("local").value)
            assertEquals("3", locals[0].getValue("q").value)
            assertEquals("2", locals[1].getValue("caller").value)
            assertEquals("2", locals[1].getValue("p").value)
            assertFalse(locals[1].containsKey("q"))
            assertFalse(locals[2].containsKey("p"))
            for ((index, expression) in listOf("local", "p + @input", "box.value + @input").withIndex()) {
                assertEquals(listOf("5", "4", "12")[index], requireNotNull(session.evaluate(stop, frames[index].id, expression)).result)
            }
            assertEquals("4", requireNotNull(session.evaluate(stop, callerPage.id, "p + @input")).result)
            val box = locals[2].getValue("box")
            assertEquals("Object", box.type)
            assertTrue(box.variablesReference > 0)
            val children = requireNotNull(session.variables(stop, box.variablesReference)).variables.associateBy { it.name }
            assertEquals("10", children.getValue("value").value)
            val nested = children.getValue("nested")
            assertTrue(nested.variablesReference > 0)
            assertEquals("nested", nested.evaluateName) // Upstream bare names are not standalone expressions.
            assertEquals(listOf("1", "2"), requireNotNull(session.variables(stop, nested.variablesReference)).variables.map { it.value })
            val big = locals[2].getValue("big")
            assertEquals("Array", big.type)
            assertEquals("Array(9)", big.value)
            assertEquals(0, big.variablesReference)
            assertTrue(requireNotNull(session.variables(stop, big.variablesReference)).variables.isEmpty())
            for (frame in frames) {
                val parameters = launch.values(stop, frame.id, "Parameters")
                assertEquals(setOf("@input", "@text", "@flag", "@number", "@nothing", "@array", "@object"), parameters.keys)
                assertEquals("\"hello\"", parameters.getValue("@text").value)
                assertEquals("String", parameters.getValue("@text").type)
                assertEquals("true", parameters.getValue("@flag").value)
                assertEquals("1.25", parameters.getValue("@number").value)
                assertEquals("NONE", parameters.getValue("@nothing").value)
                assertTrue(parameters.getValue("@array").variablesReference > 0)
                assertTrue(parameters.getValue("@object").variablesReference > 0)
            }
            assertTrue(locals.all { values -> values.keys.none { it.startsWith("@") } })
        }
    }

    @Test fun canonicalExpressionsAndInvalidHandlesDoNotPoisonInspection() = runBlocking {
        withTimeout(15_000) {
            val launch = launch("expressions.fql")
            val stop = launch.stopped()
            val session = launch.session
            val frame = requireNotNull(session.stackTrace(stop, 0, 1)).stackFrames.single()
            for ((expression, result) in mapOf("local" to "5", "@input" to "2", "@object.n" to "3", "@array[0]" to "1", "q + 1" to "4", "@nothing" to "NONE", "" to "")) {
                assertEquals(expression, result, requireNotNull(session.evaluate(stop, frame.id, expression)).result)
            }
            val structured = requireNotNull(session.evaluate(stop, frame.id, "@object"))
            assertEquals("Object", structured.type)
            assertTrue(structured.variablesReference > 0)
            assertEquals("3", requireNotNull(session.variables(stop, structured.variablesReference)).variables.single().value)
            for (expression in listOf("missing", "LEN(@array)", "q +", "RETURN 1")) {
                val error = runCatching { session.evaluate(stop, frame.id, expression) }.exceptionOrNull()
                assertTrue("Expected expression rejection for $expression: $error", error is ResponseErrorException)
                assertTrue((error as ResponseErrorException).responseError.message.isNotBlank())
            }
            assertTrue(runCatching { session.scopes(stop, 999_999) }.exceptionOrNull() is ResponseErrorException)
            assertTrue(runCatching { session.variables(stop, 999_999) }.exceptionOrNull() is ResponseErrorException)
            assertTrue(runCatching { session.evaluate(stop, 999_999, "local") }.exceptionOrNull() is ResponseErrorException)
            assertEquals("5", requireNotNull(session.evaluate(stop, frame.id, "local")).result)
            assertTrue(session.isCurrentStop(stop))
            assertTrue(launch.listener.errors.tryReceive().isFailure)
        }
    }

    @Test fun inspectionRefreshesAfterStepAndContinueAndOldHandlesStayObsolete() = runBlocking {
        withTimeout(15_000) {
            val launch = launch("cycles.fql")
            val session = launch.session
            val first = launch.stopped()
            val frame = requireNotNull(session.stackTrace(first, 0, 1)).stackFrames.single()
            assertEquals("5", requireNotNull(session.evaluate(first, frame.id, "local")).result)
            val reference = requireNotNull(session.scopes(first, frame.id)).scopes.first().variablesReference
            session.command(FerretDapCommand.STEP_OUT, first)
            val step = launch.stopped()
            val caller = requireNotNull(session.stackTrace(step, 0, 1)).stackFrames.single()
            assertEquals("outer", caller.name)
            assertEquals("2", requireNotNull(session.evaluate(step, caller.id, "p")).result)
            assertNull(session.variables(first, reference))
            assertNull(session.scopes(first, frame.id))
            assertNull(session.evaluate(first, frame.id, "local"))
            session.command(FerretDapCommand.CONTINUE, step)
            val second = launch.stopped()
            val current = requireNotNull(session.stackTrace(second, 0, 1)).stackFrames.single()
            assertEquals("8", requireNotNull(session.evaluate(second, current.id, "local")).result)
            assertEquals("8", launch.values(second, current.id, "Locals").getValue("local").value)
            assertNotEquals(first.generation, second.generation)
            session.command(FerretDapCommand.CONTINUE, second)
            assertEquals(0, session.completion.await())
        }
    }

    @Test fun runtimeFailureRemainsInspectableUntilContinued() = runBlocking {
        withTimeout(15_000) {
            val launch = launch("failure.fql", "LET x = 7\nRETURN x / 0", breakpoint = null)
            val stop = launch.stopped()
            assertEquals("exception", stop.reason)
            assertTrue(stop.description.orEmpty().isNotBlank())
            val frame = requireNotNull(launch.session.stackTrace(stop, 0, 1)).stackFrames.single()
            assertEquals("7", launch.values(stop, frame.id, "Locals").getValue("x").value)
            assertEquals("7", requireNotNull(launch.session.evaluate(stop, frame.id, "x")).result)
            assertFalse(launch.session.completion.isCompleted)
            launch.session.command(FerretDapCommand.CONTINUE, stop)
            assertEquals(1, launch.session.completion.await())
            assertFalse(launch.process.isAlive)
        }
    }

    @Test fun separateProcessesKeepInspectionIndependentAndFreshLaunchWorksAfterExit() = runBlocking {
        withTimeout(15_000) {
            val first = launch("first.fql")
            val second = launch("second.fql")
            val a = first.stopped()
            val b = second.stopped()
            val af = requireNotNull(first.session.stackTrace(a, 0, 1)).stackFrames.single()
            val bf = requireNotNull(second.session.stackTrace(b, 0, 1)).stackFrames.single()
            assertNotEquals(first.process.pid(), second.process.pid())
            assertEquals("5", requireNotNull(first.session.evaluate(a, af.id, "local")).result)
            assertEquals("5", requireNotNull(second.session.evaluate(b, bf.id, "local")).result)
            assertNull(second.session.evaluate(a, af.id, "local"))
            first.session.stop()
            first.session.completion.await()
            val values = second.values(b, bf.id, "Parameters")
            assertTrue(requireNotNull(second.session.variables(b, values.getValue("@object").variablesReference)).variables.isNotEmpty())
            val fresh = launch("fresh.fql")
            val c = fresh.stopped()
            val cf = requireNotNull(fresh.session.stackTrace(c, 0, 1)).stackFrames.single()
            assertEquals("5", requireNotNull(fresh.session.evaluate(c, cf.id, "local")).result)
            assertTrue(second.session.isCurrentStop(b))
        }
    }

    private suspend fun RealDapLaunch.values(stop: FerretDapStop, frame: Int, name: String): Map<String, Variable> {
        val scopes = requireNotNull(session.scopes(stop, frame)).scopes
        assertEquals(listOf("Locals", "Parameters"), scopes.map { it.name })
        return requireNotNull(session.variables(stop, scopes.single { it.name == name }.variablesReference)).variables.associateBy { it.name }
    }

    private fun launch(name: String, source: String = SOURCE, breakpoint: String? = "RETURN local"): RealDapLaunch {
        val path = Files.writeString(root.resolve(name), source)
        val input = FerretLaunchInput(path.toString(), "", root.toString(), FerretParameterBindingsJson.parse(
            """{"input":2,"text":"hello","flag":true,"number":1.25,"nothing":null,"array":[1,2],"object":{"n":3}}""",
        ))
        val lines = breakpoint?.let { intArrayOf(source.lines().indexOfFirst { line -> line.trim() == it } + 1) } ?: intArrayOf()
        return RealDapLaunch(input, scope, *lines).also(launches::add)
    }

    companion object {
        private val SOURCE = """
            LET box = {value: 10, nested: [1, 2]}
            LET big = [1,2,3,4,5,6,7,8,9]
            LET params = [@text, @flag, @number, @nothing, @array, @object]
            FUNC outer(p) {
              LET caller = p
              FUNC inner(q) {
                LET local = caller + q
                RETURN local
              }
              LET result = inner(3)
              RETURN result
            }
            LET first = outer(@input)
            LET second = outer(first)
            RETURN {second, box, big, params}
        """.trimIndent()
    }
}
