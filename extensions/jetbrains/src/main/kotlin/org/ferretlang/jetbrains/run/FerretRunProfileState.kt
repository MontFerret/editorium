package org.ferretlang.jetbrains.run

import com.intellij.execution.DefaultExecutionResult
import com.intellij.execution.ExecutionResult
import com.intellij.execution.Executor
import com.intellij.execution.configurations.RunProfileState
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.runners.ProgramRunner
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.execution.FerretExecutionClient
import org.ferretlang.jetbrains.launch.FerretLaunchInputResolver
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.execution.FerretExecutionProcessHandler

class FerretRunProfileState internal constructor(
    private val project: Project,
    internal val input: FerretLaunchInput,
) : RunProfileState {
    override fun execute(
        executor: Executor,
        runner: ProgramRunner<*>,
    ): ExecutionResult {
        val connection = project.service<FerretdDaemonConnection>()
        val launch = connection.admitLocalLaunch(input.runtimeName)
        try {
            FerretLaunchInputResolver.checkSavedSource(input)
            val process = FerretExecutionProcessHandler()
            val console = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
            console.attachToProcess(process)
            process.startNotify()
            val handle = FerretExecutionClient(connection).start(input, process, launch)
            process.attach(handle)
            return DefaultExecutionResult(console, process)
        } catch (error: Throwable) {
            launch.close()
            throw error
        }
    }
}
