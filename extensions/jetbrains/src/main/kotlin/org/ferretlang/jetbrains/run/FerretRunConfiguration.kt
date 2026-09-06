package org.ferretlang.jetbrains.run

import com.intellij.execution.Executor
import com.intellij.execution.configurations.ConfigurationFactory
import com.intellij.execution.configurations.LocatableConfigurationBase
import com.intellij.execution.configurations.RunProfileState
import com.intellij.execution.configurations.RuntimeConfigurationError
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.openapi.options.SettingsEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import org.ferretlang.jetbrains.execution.FerretExecutionInput
import org.ferretlang.jetbrains.execution.FerretExecutionRequest
import org.ferretlang.jetbrains.execution.FerretExecutionRequestException
import java.nio.file.InvalidPathException
import java.nio.file.Path

class FerretRunConfiguration(
    project: Project,
    factory: ConfigurationFactory,
    name: String,
) : LocatableConfigurationBase<FerretRunConfigurationOptions>(project, factory, name) {
    override fun getOptions(): FerretRunConfigurationOptions =
        super.getOptions() as FerretRunConfigurationOptions

    var sourcePath: String
        get() = options.sourcePath.orEmpty()
        set(value) {
            options.sourcePath = value
        }

    var workingDirectory: String
        get() = options.workingDirectory.orEmpty()
        set(value) {
            options.workingDirectory = value
        }

    var parameters: FerretParameterBindings
        get() = FerretParameterBindingsJson.parse(parametersJson)
        set(value) {
            options.parametersJson = FerretParameterBindingsJson.render(value)
        }

    internal var parametersJson: String
        get() = options.parametersJson ?: "{}"
        set(value) {
            options.parametersJson = FerretParameterBindingsJson.normalize(value)
        }

    override fun suggestedName(): String? = resolvedSourcePathOrNull()?.fileName?.toString()

    override fun getConfigurationEditor(): SettingsEditor<out FerretRunConfiguration> =
        FerretRunConfigurationEditor(project)

    override fun checkConfiguration() {
        try {
            FerretParameterBindingsJson.parse(parametersJson)
        } catch (error: IllegalArgumentException) {
            throw RuntimeConfigurationError(error.message ?: "The Ferret parameters are invalid.")
        }

        val request = try {
            FerretExecutionRequest.resolve(executionInput())
        } catch (error: FerretExecutionRequestException) {
            throw RuntimeConfigurationError(error.message ?: "The Ferret execution paths are invalid.")
        }

        val sourceFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(request.source)
        if (sourceFile == null || !FerretRunSourceFile.isEligible(sourceFile)) {
            throw RuntimeConfigurationError(
                "The Ferret source file must be a local .fql file recognized by the IDE: ${request.source}",
            )
        }
    }

    override fun getState(
        executor: Executor,
        environment: ExecutionEnvironment,
    ): RunProfileState = FerretRunProfileState(project, executionInput())

    private fun executionInput(): FerretExecutionInput = FerretExecutionInput(
        sourcePath = sourcePath,
        workingDirectory = workingDirectory,
        projectBasePath = project.basePath,
        bindings = parameters,
    )

    internal fun resolvedSourcePathOrNull(): Path? = resolvePathOrNull(sourcePath)

    internal fun resolvedWorkingDirectoryOrNull(): Path? = resolvePathOrNull(workingDirectory)

    private fun resolvePathOrNull(value: String): Path? = try {
        if (value.isBlank()) {
            null
        } else {
            val path = Path.of(value)
            when {
                path.isAbsolute -> path.normalize()
                project.basePath != null -> Path.of(project.basePath!!).resolve(path).normalize()
                else -> null
            }
        }
    } catch (_: InvalidPathException) {
        null
    }
}
