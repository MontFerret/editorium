package org.ferretlang.jetbrains.run

import com.intellij.execution.Executor
import com.intellij.execution.configurations.ConfigurationFactory
import com.intellij.execution.configurations.LocatableConfigurationBase
import com.intellij.execution.configurations.RunProfileState
import com.intellij.execution.configurations.RuntimeConfigurationError
import com.intellij.execution.configurations.RefactoringListenerProvider
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.openapi.options.SettingsEditor
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.util.io.FileUtil
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFileSystemItem
import com.intellij.refactoring.listeners.RefactoringElementListener
import org.ferretlang.jetbrains.execution.FerretExecutionInput
import java.nio.file.InvalidPathException
import java.nio.file.Path

class FerretRunConfiguration(
    project: Project,
    factory: ConfigurationFactory,
    name: String,
) : LocatableConfigurationBase<FerretRunConfigurationOptions>(project, factory, name), RefactoringListenerProvider {
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

    override fun suggestedName(): String? {
        val source = resolvedSourcePathOrNull() ?: return null
        val base = project.basePath?.let { resolvePathOrNull(it) }
        return if (base != null && source.startsWith(base) && source != base) {
            base.relativize(source).joinToString("/")
        } else {
            source.fileName?.toString()
        }
    }

    override fun getRefactoringElementListener(element: PsiElement): RefactoringElementListener? {
        val item = element as? PsiFileSystemItem ?: return null
        val file = item.virtualFile ?: return null
        if (!file.isInLocalFileSystem) return null
        val source = resolvedSourcePathOrNull() ?: return null
        val original = file.toNioPath().toAbsolutePath().normalize()
        if (source != original && !(item.isDirectory && source.startsWith(original))) return null
        return FerretRunSourceRefactoringListener(this, original.relativize(source))
    }

    override fun getConfigurationEditor(): SettingsEditor<out FerretRunConfiguration> =
        FerretRunConfigurationEditor(project)

    override fun checkConfiguration() {
        try {
            FerretParameterBindingsJson.parse(parametersJson)
        } catch (error: IllegalArgumentException) {
            throw RuntimeConfigurationError(error.message ?: "The Ferret parameters are invalid.")
        }

        val source = checkPath(sourcePath, "source file", required = true)!!
        checkPath(workingDirectory, "working directory", required = false)
        // Configuration checks also run from the settings dialog on the EDT.
        // A cache miss is not evidence that a newly created file does not exist.
        val sourceFile = LocalFileSystem.getInstance().findFileByPathIfCached(FileUtil.toSystemIndependentName(source.toString()))
        if (!source.fileName.toString().endsWith(".fql") || (sourceFile != null && !FerretRunSourceFile.isEligible(sourceFile))) {
            throw RuntimeConfigurationError(
                "The Ferret source file must be a local .fql file recognized by the IDE: $source",
            )
        }
    }

    private fun checkPath(value: String, label: String, required: Boolean): Path? {
        if (value.isBlank()) {
            if (required) throw RuntimeConfigurationError("Set the Ferret $label.")
            return null
        }
        val path = try {
            Path.of(value)
        } catch (_: InvalidPathException) {
            throw RuntimeConfigurationError("The Ferret $label path is invalid.")
        }
        if (!path.isAbsolute && project.basePath == null) {
            throw RuntimeConfigurationError("The Ferret $label path must be absolute because the project has no base directory.")
        }
        return resolvePathOrNull(value)
            ?: throw RuntimeConfigurationError("The Ferret $label path is invalid.")
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
