package org.ferretlang.jetbrains.run

import com.intellij.execution.DefaultExecutionResult
import com.intellij.execution.ExecutionResult
import com.intellij.execution.Executor
import com.intellij.execution.ExecutionException
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.util.io.FileUtil
import com.intellij.execution.configurations.RunProfileState
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.runners.ProgramRunner
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import org.ferretlang.jetbrains.daemon.FerretdDaemonConnection
import org.ferretlang.jetbrains.execution.FerretExecutionClient
import org.ferretlang.jetbrains.execution.FerretExecutionInput
import org.ferretlang.jetbrains.execution.FerretExecutionProcessHandler

class FerretRunProfileState internal constructor(
    private val project: Project,
    private val input: FerretExecutionInput,
) : RunProfileState {
    override fun execute(
        executor: Executor,
        runner: ProgramRunner<*>,
    ): ExecutionResult {
        checkSavedSource()
        val process = FerretExecutionProcessHandler()
        val console = TextConsoleBuilderFactory.getInstance().createBuilder(project).console
        console.attachToProcess(process)
        process.startNotify()
        val handle = FerretExecutionClient(project.service<FerretdDaemonConnection>()).start(input, process)
        process.attach(handle)
        return DefaultExecutionResult(console, process)
    }

    private fun checkSavedSource() {
        val configured = java.nio.file.Path.of(input.sourcePath)
        val source = if (configured.isAbsolute) configured else {
            input.projectBasePath?.let { java.nio.file.Path.of(it).resolve(configured) } ?: return
        }
        val file = LocalFileSystem.getInstance().findFileByPathIfCached(
            FileUtil.toSystemIndependentName(source.normalize().toString()),
        ) ?: return
        val documents = FileDocumentManager.getInstance()
        val document = documents.getCachedDocument(file) ?: return
        if (documents.isDocumentUnsaved(document)) {
            throw ExecutionException("Save the Ferret source file before running. The IDE could not save its current contents.")
        }
    }
}
