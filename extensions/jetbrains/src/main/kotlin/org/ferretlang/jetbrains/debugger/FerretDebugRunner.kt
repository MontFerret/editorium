package org.ferretlang.jetbrains.debugger

import com.intellij.execution.configurations.RunProfile
import com.intellij.execution.configurations.RunProfileState
import com.intellij.execution.configurations.RunnerSettings
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.runners.AsyncProgramRunner
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.xdebugger.XDebugProcess
import com.intellij.xdebugger.XDebugProcessStarter
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.XDebuggerManager
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
        val input = (state as FerretRunProfileState).input
        com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().saveAllDocuments()
        FerretLaunchInputResolver.checkSavedSource(input)
        val result = XDebuggerManager.getInstance(environment.project).newSessionBuilder(object : XDebugProcessStarter() {
            override fun start(session: XDebugSession): XDebugProcess = FerretDebugProcess(session, input)
        }).environment(environment).startSession()
        return resolvedPromise(result.runContentDescriptor)
    }
}
