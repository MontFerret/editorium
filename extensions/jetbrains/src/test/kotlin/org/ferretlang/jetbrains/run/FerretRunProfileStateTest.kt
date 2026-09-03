package org.ferretlang.jetbrains.run

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.ConfigurationInfoProvider
import com.intellij.execution.configurations.RunProfile
import com.intellij.execution.configurations.RunnerSettings
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.runners.ProgramRunner
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.junit.Assert
import java.nio.file.Files

class FerretRunProfileStateTest : BasePlatformTestCase() {
    fun testConfigurationReturnsAStateThatStopsAtTheExplicitExecutionBoundary() {
        val source = Files.createTempFile("ferret-run-state-", ".fql")

        try {
            val configuration = FerretRunConfigurationType
                .getInstance()
                .configurationFactories
                .single()
                .createTemplateConfiguration(project) as FerretRunConfiguration
            configuration.sourcePath = source.toString()
            configuration.workingDirectory = ""
            configuration.checkConfiguration()

            val state = configuration.getState(
                DefaultRunExecutor.getRunExecutorInstance(),
                ExecutionEnvironment(),
            )
            assertTrue(state is FerretRunProfileState)

            val error = Assert.assertThrows(ExecutionException::class.java) {
                state.execute(DefaultRunExecutor.getRunExecutorInstance(), TestProgramRunner)
            }

            assertEquals("Ferret execution is not implemented yet.", error.message)
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
