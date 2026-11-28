package org.ferretlang.jetbrains.integration

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.eclipse.lsp4j.debug.VariablesArgumentsFilter
import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import org.ferretlang.jetbrains.debugger.FerretDapStop
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.run.FerretParameterBindings
import org.ferretlang.jetbrains.runtime.FerretDebugRuntime
import org.ferretlang.jetbrains.runtime.FerretRuntimeDescriptor
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.experimental.categories.Category
import java.nio.file.Files

@Category(FerretdIntegrationTest::class)
class FerretCollectionInspectionIntegrationTest {
    private val root = Files.createTempDirectory("ferret-page-test").toRealPath()
    private val indexed = VariablesArgumentsFilter.INDEXED
    private val named = VariablesArgumentsFilter.NAMED

    @After fun clean() { root.toFile().deleteRecursively() }

    @Test fun boundedPagesThroughBothReleasedRuntimes() = runBlocking {
        withTimeout(120_000) {
            WireHost.start(root, controlled = true).use { app ->
                for (host in listOf(null, app)) for (size in listOf(100, 10_000, 1_000_000)) {
                    val program = "LET array = ARRAYS::RANGE(0, ${size - 1})\n" +
                        "LET dataset = (FOR n IN 0..${size - 1} RETURN n)\nRETURN [array, dataset]"
                    inspect(program, host) { stop, frame ->
                        val pagesBefore = host?.count("page")
                        for ((index, expression) in listOf("array", "dataset").withIndex()) {
                            val value = requireNotNull(session.evaluate(stop, frame, expression))
                            assertEquals("Array($size)", value.result)
                            assertEquals(size, value.indexedVariables)
                            assertEquals(0, value.namedVariables)
                            assertTrue(value.variablesReference > 0)
                            val ref = value.variablesReference
                            assertEquals(pagesBefore?.plus(index * (if (size == 100) 2 else 3)), host?.count("page"))
                            val starts = if (size == 100) listOf(0, size - 3) else listOf(0, 100, size - 3)
                            for (start in starts) {
                                val count = minOf(100, size - start)
                                val rows = requireNotNull(session.variables(stop, ref, indexed, start, count)).variables
                                assertEquals((start until start + count).map(Int::toString), rows.map { it.name })
                                assertEquals(start.toDouble(), rows.first().value.toDouble(), 0.0)
                            }
                        }
                    }
                }
            }
        }
    }

    @Test fun wireProviderCountsReadsAndKeepsOverlappingHandles() = runBlocking {
        withTimeout(60_000) {
            WireHost.start(root, controlled = true).use { host ->
                for ((index, size) in listOf(100, 10_000, 1_000_000).withIndex()) {
                    inspect("LET rows = DEMO::INSPECTED(\"known\", $size)\nRETURN rows", host) { stop, frame ->
                        val value = requireNotNull(session.evaluate(stop, frame, "rows"))
                        val readBefore = host.await("evaluated", index + 1).get("reads").asLong
                        assertEquals(index * 101L, readBefore)
                        val ref = value.variablesReference
                        assertEquals(size, value.indexedVariables)
                        val first = requireNotNull(session.variables(stop, ref, indexed, 0, 100)).variables
                        val page = host.await("page", index * 3 + 1)
                        assertEquals(100, page.getAsJsonObject("page").get("count").asInt)
                        assertEquals(100L, page.get("reads").asLong - readBefore)
                        assertEquals(100, first.size)
                        val nested = first.first().variablesReference
                        assertTrue(nested > 0)
                        assertEquals(nested, requireNotNull(session.variables(stop, ref, indexed, 0, 1)).variables.single().variablesReference)
                        assertEquals("7", requireNotNull(session.variables(stop, nested, indexed, 0, 1)).variables.single().value)
                    }
                }
            }
        }
    }

    @Test fun virtualRangesGroupsAndContinuationsUseImmediateHandles() = runBlocking {
        withTimeout(60_000) {
            WireHost.start(root, controlled = true).use { host ->
                val source = """
                    LET mixed = DEMO::INSPECTED("mixed", 3)
                    LET partial = DEMO::INSPECTED("unreadable", 2)
                    LET full = DEMO::INSPECTED("unknown", 100)
                    LET tail = DEMO::INSPECTED("unknown", 103)
                    LET proof = DEMO::INSPECTED("proof", 101)
                    LET huge = DEMO::INSPECTED("known", 3000000000)
                    RETURN [mixed, partial, full, tail, proof, huge]
                """.trimIndent()
                inspect(source, host) { stop, frame ->
                    suspend fun ref(expression: String) = requireNotNull(session.evaluate(stop, frame, expression)).variablesReference
                    suspend fun page(r: Int, filter: VariablesArgumentsFilter, start: Int = 0, count: Int = 100) =
                        requireNotNull(session.variables(stop, r, filter, start, count)).variables
                    val mixed = ref("mixed")
                    val names = page(mixed, named).single()
                    val indices = page(mixed, indexed).single()
                    assertEquals(listOf("Named", "Indexed"), listOf(names.name, indices.name))
                    assertEquals("virtual", names.presentationHint.kind)
                    assertEquals(listOf("0", "e\u0301😀", "2"), page(names.variablesReference, named).map { it.name })
                    assertEquals("0", page(indices.variablesReference, indexed).first().name)
                    val partial = ref("partial")
                    val unreadable = page(partial, named).single()
                    assertTrue(runCatching { page(unreadable.variablesReference, named) }.exceptionOrNull() is ResponseErrorException)
                    assertEquals(2, page(page(partial, indexed).single().variablesReference, indexed).size)
                    for ((expression, count) in listOf("full" to 0, "tail" to 3)) {
                        val root = ref(expression)
                        assertEquals(100, page(root, indexed).size)
                        val next = page(root, indexed, 100).single()
                        assertEquals("virtual", next.presentationHint.kind)
                        assertNull(next.indexedVariables)
                        assertEquals(0, next.namedVariables)
                        assertEquals((100 until 100 + count).map(Int::toString), page(next.variablesReference, indexed).map { it.name })
                    }
                    val proof = ref("proof")
                    assertTrue(runCatching { page(proof, named, 100) }.exceptionOrNull() is ResponseErrorException)
                    assertEquals("0", page(proof, named, 0, 1).single().name)
                    var range = page(ref("huge"), indexed).last()
                    var levels = 0
                    while (range.presentationHint?.kind == "virtual") {
                        assertTrue(++levels < 10)
                        range = page(range.variablesReference, indexed).last()
                    }
                    assertTrue(levels >= 2)
                    assertEquals("2999999999", range.name)
                }
            }
        }
    }

    @Test fun cancellingHeldPageInterruptsOnlyItsWireOperation() = runBlocking {
        withTimeout(30_000) {
            WireHost.start(root, controlled = true).use { host ->
                inspect("LET rows = DEMO::INSPECTED(\"known\", 10000)\nRETURN rows", host) { stop, frame ->
                    val ref = requireNotNull(session.evaluate(stop, frame, "rows")).variablesReference
                    host.command("arm", "variables")
                    host.await("armed", token = "variables")
                    coroutineScope {
                        val pending = async(kotlinx.coroutines.Dispatchers.IO) { session.variables(stop, ref, indexed, 0, 100) }
                        host.await("held", token = "variables")
                        pending.cancelAndJoin()
                        host.await("interrupted", token = "variables")
                    }
                    val live = requireNotNull(session.variables(stop, ref, indexed, 100, 1)).variables.single()
                    assertEquals("100", live.name)
                }
            }
        }
    }

    @Test fun explicitWireSelectionRejectsAnIncompatibleHandshake() = runBlocking {
        withTimeout(20_000) {
            WireHost.start(root, incompatible = true).use { host ->
                val run = launch("RETURN 1", host)
                assertEquals(1, run.session.completion.await())
                assertFalse(run.process.isAlive)
                assertTrue(run.listener.stops.tryReceive().isFailure)
                assertEquals(0, host.count("debugStart"))
                assertTrue(run.listener.errors.receive().contains("runtime 'App'"))
                host.await("connected")
                assertEquals(0, host.count("compile"))
            }
        }
    }

    private suspend fun CoroutineScope.inspect(
        program: String, host: WireHost?, check: suspend RealDapLaunch.(FerretDapStop, Int) -> Unit,
    ) {
        val run = launch(program, host)
        try {
            val stop = run.stopped()
            val frame = requireNotNull(run.session.stackTrace(stop, 0, 1)).stackFrames.single().id
            run.check(stop, frame)
        } finally {
            run.session.stop()
            run.session.completion.await()
        }
    }

    private fun CoroutineScope.launch(program: String, host: WireHost?): RealDapLaunch {
        val path = Files.writeString(root.resolve("pages.fql"), program)
        val config = host?.configure(root.resolve("runtimes.json"))
        val input = FerretLaunchInput(path.toString(), "", root.toString(), FerretParameterBindings.EMPTY,
            runtimeName = if (host == null) "" else "App")
        return RealDapLaunch(input, this, program.lines().size, prepareRuntime = {
            if (config == null) FerretDebugRuntime.LOCAL
            else FerretDebugRuntime(FerretRuntimeDescriptor("App", "App", "wire"), config) {}
        })
    }
}
