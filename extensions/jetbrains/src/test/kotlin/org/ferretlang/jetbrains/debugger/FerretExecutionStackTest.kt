package org.ferretlang.jetbrains.debugger

import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.eclipse.lsp4j.debug.StackFrame
import org.eclipse.lsp4j.debug.StackTraceResponse
import java.util.concurrent.CompletableFuture

class FerretExecutionStackTest : BasePlatformTestCase() {
    fun testPagingStartsAtRequestedIndexAndRetainsFrameIdentity() = scenario {
        start()
        session.launchCompleted.await()
        adapter.stop("step")
        val stop = listener.stops.receive()
        val stack = FerretExecutionStack(session, stop, scope, FerretSourcePositions(root))
        val container = DapTestStackContainer()
        stack.computeStackFrames(10, container)
        val first = adapter.stackRequests.receive()
        assertEquals(10, first.first.startFrame)
        assertEquals(100, first.first.levels)
        first.second.complete(page(10, 100, 112))
        val shown = container.pages.receive()
        assertFalse(shown.second)
        assertEquals((10 until 110).toList(), shown.first.map { (it as FerretStackFrame).frameId })
        val frame = shown.first.first() as FerretStackFrame
        assertSame(stop, frame.stop)
        assertEquals("frame 10", frame.name)
        assertEquals(FerretStackFrame(10, "same frame", stop, null).equalityObject, frame.equalityObject)
        assertFalse(FerretStackFrame(10, "new stop", stop.copy(generation = stop.generation + 1), null).equalityObject == frame.equalityObject)
        assertNull(frame.sourcePosition)
        assertNull(frame.evaluator)
        val last = adapter.stackRequests.receive()
        assertEquals(110, last.first.startFrame)
        assertEquals(100, last.first.levels)
        last.second.complete(page(110, 2, 112))
        val end = container.pages.receive()
        assertTrue(end.second)
        assertEquals(listOf(110, 111), end.first.map { (it as FerretStackFrame).frameId })
        assertTrue(container.errors.tryReceive().isFailure)
    }

    fun testNewStopAndObsoleteContainerRejectPendingPresentation() = scenario {
        start()
        session.launchCompleted.await()
        adapter.stop()
        val stop = listener.stops.receive()
        val stack = FerretExecutionStack(session, stop, scope, FerretSourcePositions(root))
        val container = DapTestStackContainer()
        stack.computeStackFrames(0, container)
        val old = adapter.stackRequests.receive()
        container.obsolete = true
        adapter.stop("pause")
        val next = listener.stops.receive()
        old.second.complete(page(0, 1, 1))
        val barrier = scope.async { session.stackTrace(next, 0, 1) }
        adapter.stackRequests.receive().second.complete(page(0, 1, 1))
        barrier.await()
        assertTrue(container.pages.tryReceive().isFailure)
        assertNull(stack.topFrame)
    }

    private fun scenario(block: suspend DapTestLaunch.() -> Unit) {
        val task = CompletableFuture.runAsync {
            runBlocking {
                withTimeout(8_000) {
                    val launch = DapTestLaunch()
                    try { launch.block() } finally { launch.close() }
                }
            }
        }
        PlatformTestUtil.waitWithEventsDispatching("Stack test did not finish", { task.isDone }, 10)
        task.get()
    }

    private fun page(first: Int, count: Int, total: Int) = StackTraceResponse().apply {
        stackFrames = (first until first + count).map { index ->
            StackFrame().apply { id = index; name = "frame $index"; line = 1; column = 1 }
        }.toTypedArray()
        totalFrames = total
    }
}
