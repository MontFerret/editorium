package org.ferretlang.jetbrains.run

import com.intellij.execution.Executor
import com.intellij.execution.configurations.ConfigurationFactory
import com.intellij.execution.configurations.LocatableConfigurationBase
import com.intellij.execution.configurations.RunProfileState
import com.intellij.execution.configurations.RuntimeConfigurationError
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.openapi.options.SettingsEditor
import com.intellij.openapi.project.Project
import org.ferretlang.jetbrains.lang.FerretLanguageFileType
import java.nio.file.Files
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

    var parameters: String
        get() = options.parameters ?: "{}"
        set(value) {
            options.parameters = FerretParameterBindings.normalize(value)
        }

    override fun suggestedName(): String? = resolvedSourcePathOrNull()?.fileName?.toString()

    override fun getConfigurationEditor(): SettingsEditor<out FerretRunConfiguration> =
        FerretRunConfigurationEditor(project)

    override fun checkConfiguration() {
        val source = resolveRequiredPath(sourcePath, "source file")
        if (!Files.exists(source)) {
            throw RuntimeConfigurationError("The Ferret source file does not exist: $source")
        }
        if (!Files.isRegularFile(source)) {
            throw RuntimeConfigurationError("The Ferret source path is not a file: $source")
        }
        if (!source.fileName.toString().endsWith(".${FerretLanguageFileType.defaultExtension}")) {
            throw RuntimeConfigurationError("The Ferret source file must use the .fql extension: $source")
        }

        resolveOptionalPath(workingDirectory, "working directory")?.let { directory ->
            if (!Files.exists(directory)) {
                throw RuntimeConfigurationError("The working directory does not exist: $directory")
            }
            if (!Files.isDirectory(directory)) {
                throw RuntimeConfigurationError("The working directory path is not a directory: $directory")
            }
        }

        try {
            FerretParameterBindings.validate(parameters)
        } catch (error: IllegalArgumentException) {
            throw RuntimeConfigurationError(error.message ?: "The Ferret parameters are invalid.")
        }
    }

    override fun getState(
        executor: Executor,
        environment: ExecutionEnvironment,
    ): RunProfileState = FerretRunProfileState()

    internal fun resolvedSourcePathOrNull(): Path? = resolvePathOrNull(sourcePath)

    internal fun resolvedWorkingDirectoryOrNull(): Path? = resolvePathOrNull(workingDirectory)

    private fun resolveRequiredPath(value: String, label: String): Path {
        if (value.isBlank()) {
            throw RuntimeConfigurationError("Set the Ferret $label.")
        }

        return resolveConfiguredPath(value, label)
    }

    private fun resolveOptionalPath(value: String, label: String): Path? =
        if (value.isBlank()) null else resolveConfiguredPath(value, label)

    private fun resolveConfiguredPath(value: String, label: String): Path {
        val path = try {
            Path.of(value)
        } catch (error: InvalidPathException) {
            throw RuntimeConfigurationError("The Ferret $label path is invalid: ${error.message}")
        }

        if (path.isAbsolute) {
            return path.normalize()
        }

        val basePath = project.basePath
            ?: throw RuntimeConfigurationError(
                "The Ferret $label path must be absolute because the project has no base directory.",
            )

        return try {
            Path.of(basePath).resolve(path).normalize()
        } catch (error: InvalidPathException) {
            throw RuntimeConfigurationError("The Ferret $label path is invalid: ${error.message}")
        }
    }

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
