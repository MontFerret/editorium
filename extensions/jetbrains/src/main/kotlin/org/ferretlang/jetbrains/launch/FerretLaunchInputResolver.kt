package org.ferretlang.jetbrains.launch

import com.intellij.execution.ExecutionException
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.util.io.FileUtil
import com.intellij.openapi.vfs.LocalFileSystem
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path

/** Semantic inputs shared by Run and Debug; filesystem resolution runs off the EDT. */
internal object FerretLaunchInputResolver {
    fun checkSavedSource(input: FerretLaunchInput) {
        val configured = Path.of(input.sourcePath)
        val source = if (configured.isAbsolute) configured else {
            input.projectBasePath?.let { Path.of(it).resolve(configured) } ?: return
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

    fun resolve(input: FerretLaunchInput): FerretResolvedLaunchInput {
        val projectBase = input.projectBasePath?.let {
            canonicalDirectory(configuredPath(it, null, "project base directory"), "project base directory")
        }
        val source = canonical(configuredPath(input.sourcePath, projectBase, "source file"), "source file")
        require(Files.isRegularFile(source)) { "The Ferret source path is not a file: $source" }
        require(Files.isReadable(source)) { "The Ferret source file is not readable: $source" }
        val workspace = projectBase ?: source.parent?.let { canonicalDirectory(it, "source parent directory") }
            ?: throw FerretLaunchException("The Ferret source file has no parent directory: $source")
        require(source.startsWith(workspace)) {
            "The Ferret source file must be inside the project workspace: $source is outside $workspace"
        }
        val workingDirectory = input.workingDirectory.takeUnless(String::isBlank)?.let {
            canonicalDirectory(configuredPath(it, projectBase, "working directory"), "working directory")
        }
        return FerretResolvedLaunchInput(source, workspace, workingDirectory, input.bindings)
    }

    private fun configuredPath(value: String, base: Path?, label: String): Path {
        require(value.isNotBlank()) { "Set the Ferret $label." }
        val path = try {
            Path.of(value)
        } catch (error: InvalidPathException) {
            throw FerretLaunchException("The Ferret $label path is invalid: ${error.message}", error)
        }
        if (path.isAbsolute) return path.normalize()
        if (base == null) {
            throw FerretLaunchException("The Ferret $label path must be absolute because the project has no base directory.")
        }
        return base.resolve(path).normalize()
    }

    private fun canonical(path: Path, label: String): Path = try {
        path.toRealPath()
    } catch (error: Exception) {
        throw FerretLaunchException("Cannot resolve the Ferret $label: $path", error)
    }

    private fun canonicalDirectory(path: Path, label: String): Path = canonical(path, label).also {
        require(Files.isDirectory(it)) { "The Ferret $label path is not a directory: $it" }
        require(Files.isReadable(it)) { "The Ferret $label is not readable: $it" }
    }

    private fun require(condition: Boolean, message: () -> String) {
        if (!condition) throw FerretLaunchException(message())
    }
}
