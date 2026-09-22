package org.ferretlang.jetbrains.debugger

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.future.await
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.eclipse.lsp4j.debug.*
import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import org.eclipse.lsp4j.jsonrpc.messages.ResponseError
import org.eclipse.lsp4j.jsonrpc.messages.ResponseErrorCode
import org.junit.Assert.*
import org.junit.Test

class FerretDapSessionTest {
    @Test
    fun handshakeWaitsForTheLatestInitialReplacementWithoutWaitingForLaunch() = scenario {
        listener.initialize = { session.replaceBreakpoints(batch(1, 2)) }
        start()
        val first = adapter.breakpointRequests.receive()
        assertEquals(listOf("initialize", "launch", "setBreakpoints"), adapter.history.toList())
        assertFalse(adapter.launchResponse.isDone)
        val preferences = adapter.initialized.await()
        assertTrue(preferences.linesStartAt1)
        assertTrue(preferences.columnsStartAt1)
        assertEquals("path", preferences.pathFormat)
        session.replaceBreakpoints(batch(2, 3))
        val second = adapter.breakpointRequests.receive()
        first.second.complete(response(11, 2))
        assertFalse(adapter.launchResponse.isDone)
        second.second.complete(response(12, 4, "Bound to next executable line"))
        session.launchCompleted.await()
        val shown = listener.replacements.receive()
        assertEquals(2L, shown.first.revision)
        assertEquals(4, shown.second.single().line)
        assertTrue(listener.replacements.tryReceive().isFailure)
        assertEquals("configurationDone", adapter.history.last())
        assertEquals(false, adapter.launched.await()["stopOnEntry"])
    }

    @Test
    fun failedInitialReplacementNeverSendsConfigurationDone() = scenario {
        listener.initialize = { session.replaceBreakpoints(batch(1, 2)) }
        start()
        adapter.breakpointRequests.receive().second.completeExceptionally(rejected())
        assertEquals(1, session.completion.await())
        assertNotNull(listener.replacements.receive().third)
        assertFalse(adapter.history.contains("configurationDone"))
        assertEquals(listOf("terminate", "disconnect"), adapter.history.takeLast(2))
        assertFalse(process.isAlive)
    }

    @Test
    fun ordinaryUnverifiedBreakpointsAllowLaunch() = scenario {
        listener.initialize = { session.replaceBreakpoints(batch(1, 200)) }
        start()
        adapter.breakpointRequests.receive().second.complete(SetBreakpointsResponse().apply {
            breakpoints = arrayOf(Breakpoint().apply { isVerified = false; message = "No executable location" })
        })
        session.launchCompleted.await()
        assertFalse(listener.replacements.receive().second.single().isVerified)
        assertTrue(session.ready)
    }

    @Test
    fun liveReplacementIsImmediateAndOldRepliesCannotReplacePresentation() = scenario {
        start()
        session.launchCompleted.await()
        session.replaceBreakpoints(batch(1, 2))
        val added = adapter.breakpointRequests.receive()
        session.replaceBreakpoints(batch(2, 3))
        val moved = adapter.breakpointRequests.receive()
        moved.second.complete(response(22, 3))
        assertEquals(2L, listener.replacements.receive().first.revision)
        added.second.complete(response(21, 2))
        session.replaceBreakpoints(batch(3))
        val removed = adapter.breakpointRequests.receive()
        assertTrue(removed.first.breakpoints.isEmpty())
        removed.second.complete(SetBreakpointsResponse().apply { breakpoints = emptyArray() })
        assertEquals(3L, listener.replacements.receive().first.revision)
        adapter.stop(ids = arrayOf(21))
        val stop = listener.stops.receive()
        assertEquals(listOf(2L), stop.hitKeys)
        assertTrue(session.isCurrentStop(stop))
        assertFalse(adapter.history.contains("pause"))
        assertFalse(adapter.history.contains("continue"))
        assertTrue(listener.replacements.tryReceive().isFailure)
    }

    @Test
    fun liveReplacementFailureEndsOnlyThatSession() = scenario {
        start()
        session.launchCompleted.await()
        session.replaceBreakpoints(batch(1, 2))
        adapter.breakpointRequests.receive().second.completeExceptionally(rejected())
        assertEquals(1, session.completion.await())
        assertNotNull(listener.replacements.receive().third)
    }

    @Test
    fun commandsWaitForConfirmedStopsAndFastStopsWinOverLateResponses() = scenario {
        start()
        session.launchCompleted.await()
        session.command(FerretDapCommand.PAUSE)
        val pause = adapter.controlRequests.receive()
        assertEquals("pause", pause.first)
        pause.second.complete(null)
        assertTrue(listener.stops.tryReceive().isFailure)
        adapter.stop("pause")
        var stop = listener.stops.receive()
        val commands = listOf(
            FerretDapCommand.CONTINUE to "continue", FerretDapCommand.NEXT to "next",
            FerretDapCommand.STEP_IN to "stepIn", FerretDapCommand.STEP_OUT to "stepOut",
        )
        for ((command, expected) in commands) {
            session.command(command, stop)
            val pending = adapter.controlRequests.receive()
            assertEquals(expected, pending.first)
            assertFalse(session.isCurrentStop(stop))
            assertFalse(session.canPerformCommands())
            adapter.stop("step")
            val next = listener.stops.receive()
            assertTrue(next.generation > stop.generation)
            assertTrue(session.canPerformCommands())
            pending.second.complete(null)
            // A subsequent ordered request/response proves the late command callback has been processed.
            val stack = scope.async { session.stackTrace(next, 0, 1) }
            adapter.stackRequests.receive().second.complete(StackTraceResponse().apply { stackFrames = emptyArray(); totalFrames = 0 })
            stack.await()
            assertTrue(session.isCurrentStop(next))
            assertTrue(listener.resumed.tryReceive().isFailure)
            stop = next
        }
    }

    @Test
    fun resumeWithoutContinuedInvalidatesPendingInspection() = scenario {
        start()
        session.launchCompleted.await()
        adapter.stop()
        val stop = listener.stops.receive()
        val stack = scope.async { session.stackTrace(stop, 100, 100) }
        val pendingStack = adapter.stackRequests.receive()
        assertEquals(100, pendingStack.first.startFrame)
        assertEquals(100, pendingStack.first.levels)
        session.command(FerretDapCommand.CONTINUE, stop)
        adapter.controlRequests.receive().second.complete(null)
        assertEquals(stop.generation, listener.resumed.receive())
        assertFalse(session.isCurrentStop(stop))
        pendingStack.second.complete(StackTraceResponse().apply { stackFrames = emptyArray() })
        assertNull(stack.await())
    }

    @Test
    fun rejectedCommandRestoresTheConfirmedStop() = scenario {
        start()
        session.launchCompleted.await()
        adapter.stop()
        val stop = listener.stops.receive()
        session.command(FerretDapCommand.NEXT, stop)
        adapter.controlRequests.receive().second.completeExceptionally(rejected())
        assertSame(stop, listener.stops.receive())
        assertTrue(session.isCurrentStop(stop))
        assertTrue(listener.errors.receive().contains("rejected"))
    }

    @Test
    fun targetCompletionPreservesOutputAndExitCodeAndDisconnectsWithoutTerminate() = scenario {
        start()
        session.launchCompleted.await()
        adapter.client.output(OutputEventArguments().apply { category = "stdout"; output = "partial" })
        adapter.client.output(OutputEventArguments().apply { category = "stderr"; output = "error\n" })
        adapter.client.output(OutputEventArguments().apply { category = "console"; output = "message" })
        adapter.client.exited(ExitedEventArguments().apply { exitCode = 17 })
        adapter.client.terminated(TerminatedEventArguments())
        assertEquals(17, session.completion.await())
        assertEquals("partial" to false, listener.output.receive())
        assertEquals("error\n" to true, listener.output.receive())
        assertEquals("message" to false, listener.output.receive())
        assertTrue(listener.output.tryReceive().isFailure)
        assertFalse(adapter.history.contains("terminate"))
        assertTrue(adapter.history.contains("disconnect"))
        assertFalse(process.isAlive)
    }

    @Test
    fun stopDuringInitializationAndRepeatedStopCleanUpOnce() = scenario {
        val entered = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        listener.initialize = { entered.complete(Unit); release.await() }
        start()
        entered.await()
        session.stop()
        session.stop()
        assertEquals(130, session.completion.await())
        assertFalse(adapter.history.contains("configurationDone"))
        assertEquals(1, adapter.history.count { it == "terminate" })
        assertEquals(1, adapter.history.count { it == "disconnect" })
        assertFalse(process.isAlive)
    }

    @Test
    fun malformedTransportFailsTheSession() = scenario {
        start()
        session.launchCompleted.await()
        process.malformed()
        assertEquals(1, session.completion.await())
        assertTrue(listener.errors.receive().contains("connection failed"))
        assertFalse(process.isAlive)
    }

    @Test
    fun brokenStreamFailsTheSession() = scenario {
        start()
        session.launchCompleted.await()
        process.close()
        assertEquals(1, session.completion.await())
        assertFalse(process.isAlive)
    }

    @Test
    fun stopBeforeStartupDoesNotLaunchTheAdapter() = scenario {
        session.stop()
        start()
        assertEquals(130, session.completion.await())
        assertTrue(adapter.history.isEmpty())
    }

    @Test
    fun projectCancellationCleansUpWithoutAffectingAnotherLaunch() = runBlocking {
        withTimeout(8_000) {
            val first = DapTestLaunch()
            val second = DapTestLaunch()
            try {
                val job = first.start()
                second.start()
                first.session.launchCompleted.await()
                second.session.launchCompleted.await()
                job.cancel()
                assertEquals(130, first.session.completion.await())
                assertFalse(first.process.isAlive)
                assertTrue(second.process.isAlive)
                second.adapter.stop("pause")
                assertTrue(second.session.isCurrentStop(second.listener.stops.receive()))
            } finally {
                first.close()
                second.close()
            }
        }
    }

    private fun scenario(block: suspend DapTestLaunch.() -> Unit) = runBlocking {
        withTimeout(8_000) {
            val launch = DapTestLaunch()
            try {
                launch.block()
            } catch (error: Throwable) {
                throw AssertionError("DAP history: ${launch.adapter.history}; error: ${launch.listener.errors.tryReceive().getOrNull()}", error)
            } finally { launch.close() }
        }
    }

    @Test
    fun unresponsiveTerminationFallsBackToDestroyAndForceAndAwaitsExit() = runBlocking {
        withTimeout(5_000) {
            val launch = DapTestLaunch(requiresForce = true)
            try {
                launch.adapter.autoTerminate = false
                launch.start()
                launch.session.launchCompleted.await()
                launch.session.stop()
                assertEquals(130, launch.session.completion.await())
                assertEquals(1, launch.process.destroyCalls.get())
                assertEquals(1, launch.process.forceCalls.get())
                assertFalse(launch.process.isAlive)
            } finally { launch.close() }
        }
    }

    @Test
    fun initialRequestTimeoutFailsWithoutConfigurationDone() = runBlocking {
        withTimeout(5_000) {
            val launch = DapTestLaunch(FerretDapTimeouts(3_000, 100, 100))
            try {
                launch.listener.initialize = { launch.session.replaceBreakpoints(launch.batch(1, 2)) }
                launch.start()
                launch.adapter.breakpointRequests.receive()
                assertEquals(1, launch.session.completion.await())
                assertTrue(launch.listener.replacements.receive().third.orEmpty().contains("timed out"))
                assertFalse(launch.adapter.history.contains("configurationDone"))
            } finally { launch.close() }
        }
    }

    @Test
    fun stopWithInitializeResponsePendingClosesThePartiallyStartedSession() = scenario {
        adapter.autoInitialize = false
        start()
        adapter.initialized.await()
        session.stop()
        assertEquals(130, session.completion.await())
        assertFalse(adapter.history.contains("launch"))
        assertFalse(adapter.history.contains("terminate"))
        assertTrue(adapter.history.contains("disconnect"))
        assertFalse(process.isAlive)
    }

    @Test
    fun stopWithInitialReplacementPendingNeverConfiguresTheLaunch() = scenario {
        listener.initialize = { session.replaceBreakpoints(batch(1, 2)) }
        start()
        val pending = adapter.breakpointRequests.receive()
        session.stop()
        assertEquals(130, session.completion.await())
        pending.second.complete(response(1, 2))
        assertFalse(adapter.history.contains("configurationDone"))
        assertFalse(process.isAlive)
    }

    @Test
    fun cancellationRacingProcessCreationStillAcquiresAndCleansTheChild() = runBlocking {
        withTimeout(5_000) {
            val entered = CompletableDeferred<Unit>()
            val release = java.util.concurrent.CountDownLatch(1)
            val launch = DapTestLaunch(beforeProcess = { entered.complete(Unit); release.await() })
            try {
                val job = launch.start()
                entered.await()
                job.cancel()
                release.countDown()
                assertEquals(130, launch.session.completion.await())
                assertFalse(launch.process.isAlive)
            } finally { release.countDown(); launch.close() }
        }
    }

    @Test
    fun stopWithConfigurationDonePendingClosesTheActiveLaunch() = scenario {
        adapter.autoConfigure = false
        start()
        adapter.configurationRequested.await()
        assertFalse(session.launchCompleted.isCompleted)
        session.stop()
        assertEquals(130, session.completion.await())
        assertEquals(listOf("terminate", "disconnect"), adapter.history.takeLast(2))
        assertFalse(process.isAlive)
    }

    @Test
    fun initializeFailureDisconnectsWithoutLaunchingOrTerminatingATarget() = scenario {
        adapter.autoInitialize = false
        start()
        adapter.initialized.await()
        adapter.initializeResponse.completeExceptionally(rejected())
        assertEquals(1, session.completion.await())
        assertEquals(listOf("initialize", "disconnect"), adapter.history.toList())
        assertFalse(process.isAlive)
    }

    private fun DapTestLaunch.batch(revision: Long, vararg lines: Int): FerretDapBreakpoints =
        FerretDapBreakpoints(source, revision, lines.map { FerretDapBreakpoint(it.toLong(), it) })

    private fun response(id: Int, line: Int, message: String? = null): SetBreakpointsResponse = SetBreakpointsResponse().apply {
        breakpoints = arrayOf(Breakpoint().apply { this.id = id; isVerified = true; this.line = line; this.message = message })
    }

    private fun rejected(): ResponseErrorException = ResponseErrorException(
        ResponseError(ResponseErrorCode.RequestFailed, "rejected", null),
    )
}
