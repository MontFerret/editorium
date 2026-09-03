package org.ferretlang.jetbrains.run

import com.intellij.execution.configurations.ConfigurationInfoProvider
import com.intellij.execution.configurations.RunProfile
import com.intellij.execution.configurations.RunnerSettings
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.runners.ProgramRunner
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.ferretlang.jetbrains.execution.FerretExecutionProcessHandler
import java.nio.file.Files

class FerretRunProfileStateTest : BasePlatformTestCase() {
    fun testConfigurationReturnsAnAttachedSyntheticExecutionResultImmediately() {
        val source = Files.createTempFile("ferret-run-state-", ".fql")
        try {
            Files.writeString(source, "RETURN 1")
            val configuration = FerretRunConfigurationType
                .getInstance()
                .configurationFactories
                .single()
                .createTemplateConfiguration(project) as FerretRunConfiguration
            configuration.sourcePath = source.toString()
            configuration.workingDirectory = source.parent.toString()
            configuration.checkConfiguration()

            val state = configuration.getState(
                DefaultRunExecutor.getRunExecutorInstance(),
                ExecutionEnvironment(),
            )
            assertTrue(state is FerretRunProfileState)
            val result = state.execute(DefaultRunExecutor.getRunExecutorInstance(), TestProgramRunner)!!
            assertTrue(result.processHandler is FerretExecutionProcessHandler)
            assertNotNull(result.executionConsole)
            result.processHandler.destroyProcess()
        } finally {
            Files.deleteIfExists(source)
        }
    }

    private object TestProgramRunner : ProgramRunner<RunnerSettings> {
        override fun getRunnerId(): String = "ferret-test-runner"

        override fun canRun(executorId: String, profile: RunProfile): Boolean = true

        override fun createConfigurationData(settingsProvider: ConfigurationInfoProvider): RunnerSettings? = null

        override fun execute(environment: ExecutionEnvironment) = Unit
    }
}
