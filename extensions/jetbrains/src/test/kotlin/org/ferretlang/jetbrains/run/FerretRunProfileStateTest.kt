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
import java.nio.file.Path

class FerretRunProfileStateTest : BasePlatformTestCase() {
    fun testRunRejectsASourceDocumentThatRemainsUnsaved() {
        val source = Path.of(requireNotNull(project.basePath)).resolve("unsaved-run.fql")
        Files.writeString(source, "RETURN 1")
        val file = requireNotNull(com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByNioFile(source))
        val documents = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance()
        val document = requireNotNull(documents.getDocument(file))
        val input = org.ferretlang.jetbrains.execution.FerretExecutionInput(
            source.toString(), "", project.basePath, FerretParameterBindings.EMPTY,
        )
        try {
            com.intellij.openapi.command.WriteCommandAction.runWriteCommandAction(project) { document.setText("RETURN 2") }
            assertTrue(documents.isDocumentUnsaved(document))
            try {
                FerretRunProfileState(project, input).execute(DefaultRunExecutor.getRunExecutorInstance(), TestProgramRunner)
                fail("An unsaved source must not execute stale disk contents")
            } catch (error: com.intellij.execution.ExecutionException) {
                assertTrue(error.message.orEmpty().contains("could not save"))
            }
            assertEquals("RETURN 1", Files.readString(source))
        } finally {
            documents.saveDocument(document)
        }
    }

    fun testConfigurationReturnsAnAttachedSyntheticExecutionResultImmediately() {
        val source = Path.of(requireNotNull(project.basePath)).resolve("ferret-run-state.fql")
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
