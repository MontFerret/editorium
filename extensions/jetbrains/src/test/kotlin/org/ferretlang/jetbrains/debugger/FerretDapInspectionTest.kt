package org.ferretlang.jetbrains.debugger

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.eclipse.lsp4j.debug.*
import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import org.eclipse.lsp4j.jsonrpc.messages.ResponseError
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CompletableFuture

class FerretDapInspectionTest {
    @Test fun nullParametersSurviveTheDapWireEncoding() = runBlocking {
        withTimeout(8_000) {
            val launch = DapTestLaunch(bindings = org.ferretlang.jetbrains.run.FerretParameterBindingsJson.parse(
                """{"nothing":null,"nested":{"nothing":null},"array":[null],"boolean":true,"number":1.25,"string":"😀"}""",
            ))
            try {
                launch.start()
                launch.session.launchCompleted.await()
                val parameters = launch.adapter.launched.get()["parameters"] as Map<*, *>
                assertTrue("Null parameter was omitted on the wire", parameters.containsKey("nothing"))
                assertNull(parameters["nothing"])
                val nested = parameters["nested"] as Map<*, *>
                assertTrue("Nested null was omitted on the wire", nested.containsKey("nothing"))
                assertNull(nested["nothing"])
                assertEquals(listOf(null), parameters["array"])
                assertEquals(true, parameters["boolean"])
                assertEquals(1.25, parameters["number"])
                assertEquals("😀", parameters["string"])
            } finally { launch.close() }
        }
    }

    @Test fun inspectionUsesExactHandlesAndUnmodifiedExpressionsWithoutPaging() = scenario {
        val stop = suspendSession()
        assertFalse(adapter.history.any { it in listOf("scopes", "variables", "evaluate") })
        val requests = pending(stop)
        assertEquals(42, requests.scopes.first.frameId)
        assertEquals(73, requests.variables.first.variablesReference)
        assertNull(requests.variables.first.start)
        assertNull(requests.variables.first.count)
        assertNull(requests.variables.first.filter)
        assertEquals(42, requests.evaluate.first.frameId)
        assertEquals("  caller + @input\n", requests.evaluate.first.expression)
        assertNull(requests.evaluate.first.context)
        requests.respond(false)
        assertTrue(requests.results.all { it.await() != null })
        for (reference in listOf(0, -1)) assertTrue(requireNotNull(session.variables(stop, reference)).variables.isEmpty())
        assertEquals(1, adapter.history.count { it == "variables" })
    }

    @Test fun everyResumeCommandSettlesInspectionBeforeItsResponseAndIgnoresLateReplies() = scenario {
        var stop = suspendSession()
        for ((index, command) in listOf(FerretDapCommand.CONTINUE, FerretDapCommand.NEXT, FerretDapCommand.STEP_IN, FerretDapCommand.STEP_OUT).withIndex()) {
            val requests = pending(stop)
            session.command(command, stop)
            val control = adapter.controlRequests.receive()
            requests.results.forEach { assertNull(it.await()) }
            assertNull(session.scopes(stop, 42))
            assertNull(session.variables(stop, 73))
            assertNull(session.evaluate(stop, 42, "caller"))
            assertNull(session.stackTrace(stop, 100, 100))
            adapter.stop("step")
            val next = listener.stops.receive()
            requests.respond(index % 2 == 0)
            control.second.complete(null)
            barrier(next)
            assertTrue(session.isCurrentStop(next))
            assertTrue(listener.errors.tryReceive().isFailure)
            stop = next
        }
    }

    @Test fun aReplacementStopInvalidatesSuccessesAndErrorsWithoutWaitingForResume() = scenario {
        val old = suspendSession()
        val requests = pending(old)
        adapter.stop("exception")
        val current = listener.stops.receive()
        requests.results.forEach { assertNull(it.await()) }
        requests.respond(true)
        barrier(current)
        assertTrue(session.isCurrentStop(current))
        assertTrue(listener.errors.tryReceive().isFailure)
    }

    @Test fun aRejectedControlDoesNotReviveOldInspection() = scenario {
        val old = suspendSession()
        val requests = pending(old)
        session.command(FerretDapCommand.NEXT, old)
        val control = adapter.controlRequests.receive()
        requests.results.forEach { assertNull(it.await()) }
        control.second.completeExceptionally(rejected())
        val restored = listener.stops.receive()
        assertTrue(restored.generation > old.generation)
        assertFalse(session.isCurrentStop(old))
        requests.respond(false)
        barrier(restored)
        assertTrue(session.isCurrentStop(restored))
        assertEquals(1, listener.errors.tryReceive().let { if (it.isSuccess) 1 else 0 })
        assertTrue(listener.errors.tryReceive().isFailure)
    }

    @Test fun requestErrorsStayLocalAndTheConnectionRemainsUsable() = scenario {
        val stop = suspendSession()
        val requests = pending(stop)
        requests.respond(true)
        requests.results.forEach {
            assertEquals("synthetic inspection rejection", runCatching { it.await() }.exceptionOrNull()?.let { error ->
                FerretDapErrors.message(error, "unexpected failure")
            })
        }
        barrier(stop)
        assertTrue(session.isCurrentStop(stop))
        assertFalse(session.completion.isCompleted)
        assertTrue(listener.errors.tryReceive().isFailure)
        session.replaceBreakpoints(FerretDapBreakpoints(source, 1, emptyList()))
        adapter.breakpointRequests.receive().second.complete(SetBreakpointsResponse().apply { breakpoints = emptyArray() })
        assertTrue(listener.replacements.receive().second.isEmpty())
    }

    @Test fun inspectionTimeoutsStayLocalAndObsoleteDeadlinesCannotFailTheSession() = scenario(FerretDapTimeouts(5_000, 1_000, 100)) {
        val old = suspendSession()
        barrier(old)
        val owner = requireNotNull(scope.coroutineContext[Job])
        val before = activeDescendants(owner)
        val obsolete = pending(old)
        barrier(old)
        val deadlines = activeDescendants(owner) - before
        assertEquals(4, deadlines.size)
        adapter.stop("step")
        val current = listener.stops.receive()
        obsolete.results.forEach { assertNull(it.await()) }
        assertTrue(deadlines.all(Job::isCancelled))
        // Awaiting the later batch's deadlines proves the older deadlines have elapsed, without sleeps.
        val timedOut = pending(current)
        timedOut.results.forEach { assertTrue(runCatching { it.await() }.exceptionOrNull() is IllegalStateException) }
        obsolete.respond(true)
        timedOut.respond(false)
        barrier(current)
        assertTrue(session.isCurrentStop(current))
        assertFalse(session.completion.isCompleted)
        assertTrue(listener.errors.tryReceive().isFailure)
    }

    @Test fun cancellingAnInspectionCallerDoesNotPoisonTheSession() = scenario {
        val stop = suspendSession()
        val requests = pending(stop)
        requests.results.forEach { it.cancel(); it.join() }
        requests.respond(true)
        barrier(stop)
        assertTrue(session.isCurrentStop(stop))
        assertTrue(listener.errors.tryReceive().isFailure)
    }

    @Test fun liveBreakpointRevisionsAndCommittedHitsRemainIndependentOfInspection() = scenario {
        val stop = suspendSession()
        val inspection = pending(stop)
        session.replaceBreakpoints(FerretDapBreakpoints(source, 1, listOf(FerretDapBreakpoint(1, 2))))
        val first = adapter.breakpointRequests.receive()
        session.replaceBreakpoints(FerretDapBreakpoints(source, 2, listOf(FerretDapBreakpoint(2, 3))))
        val second = adapter.breakpointRequests.receive()
        second.second.complete(SetBreakpointsResponse().apply { breakpoints = arrayOf(Breakpoint().apply { id = 22; isVerified = true }) })
        assertEquals(2L, listener.replacements.receive().first.revision)
        first.second.complete(SetBreakpointsResponse().apply { breakpoints = arrayOf(Breakpoint().apply { id = 11; isVerified = true }) })
        session.replaceBreakpoints(FerretDapBreakpoints(source, 3, emptyList()))
        adapter.breakpointRequests.receive().second.complete(SetBreakpointsResponse().apply { breakpoints = emptyArray() })
        assertEquals(3L, listener.replacements.receive().first.revision)
        adapter.stop(ids = arrayOf(11))
        val committed = listener.stops.receive()
        assertEquals(listOf(1L), committed.hitKeys)
        inspection.results.forEach { assertNull(it.await()) }
        inspection.respond(false)
        barrier(committed)
        assertTrue(session.isCurrentStop(committed))
        assertTrue(listener.replacements.tryReceive().isFailure)
    }

    @Test fun stopTerminationTransportLossAndProjectCancellationSettleEveryInspection() = runBlocking {
        withTimeout(20_000) {
            for (ending in listOf("stop", "terminated", "transport", "project")) {
                val launch = DapTestLaunch()
                try {
                    val job = launch.start()
                    launch.session.launchCompleted.await()
                    launch.adapter.stop()
                    val stop = launch.listener.stops.receive()
                    val requests = launch.pending(stop)
                    when (ending) {
                        "stop" -> launch.session.stop()
                        "terminated" -> launch.adapter.client.terminated(TerminatedEventArguments())
                        "transport" -> launch.process.close()
                        "project" -> job.cancel()
                    }
                    requests.results.forEach { assertNull(it.await()) }
                    launch.session.completion.await()
                    assertFalse(launch.process.isAlive)
                    assertNull(launch.session.evaluate(stop, 42, "caller"))
                    assertEquals(if (ending == "transport") 1 else if (ending == "terminated") 0 else 130, launch.session.completion.await())
                } finally { launch.close() }
            }
        }
    }

    private suspend fun DapTestLaunch.suspendSession(): FerretDapStop {
        start()
        session.launchCompleted.await()
        adapter.stop()
        return listener.stops.receive()
    }

    private suspend fun DapTestLaunch.barrier(stop: FerretDapStop) {
        val work = CoroutineScope(currentCoroutineContext()).async { session.stackTrace(stop, 0, 1) }
        adapter.stackRequests.receive().second.complete(StackTraceResponse().apply { stackFrames = emptyArray() })
        assertNotNull(work.await())
    }

    private suspend fun DapTestLaunch.pending(stop: FerretDapStop): Pending {
        // Separate request consumers survive cancellation of the session's own lifetime.
        val consumers = CoroutineScope(currentCoroutineContext() + kotlinx.coroutines.SupervisorJob(currentCoroutineContext()[kotlinx.coroutines.Job]))
        val results = listOf(
            consumers.async { session.stackTrace(stop, 100, 100) },
            consumers.async { session.scopes(stop, 42) },
            consumers.async { session.variables(stop, 73) },
            consumers.async { session.evaluate(stop, 42, "  caller + @input\n") },
        )
        val stack = adapter.stackRequests.receive()
        val scopes = adapter.scopeRequests.receive()
        val variables = adapter.variableRequests.receive()
        val evaluate = adapter.evaluateRequests.receive()
        // Complete the supervisor when these four consumers settle; it owns no other work.
        results.last().invokeOnCompletion { (consumers.coroutineContext[kotlinx.coroutines.Job] as kotlinx.coroutines.CompletableJob).complete() }
        return Pending(results, scopes, variables, evaluate) { failed ->
            if (failed) listOf(stack.second, scopes.second, variables.second, evaluate.second).forEach { it.completeExceptionally(rejected()) }
            else {
                stack.second.complete(StackTraceResponse().apply { stackFrames = emptyArray() })
                scopes.second.complete(ScopesResponse().apply { this.scopes = emptyArray() })
                variables.second.complete(VariablesResponse().apply { this.variables = emptyArray() })
                evaluate.second.complete(EvaluateResponse().apply { result = "3"; type = "Int"; variablesReference = 0 })
            }
        }
    }

    private data class Pending(
        val results: List<Deferred<*>>,
        val scopes: Pair<ScopesArguments, CompletableFuture<ScopesResponse>>,
        val variables: Pair<VariablesArguments, CompletableFuture<VariablesResponse>>,
        val evaluate: Pair<EvaluateArguments, CompletableFuture<EvaluateResponse>>,
        val respond: (Boolean) -> Unit,
    )

    private fun rejected() = ResponseErrorException(ResponseError(-32602, "synthetic inspection rejection", null))

    private fun activeDescendants(job: Job): Set<Job> = job.children.flatMap { child ->
        activeDescendants(child).asSequence() + if (child.isActive) sequenceOf(child) else emptySequence()
    }.toSet()

    private fun scenario(timeouts: FerretDapTimeouts = FerretDapTimeouts(3_000, 2_000, 100), block: suspend DapTestLaunch.() -> Unit) = runBlocking {
        withTimeout(12_000) {
            val launch = DapTestLaunch(timeouts)
            try { launch.block() } finally { launch.close() }
        }
    }
}
