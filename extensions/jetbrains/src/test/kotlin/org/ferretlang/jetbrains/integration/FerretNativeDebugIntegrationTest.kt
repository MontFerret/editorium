package org.ferretlang.jetbrains.integration

import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ProgramRunner
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.HeavyPlatformTestCase
import com.intellij.testFramework.replaceService
import com.intellij.xdebugger.XDebuggerManager
import com.intellij.xdebugger.XDebuggerUtil
import com.intellij.xdebugger.breakpoints.XBreakpointProperties
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.ferretlang.jetbrains.debugger.FerretBreakpointType
import org.ferretlang.jetbrains.debugger.FerretDebugLauncher
import org.ferretlang.jetbrains.debugger.FerretDebugProcess
import org.ferretlang.jetbrains.run.FerretRunConfiguration
import org.ferretlang.jetbrains.run.FerretRunConfigurationType
import org.junit.experimental.categories.Category
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicReference

@Category(FerretdIntegrationTest::class)
class FerretNativeDebugIntegrationTest : HeavyPlatformTestCase() {
    fun testNativeDisableEnableAndMuteSynchronizeBeforeControlCommands() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        project.replaceService(FerretDebugLauncher::class.java,
            FerretDebugLauncher.testing(scope, Path.of(requireNotNull(System.getenv("FERRETD_TEST_PATH")))), testRootDisposable)
        val path = Path.of(requireNotNull(project.basePath)).resolve("native-live.fql")
        Files.createDirectories(path.parent)
        Files.writeString(path, "RETURN FOR i IN 1..1000000\n LET delay = WAIT(10)\n LET value = i + 1\n RETURN value")
        val file = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path))
        val manager = XDebuggerManager.getInstance(project)
        val type = XDebuggerUtil.getInstance().findBreakpointType(FerretBreakpointType::class.java)
        val breakpoint = WriteCommandAction.writeCommandAction(project).compute<com.intellij.xdebugger.breakpoints.XLineBreakpoint<XBreakpointProperties<*>>, RuntimeException> {
            manager.breakpointManager.addLineBreakpoint(type, file.url, 2, null)
        }
        val configuration = FerretRunConfigurationType.getInstance().configurationFactories.single()
            .createTemplateConfiguration(project) as FerretRunConfiguration
        configuration.sourcePath = path.toString()
        val content = AtomicReference<RunContentDescriptor>()
        val failure = AtomicReference<Throwable>()
        try {
            val environment = ExecutionEnvironmentBuilder.create(DefaultDebugExecutor.getDebugExecutorInstance(), configuration)
                .build(object : ProgramRunner.Callback {
                    override fun processStarted(descriptor: RunContentDescriptor) { content.set(descriptor) }
                    override fun processNotStarted(error: Throwable?) { failure.set(error ?: IllegalStateException("Debug did not start")) }
                })
            environment.runner.execute(environment)
            PlatformTestUtil.waitWithEventsDispatching("Live Debug did not suspend", {
                failure.get() != null || manager.debugSessions.any { it.isSuspended }
            }, 20)
            failure.get()?.let { throw AssertionError("Native Debug failed", it) }
            val session = manager.debugSessions.single { it.debugProcess is FerretDebugProcess }
            for (mute in listOf(false, true)) {
                WriteCommandAction.runWriteCommandAction(project) { breakpoint.isEnabled = mute }
                session.setBreakpointMuted(mute)
                val generation = (session.suspendContext as org.ferretlang.jetbrains.debugger.FerretSuspendContext).stack.stop.generation
                session.resume()
                PlatformTestUtil.waitWithEventsDispatching("Resume was not acknowledged", {
                    !session.isSuspended && (session.debugProcess as FerretDebugProcess).dap.isRunningAfter(generation)
                }, 10)
                session.pause()
                PlatformTestUtil.waitWithEventsDispatching("Pause was not confirmed", { session.isSuspended }, 10)
                assertEquals("pause", (session.suspendContext as org.ferretlang.jetbrains.debugger.FerretSuspendContext).stack.stop.reason)
            }
            session.setBreakpointMuted(false)
            val previous = session.suspendContext
            session.resume()
            PlatformTestUtil.waitWithEventsDispatching("Unmuted breakpoint was not hit", {
                session.isSuspended && session.suspendContext !== previous
            }, 10)
            assertEquals("breakpoint", (session.suspendContext as org.ferretlang.jetbrains.debugger.FerretSuspendContext).stack.stop.reason)
            // Cancellation of the service lifetime models project close while suspended.
            scope.cancel()
            PlatformTestUtil.waitWithEventsDispatching("Project lifetime cancellation did not clean Debug", {
                content.get()?.processHandler?.isProcessTerminated == true
            }, 15)
            assertEquals(130, content.get().processHandler?.exitCode)
        } finally {
            content.get()?.processHandler?.destroyProcess()
            scope.cancel()
            PlatformTestUtil.waitWithEventsDispatching("Native Debug cleanup did not finish", {
                content.get()?.processHandler?.isProcessTerminated != false
            }, 15)
            WriteCommandAction.runWriteCommandAction(project) { manager.breakpointManager.removeBreakpoint(breakpoint) }
        }
    }

    fun testNativeDebugSavesSourceNavigatesAndKeepsCommittedStopAfterRemoval() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val launcher = FerretDebugLauncher.testing(scope, Path.of(requireNotNull(System.getenv("FERRETD_TEST_PATH"))))
        project.replaceService(FerretDebugLauncher::class.java, launcher, testRootDisposable)
        val path = Path.of(requireNotNull(project.basePath)).resolve("native-debug.fql")
        Files.createDirectories(path.parent)
        Files.writeString(path, "RETURN missing\n\nRETURN missing")
        val file = requireNotNull(LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path))
        val documents = FileDocumentManager.getInstance()
        val document = requireNotNull(documents.getDocument(file))
        val manager = XDebuggerManager.getInstance(project)
        val type = XDebuggerUtil.getInstance().findBreakpointType(FerretBreakpointType::class.java)
        val breakpoint = WriteCommandAction.writeCommandAction(project).compute<com.intellij.xdebugger.breakpoints.XLineBreakpoint<XBreakpointProperties<*>>, RuntimeException> {
            manager.breakpointManager.addLineBreakpoint(type, file.url, 1, null)
        }
        val configuration = FerretRunConfigurationType.getInstance().configurationFactories.single()
            .createTemplateConfiguration(project) as FerretRunConfiguration
        configuration.sourcePath = path.toString()
        val content = AtomicReference<RunContentDescriptor>()
        val failure = AtomicReference<Throwable>()
        try {
            WriteCommandAction.runWriteCommandAction(project) { document.setText("LET text = \"😀\"\n\nRETURN text") }
            assertTrue(documents.isDocumentUnsaved(document))
            val environment = ExecutionEnvironmentBuilder.create(DefaultDebugExecutor.getDebugExecutorInstance(), configuration)
                .build(object : ProgramRunner.Callback {
                    override fun processStarted(descriptor: RunContentDescriptor) { content.set(descriptor) }
                    override fun processNotStarted(error: Throwable?) { failure.set(error ?: IllegalStateException("Debug did not start")) }
                })
            environment.runner.execute(environment)
            PlatformTestUtil.waitWithEventsDispatching("Native Debug did not suspend", {
                failure.get() != null || manager.debugSessions.any { it.isSuspended }
            }, 20)
            failure.get()?.let { throw AssertionError("Native Debug failed", it) }
            val session = manager.debugSessions.single { it.debugProcess is FerretDebugProcess }
            assertSame(content.get().processHandler, session.debugProcess.processHandler)
            assertFalse(documents.isDocumentUnsaved(document))
            assertEquals(document.text, Files.readString(path))
            assertEquals(2, session.currentPosition?.line)
            assertEquals(file, session.currentPosition?.file)
            assertEquals(1, breakpoint.line) // Daemon relocation must not move persisted intent.
            assertEquals("Ferret", session.suspendContext?.activeExecutionStack?.displayName)
            assertSame(session.currentStackFrame?.evaluator, session.debugProcess.evaluator)
            assertNotNull(session.currentStackFrame?.evaluator)
            assertNull(session.debugProcess.processHandler.processInput)
            WriteCommandAction.runWriteCommandAction(project) { manager.breakpointManager.removeBreakpoint(breakpoint) }
            assertTrue(session.isSuspended)
            session.resume()
            PlatformTestUtil.waitWithEventsDispatching("Native Debug did not complete", {
                content.get()?.processHandler?.isProcessTerminated == true
            }, 15)
            assertEquals(0, content.get().processHandler?.exitCode)
            val completed = content.get()
            scope.cancel()
            // A project lifetime already cancelled before sessionInitialized must
            // still complete the synthetic process and enter the cleanup boundary.
            val cancelled = ExecutionEnvironmentBuilder.create(DefaultDebugExecutor.getDebugExecutorInstance(), configuration)
                .build(object : ProgramRunner.Callback {
                    override fun processStarted(descriptor: RunContentDescriptor) { content.set(descriptor) }
                    override fun processNotStarted(error: Throwable?) { failure.set(error ?: IllegalStateException("Debug did not start")) }
                })
            cancelled.runner.execute(cancelled)
            PlatformTestUtil.waitWithEventsDispatching("Cancelled Debug startup did not terminate", {
                failure.get() != null || (content.get() !== completed && content.get()?.processHandler?.isProcessTerminated == true)
            }, 15)
            failure.get()?.let { throw AssertionError("Cancelled Debug startup failed", it) }
            assertEquals(130, content.get().processHandler?.exitCode)
        } finally {
            content.get()?.processHandler?.destroyProcess()
            scope.cancel()
            PlatformTestUtil.waitWithEventsDispatching("Native Debug cleanup did not finish", {
                content.get()?.processHandler?.isProcessTerminated != false
            }, 15)
            documents.saveDocument(document)
            content.get()?.let {
                val contents = com.intellij.execution.ui.RunContentManager.getInstance(project)
                // The builder returns the backend descriptor; the UI owns a separate tab.
                contents.allDescriptors.filter { descriptor -> descriptor.processHandler === it.processHandler }.forEach { descriptor ->
                    contents.removeRunContent(DefaultDebugExecutor.getDebugExecutorInstance(), descriptor)
                }
                com.intellij.openapi.util.Disposer.dispose(it)
            }
            PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
            WriteCommandAction.runWriteCommandAction(project) {
                if (manager.breakpointManager.getBreakpoints(type).contains(breakpoint)) manager.breakpointManager.removeBreakpoint(breakpoint)
            }
        }
    }
}
