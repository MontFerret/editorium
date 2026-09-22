package org.ferretlang.jetbrains.integration

import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.ui.RunContentManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.HeavyPlatformTestCase
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.replaceService
import com.intellij.xdebugger.*
import com.intellij.xdebugger.breakpoints.XBreakpointProperties
import com.intellij.xdebugger.breakpoints.XLineBreakpoint
import com.intellij.xdebugger.frame.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.future.future
import kotlinx.coroutines.selects.select
import org.ferretlang.jetbrains.debugger.*
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.run.FerretParameterBindingsJson
import org.ferretlang.jetbrains.run.FerretRunConfiguration
import org.ferretlang.jetbrains.run.FerretRunConfigurationType
import org.junit.experimental.categories.Category
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture

@Category(FerretdIntegrationTest::class)
class FerretNativeInspectionIntegrationTest : HeavyPlatformTestCase() {
    private lateinit var lifetime: CoroutineScope
    private val launches = mutableListOf<XSessionStartedResult>()
    private val breakpoints = mutableListOf<XLineBreakpoint<XBreakpointProperties<*>>>()

    override fun setUp() {
        super.setUp()
        lifetime = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        project.replaceService(FerretDebugLauncher::class.java,
            FerretDebugLauncher.testing(lifetime, Path.of(requireNotNull(System.getenv("FERRETD_TEST_PATH")))), testRootDisposable)
    }

    override fun tearDown() {
        try {
            launches.forEach { it.session.debugProcess.processHandler.destroyProcess() }
            lifetime.cancel()
            PlatformTestUtil.waitWithEventsDispatching("Inspection sessions did not terminate", {
                launches.all { it.session.debugProcess.processHandler.isProcessTerminated }
            }, 20)
            val contents = RunContentManager.getInstance(project)
            launches.forEach { launched ->
                contents.allDescriptors.filter { it.processHandler === launched.session.debugProcess.processHandler }.forEach {
                    contents.removeRunContent(DefaultDebugExecutor.getDebugExecutorInstance(), it)
                }
                launched.runContentDescriptor?.let(Disposer::dispose)
            }
            WriteCommandAction.runWriteCommandAction(project) {
                breakpoints.forEach { XDebuggerManager.getInstance(project).breakpointManager.removeBreakpoint(it) }
            }
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
        } finally { super.tearDown() }
    }

    fun testSelectedFrameEvaluationAndVariablesRefreshAcrossStepsAndStops() {
        val session = launch("frames", 2)
        val stack = requireNotNull(session.suspendContext?.activeExecutionStack)
        val frames = frames(stack)
        assertEquals(listOf("inner", "outer", "<main>"), frames.map { (it as FerretStackFrame).name })
        assertEquals("5", evaluate(session, "local").value)
        val oldEvaluator = requireNotNull(session.currentStackFrame?.evaluator)
        session.setCurrentStackFrame(stack, frames[1], false)
        assertEquals("2", evaluate(session, "p").value)
        val callerScopes = children(frames[1]).topGroups
        assertEquals(listOf("Locals", "Parameters"), callerScopes.map { it.name })
        val locals = children(callerScopes[0])
        assertEquals(setOf("caller", "p"), (0 until locals.size()).map { locals.getName(it) }.toSet())
        assertEquals("2", present(locals.getValue((0 until locals.size()).single { locals.getName(it) == "p" })).value)
        session.setCurrentStackFrame(stack, frames[2], false)
        val structured = evaluateValue(session, "box.items")
        assertTrue(present(structured).expandable)
        val nested = children(structured)
        assertEquals(listOf("1", "2"), (0 until nested.size()).map { present(nested.getValue(it)).value })
        assertNull(nested.getValue(0).evaluationExpression)
        session.setCurrentStackFrame(stack, frames[0], true)
        val before = session.suspendContext
        session.stepOut()
        awaitStop(session, before)
        assertEquals("outer", (session.currentStackFrame as FerretStackFrame).name)
        assertEquals("2", evaluate(session, "p").value)
        val step = session.suspendContext
        session.resume()
        awaitStop(session, step)
        // Native watches use exactly this newly selected frame evaluator too.
        assertEquals("8", evaluate(session, "local").value)
        val obsolete = DapTestEvaluationCallback()
        oldEvaluator.evaluate("local", obsolete, null)
        val result = await(lifetime.future { obsolete.result.await() })
        assertTrue(result.isFailure)
        assertTrue(obsolete.invalidExpression)
        session.resume()
        PlatformTestUtil.waitWithEventsDispatching("Debug did not terminate", { session.debugProcess.processHandler.isProcessTerminated }, 15)
        assertEquals(0, session.debugProcess.processHandler.exitCode)
    }

    fun testConcurrentNativeSessionsKeepValuesIndependentAndCanRelaunch() {
        val first = launch("first", 2)
        val second = launch("second", 6)
        assertEquals("5", evaluate(first, "local").value)
        assertEquals("9", evaluate(second, "local").value)
        val values = children(requireNotNull(second.currentStackFrame)).topGroups
        assertTrue(children(values.first()).size() > 0)
        first.stop()
        PlatformTestUtil.waitWithEventsDispatching("First Debug did not terminate", { first.debugProcess.processHandler.isProcessTerminated }, 15)
        assertEquals("9", evaluate(second, "local").value)
        val fresh = launch("fresh", 10)
        assertEquals("13", evaluate(fresh, "local").value)
        lifetime.cancel()
        PlatformTestUtil.waitWithEventsDispatching("Project lifetime did not clean every session", {
            listOf(second, fresh).all { it.debugProcess.processHandler.isProcessTerminated }
        }, 15)
    }

    private fun launch(name: String, input: Int): XDebugSession {
        val root = Path.of(requireNotNull(project.basePath))
        Files.createDirectories(root)
        val path = Files.writeString(root.resolve("$name.fql"), SOURCE)
        val file = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path))
        val manager = XDebuggerManager.getInstance(project)
        val type = XDebuggerUtil.getInstance().findBreakpointType(FerretBreakpointType::class.java)
        WriteCommandAction.runWriteCommandAction(project) {
            breakpoints.add(manager.breakpointManager.addLineBreakpoint(type, file.url, SOURCE.lines().indexOfFirst { it.trim() == "RETURN local" }, null))
        }
        val launch = FerretLaunchInput(path.toString(), "", root.toString(), FerretParameterBindingsJson.parse("{\"input\":$input}"))
        val configuration = (FerretRunConfigurationType.getInstance().configurationFactories.single()
            .createTemplateConfiguration(project) as FerretRunConfiguration).apply { sourcePath = path.toString() }
        val environment = ExecutionEnvironmentBuilder.create(DefaultDebugExecutor.getDebugExecutorInstance(), configuration).build()
        val result = manager.newSessionBuilder(object : XDebugProcessStarter() {
            override fun start(session: XDebugSession): XDebugProcess = FerretDebugProcess(session, launch)
        }).environment(environment).sessionName(name).showTab(false).startSession().also(launches::add)
        // This fixture invokes the builder directly, outside ExecutionManager's process-start notification.
        result.session.debugProcess.processHandler.startNotify()
        awaitStop(result.session, null)
        return result.session
    }

    private fun awaitStop(session: XDebugSession, previous: XSuspendContext?) {
        PlatformTestUtil.waitWithEventsDispatching("Debug did not reach a new stop", {
            session.isSuspended && session.suspendContext !== previous && session.currentStackFrame != null
        }, 15)
    }

    private fun frames(stack: XExecutionStack): List<XStackFrame> {
        val node = DapTestStackContainer()
        stack.computeStackFrames(0, node)
        return await(lifetime.future { node.pages.receive() }).also { assertTrue(it.second) }.first
    }

    private fun children(container: XValueContainer): XValueChildrenList {
        val node = DapTestCompositeNode()
        container.computeChildren(node)
        return await(lifetime.future {
            select {
                node.children.onReceive { it }
                node.errors.onReceive { error(it) }
            }
        })
    }

    private fun evaluateValue(session: XDebugSession, expression: String): XValue {
        val callback = DapTestEvaluationCallback()
        requireNotNull(session.currentStackFrame?.evaluator).evaluate(expression, callback, null)
        return await(lifetime.future { callback.result.await() }).getOrThrow()
    }

    private fun evaluate(session: XDebugSession, expression: String) = present(evaluateValue(session, expression))

    private fun present(value: XValue): DapTestValueNode.Presentation {
        val node = DapTestValueNode()
        value.computePresentation(node, XValuePlace.TREE)
        return await(lifetime.future { node.presentation.await() })
    }

    private fun <T> await(result: CompletableFuture<T>): T {
        PlatformTestUtil.waitWithEventsDispatching("Inspection callback did not finish", { result.isDone }, 15)
        return result.get()
    }

    companion object {
        private val SOURCE = """
            LET box = {items: [1,2]}
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
            RETURN second
        """.trimIndent()
    }
}
