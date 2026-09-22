package org.ferretlang.jetbrains.debugger

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.EDT
import com.intellij.openapi.application.WriteAction
import com.intellij.openapi.project.ex.ProjectManagerEx
import com.intellij.openapi.util.Disposer
import com.intellij.ide.impl.OpenProjectTask
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.xdebugger.XDebuggerUtil
import com.intellij.xdebugger.evaluation.EvaluationMode
import com.intellij.xdebugger.frame.XValue
import com.intellij.xdebugger.frame.XValuePlace
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.eclipse.lsp4j.debug.*
import org.eclipse.lsp4j.jsonrpc.ResponseErrorException
import org.eclipse.lsp4j.jsonrpc.messages.ResponseError
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.nio.file.Files

class FerretInspectionPlatformTest : BasePlatformTestCase() {
    fun testScopesAndNestedValuesAreLazyAndOnlyBindingsHaveEvaluationExpressions() = scenario {
        val context = context()
        val frame = FerretStackFrame(42, "caller", context, null)
        val node = DapTestCompositeNode()
        assertFalse(adapter.history.contains("scopes"))
        withContext(Dispatchers.EDT) { frame.computeChildren(node) }
        val scopes = adapter.scopeRequests.receive()
        assertEquals(42, scopes.first.frameId)
        scopes.second.complete(ScopesResponse().apply {
            this.scopes = arrayOf(scope("Locals", 7), scope("Parameters", 8))
        })
        val groups = node.children.receive().topGroups
        assertEquals(listOf("Locals", "Parameters"), groups.map { it.name })
        assertTrue(groups.none { it.isAutoExpand })
        assertTrue(groups.all { it.isRestoreExpansion })
        assertFalse(adapter.history.contains("variables"))
        withContext(Dispatchers.EDT) { groups[0].computeChildren(node) }
        val variables = adapter.variableRequests.receive()
        assertEquals(7, variables.first.variablesReference)
        variables.second.complete(VariablesResponse().apply {
            this.variables = arrayOf(variable("box", "Object", "{\"child\": [1]}", 9, "box"))
        })
        val values = node.children.receive()
        assertEquals("box", values.getName(0))
        val box = values.getValue(0)
        assertEquals("box", box.evaluationExpression)
        assertEquals(DapTestValueNode.Presentation("Object", "{\"child\": [1]}", true), present(box))
        assertEquals(1, adapter.history.count { it == "variables" })
        withContext(Dispatchers.EDT) { box.computeChildren(node) }
        adapter.variableRequests.receive().also {
            assertEquals(9, it.first.variablesReference)
            it.second.complete(VariablesResponse().apply { this.variables = arrayOf(variable("child", "Array", "[1]", 10, "child")) })
        }
        val child = node.children.receive().getValue(0)
        assertNull(child.evaluationExpression)
        withContext(Dispatchers.EDT) { child.computeChildren(node) }
        adapter.variableRequests.receive().also {
            assertEquals(10, it.first.variablesReference)
            it.second.complete(VariablesResponse().apply { this.variables = arrayOf(variable("0", "Int", "1", 0, "0")) })
        }
        assertNull(node.children.receive().getValue(0).evaluationExpression)
        withContext(Dispatchers.EDT) { groups[1].computeChildren(node) }
        adapter.variableRequests.receive().also {
            assertEquals(8, it.first.variablesReference)
            it.second.complete(VariablesResponse().apply { this.variables = arrayOf(variable("@input", "String", "\"text\"", 0, "@input")) })
        }
        assertEquals("@input", node.children.receive().getValue(0).evaluationExpression)
    }

    fun testCanonicalLeafPresentationsNeverRequestChildrenIncludingLargeSummaries() = scenario {
        val context = context()
        for ((type, display) in listOf(
            "None" to "NONE", "Boolean" to "true", "Int" to "42", "Float" to "1.25",
            "String" to "\"hello\"", "String" to "\"\"", "Array" to "Array(9)", "Object" to "{}", "Host" to "opaque", null to "",
        )) {
            for (reference in listOf(0, -1)) {
                val value = FerretValue(context, display, type, reference)
                assertEquals(DapTestValueNode.Presentation(type, display, false), present(value))
                val node = DapTestCompositeNode()
                withContext(Dispatchers.EDT) { value.computeChildren(node) }
                assertEquals(0, node.children.receive().size())
            }
        }
        assertFalse(adapter.history.contains("variables"))
        val obsolete = DapTestValueNode().apply { this.obsolete = true }
        withContext(Dispatchers.EDT) { FerretValue(context, "secret", "String", 0).computePresentation(obsolete, XValuePlace.TREE) }
        assertFalse(obsolete.presentation.isCompleted)
    }

    fun testEvaluationUsesSelectedFrameUnchangedTextAndSharedExpandableValueModel() = scenario {
        val context = context()
        for (frameId in listOf(1, 2, 3)) {
            val evaluator = requireNotNull(FerretStackFrame(frameId, "frame", context, null).evaluator)
            assertFalse(evaluator.isCodeFragmentEvaluationSupported)
            assertEquals(EvaluationMode.EXPRESSION, evaluator.getEvaluationMode("x\n + 1", 0, 6, null))
            val callback = DapTestEvaluationCallback()
            val expression = "  box.nested[0]\n"
            withContext(Dispatchers.EDT) { evaluator.evaluate(expression, callback, null) }
            adapter.evaluateRequests.receive().also {
                assertEquals(frameId, it.first.frameId)
                assertEquals(expression, it.first.expression)
                assertNull(it.first.context)
                it.second.complete(EvaluateResponse().apply { result = "[1]"; type = "Array"; variablesReference = 50 + frameId })
            }
            val value = callback.result.await().getOrThrow()
            assertTrue(value is FerretValue)
            assertEquals(expression, value.evaluationExpression)
            assertEquals(DapTestValueNode.Presentation("Array", "[1]", true), present(value))
            val node = DapTestCompositeNode()
            withContext(Dispatchers.EDT) { value.computeChildren(node) }
            adapter.variableRequests.receive().also {
                assertEquals(50 + frameId, it.first.variablesReference)
                it.second.complete(VariablesResponse().apply { variables = emptyArray() })
            }
            node.children.receive()
            val fragment = DapTestEvaluationCallback()
            withContext(Dispatchers.Default) {
                evaluator.evaluate(XDebuggerUtil.getInstance().createExpression("RETURN 1", null, null, EvaluationMode.CODE_FRAGMENT), fragment, null)
            }
            assertTrue(fragment.result.await().exceptionOrNull()?.message.orEmpty().contains("expressions only"))
        }
        assertEquals(3, adapter.history.count { it == "evaluate" })
    }

    fun testExpressionAndNodeErrorsAreConciseAndNonfatal() = scenario {
        val context = context()
        val frame = FerretStackFrame(2, "caller", context, null)
        val callback = DapTestEvaluationCallback()
        withContext(Dispatchers.EDT) { frame.evaluator.evaluate("missing", callback, null) }
        adapter.evaluateRequests.receive().second.completeExceptionally(rejected())
        assertEquals("unknown binding", callback.result.await().exceptionOrNull()?.message)
        assertTrue(callback.invalidExpression)
        val node = DapTestCompositeNode()
        withContext(Dispatchers.EDT) { frame.computeChildren(node) }
        adapter.scopeRequests.receive().second.completeExceptionally(rejected())
        assertEquals("unknown binding", node.errors.receive())
        withContext(Dispatchers.EDT) { FerretValue(context, "{}", "Object", 42).computeChildren(node) }
        adapter.variableRequests.receive().second.completeExceptionally(rejected())
        assertEquals("unknown binding", node.errors.receive())
        assertTrue(session.isCurrentStop(context.stop))
        assertTrue(listener.errors.tryReceive().isFailure)
    }

    fun testResumeCompletesCallbacksAndOldValuesCannotRequestNewHandles() = scenario {
        val context = context()
        val frame = FerretStackFrame(2, "caller", context, null)
        val node = DapTestCompositeNode()
        val callback = DapTestEvaluationCallback()
        withContext(Dispatchers.EDT) { frame.computeChildren(node); frame.evaluator.evaluate("x", callback, null) }
        val scopes = adapter.scopeRequests.receive()
        val evaluation = adapter.evaluateRequests.receive()
        session.command(FerretDapCommand.NEXT, context.stop)
        adapter.controlRequests.receive().second.complete(null)
        assertEquals(0, node.children.receive().size())
        assertTrue(callback.result.await().isFailure)
        assertTrue(callback.invalidExpression)
        adapter.stop("step")
        listener.stops.receive()
        scopes.second.completeExceptionally(rejected())
        evaluation.second.complete(EvaluateResponse().apply { result = "old value" })
        withContext(Dispatchers.EDT) { frame.computeChildren(node) }
        assertEquals(0, node.children.receive().size())
        assertEquals(1, callback.calls.get())
        assertEquals(1, adapter.history.count { it == "scopes" })
        assertTrue(node.errors.tryReceive().isFailure)
    }

    fun testAResponseQueuedForTheEdtCannotPublishAfterTheStopChanges() = scenario {
        val context = context()
        val callback = DapTestEvaluationCallback()
        withContext(Dispatchers.EDT) { FerretDebuggerEvaluator(context, 1).evaluate("x", callback, null) }
        val response = adapter.evaluateRequests.receive()
        val entered = CompletableDeferred<Unit>()
        val release = CountDownLatch(1)
        ApplicationManager.getApplication().invokeLater {
            entered.complete(Unit)
            check(release.await(5, TimeUnit.SECONDS))
        }
        try {
            entered.await()
            response.second.complete(EvaluateResponse().apply { result = "old value" })
            // Ordered wire barrier: the result was accepted before the new stop, while the EDT cannot present it.
            val barrier = scope.async { session.stackTrace(context.stop, 0, 1) }
            adapter.stackRequests.receive().second.complete(StackTraceResponse().apply { stackFrames = emptyArray() })
            barrier.await()
            adapter.stop("step")
            listener.stops.receive()
        } finally { release.countDown() }
        assertTrue(callback.result.await().isFailure)
        assertEquals(1, callback.calls.get())
    }

    fun testCancelledLaunchScopeCompletesPendingAndNewEvaluatorCallbacks() = scenario {
        val context = context()
        val evaluator = FerretDebuggerEvaluator(context, 1)
        val pending = DapTestEvaluationCallback()
        withContext(Dispatchers.EDT) { evaluator.evaluate("x", pending, null) }
        adapter.evaluateRequests.receive()
        scope.coroutineContext[kotlinx.coroutines.Job]!!.cancel()
        assertTrue(pending.result.await().isFailure)
        session.completion.await()
        val after = DapTestEvaluationCallback()
        withContext(Dispatchers.EDT) { evaluator.evaluate("x", after, null) }
        assertTrue(after.result.await().isFailure)
        assertEquals(1, adapter.history.count { it == "evaluate" })
    }

    fun testDisposingOneProjectWithPendingInspectionLeavesTheOtherProjectUsable() = scenario {
        val surviving = context()
        val other = DapTestLaunch()
        val directory = Files.createTempDirectory("ferret-other-project-")
        val otherProject = withContext(Dispatchers.EDT) {
            requireNotNull(ProjectManagerEx.getInstanceEx().newProject(directory, OpenProjectTask(isNewProject = true)))
        }
        try {
            Disposer.register(otherProject, com.intellij.openapi.Disposable { other.scope.cancel() })
            other.start()
            other.session.launchCompleted.await()
            other.adapter.stop()
            val stopped = other.listener.stops.receive()
            val inspection = FerretInspectionContext(other.session, stopped, other.scope, otherProject)
            val node = DapTestCompositeNode()
            val callback = DapTestEvaluationCallback()
            withContext(Dispatchers.EDT) {
                FerretValue(inspection, "{}", "Object", 10).computeChildren(node)
                FerretDebuggerEvaluator(inspection, 1).evaluate("x", callback, null)
            }
            other.adapter.variableRequests.receive()
            other.adapter.evaluateRequests.receive()
            withContext(Dispatchers.EDT) { WriteAction.run<RuntimeException> { Disposer.dispose(otherProject) } }
            assertTrue(callback.result.await().isFailure)
            assertEquals(130, other.session.completion.await())
            assertFalse(other.process.isAlive)
            assertTrue(node.children.tryReceive().isFailure)
            assertTrue(node.errors.tryReceive().isFailure)
            val survivor = DapTestEvaluationCallback()
            withContext(Dispatchers.EDT) { FerretDebuggerEvaluator(surviving, 1).evaluate("x", survivor, null) }
            adapter.evaluateRequests.receive().second.complete(EvaluateResponse().apply { result = "42"; type = "Int" })
            assertEquals("42", present(survivor.result.await().getOrThrow()).value)
        } finally {
            if (!otherProject.isDisposed) withContext(Dispatchers.EDT) { WriteAction.run<RuntimeException> { Disposer.dispose(otherProject) } }
            other.close()
            directory.toFile().deleteRecursively()
        }
    }

    private suspend fun DapTestLaunch.context(): FerretInspectionContext {
        start()
        session.launchCompleted.await()
        adapter.stop()
        return FerretInspectionContext(session, listener.stops.receive(), scope, project)
    }

    private suspend fun present(value: XValue): DapTestValueNode.Presentation {
        val node = DapTestValueNode()
        withContext(Dispatchers.EDT) { value.computePresentation(node, XValuePlace.TREE) }
        return node.presentation.await()
    }

    private fun scope(name: String, reference: Int) = Scope().apply { this.name = name; variablesReference = reference }

    private fun variable(name: String, type: String, display: String, reference: Int, expression: String) = Variable().apply {
        this.name = name; this.type = type; value = display; variablesReference = reference; evaluateName = expression
    }

    private fun rejected() = ResponseErrorException(ResponseError(-32602, "unknown binding", null))

    private fun scenario(block: suspend DapTestLaunch.() -> Unit) {
        val task = CompletableFuture.runAsync {
            runBlocking {
                withTimeout(10_000) {
                    val launch = DapTestLaunch()
                    try { launch.block() } finally { launch.close() }
                }
            }
        }
        PlatformTestUtil.waitWithEventsDispatching("Inspection test did not finish", { task.isDone }, 15)
        task.get()
    }
}
