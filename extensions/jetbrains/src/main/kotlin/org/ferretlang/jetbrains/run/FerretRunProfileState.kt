package org.ferretlang.jetbrains.run

import com.intellij.execution.ExecutionException
import com.intellij.execution.ExecutionResult
import com.intellij.execution.Executor
import com.intellij.execution.configurations.RunProfileState
import com.intellij.execution.runners.ProgramRunner

class FerretRunProfileState : RunProfileState {
    override fun execute(
        executor: Executor,
        runner: ProgramRunner<*>,
    ): ExecutionResult = throw ExecutionException("Ferret execution is not implemented yet.")
}
