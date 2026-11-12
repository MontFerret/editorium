package org.ferretlang.jetbrains.debugger

import com.intellij.execution.configurations.RunProfile
import com.intellij.execution.configurations.RunProfileState
import com.intellij.execution.configurations.RunnerSettings
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.runners.AsyncProgramRunner
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.xdebugger.XDebugProcess
import com.intellij.xdebugger.XDebugProcessStarter
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.XDebuggerManager
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.launch.FerretLaunchInput
import org.ferretlang.jetbrains.launch.FerretLaunchInputResolver
import org.ferretlang.jetbrains.run.FerretRunConfiguration
import org.ferretlang.jetbrains.run.FerretRunProfileState
import org.jetbrains.concurrency.Promise
import org.jetbrains.concurrency.resolvedPromise

class FerretDebugRunner : AsyncProgramRunner<RunnerSettings>() {
    override fun getRunnerId(): String = "FerretDebugRunner"

    override fun canRun(executorId: String, profile: RunProfile): Boolean =
        executorId == DefaultDebugExecutor.EXECUTOR_ID && profile is FerretRunConfiguration

    override fun execute(environment: ExecutionEnvironment, state: RunProfileState): Promise<RunContentDescriptor?> {
        val descriptor = startSession(environment.project, (state as FerretRunProfileState).input) { starter ->
            XDebuggerManager.getInstance(environment.project).newSessionBuilder(starter)
                .environment(environment).startSession().runContentDescriptor
        }
        return resolvedPromise(descriptor)
    }

    internal fun startSession(
        project: Project,
        input: FerretLaunchInput,
        start: (XDebugProcessStarter) -> RunContentDescriptor?,
    ): RunContentDescriptor? {
        val launch = project.service<FerretdDaemonConnection>().admitLocalLaunch(input.runtimeName)
        var process: FerretDebugProcess? = null
        try {
            FileDocumentManager.getInstance().saveAllDocuments()
            FerretLaunchInputResolver.checkSavedSource(input)
            return start(object : XDebugProcessStarter() {
                override fun start(session: XDebugSession): XDebugProcess =
                    FerretDebugProcess(session, input, launch).also { process = it }
            })
        } catch (error: Throwable) {
            val owner = process
            if (owner == null) launch.close() else owner.abortStartup()
            throw error
        }
    }
}
