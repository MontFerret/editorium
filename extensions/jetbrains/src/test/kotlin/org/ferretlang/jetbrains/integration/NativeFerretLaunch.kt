package org.ferretlang.jetbrains.integration

import com.intellij.execution.Executor
import com.intellij.execution.impl.ConsoleViewImpl
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ProgramRunner
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.execution.ui.RunContentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.testFramework.PlatformTestUtil
import org.ferretlang.jetbrains.run.FerretRunConfiguration
import org.ferretlang.jetbrains.run.FerretRunConfigurationType
import java.nio.file.Path
import java.util.concurrent.CompletableFuture

/** Drives the registered runner and reads the console that was attached before execution. */
internal class NativeFerretLaunch(private val project: Project, private val executor: Executor) : AutoCloseable {
    private val started = CompletableFuture<RunContentDescriptor>()

    fun start(source: Path, selector: String, bindings: String): RunContentDescriptor {
        val configuration = FerretRunConfigurationType.getInstance().configurationFactories.single()
            .createTemplateConfiguration(project) as FerretRunConfiguration
        configuration.sourcePath = source.toString()
        configuration.runtimeName = selector
        configuration.parametersJson = bindings
        val environment = ExecutionEnvironmentBuilder.create(executor, configuration).build(object : ProgramRunner.Callback {
            override fun processStarted(descriptor: RunContentDescriptor) { started.complete(descriptor) }
            override fun processNotStarted(error: Throwable?) {
                started.completeExceptionally(error ?: IllegalStateException("Native launch failed"))
            }
        })
        environment.runner.execute(environment)
        PlatformTestUtil.waitWithEventsDispatching("Native launch did not start", { started.isDone }, 20)
        return started.get()
    }

    fun outputLines(): List<String> {
        val descriptor = started.get()
        val handler = requireNotNull(descriptor.processHandler)
        PlatformTestUtil.waitWithEventsDispatching("Native process did not finish", { handler.isProcessTerminated }, 20)
        val console = descriptor.executionConsole as ConsoleViewImpl
        console.component // Create the editor that displays the buffered output in a visible Run tab.
        console.flushDeferredText()
        val text = console.text
        check(handler.exitCode == 0) { "Exit ${handler.exitCode}: $text" }
        return text.lineSequence().map(String::trim).toList()
    }

    override fun close() {
        if (!started.isDone || started.isCompletedExceptionally) return
        val descriptor = started.get()
        val handler = requireNotNull(descriptor.processHandler)
        if (!handler.isProcessTerminated) handler.destroyProcess()
        PlatformTestUtil.waitWithEventsDispatching("Native process did not terminate", { handler.isProcessTerminated }, 20)
        val contents = RunContentManager.getInstance(project)
        contents.allDescriptors.filter { it.processHandler === handler }.forEach { contents.removeRunContent(executor, it) }
        Disposer.dispose(descriptor)
        PlatformTestUtil.dispatchAllEventsInIdeEventQueue()
    }
}
