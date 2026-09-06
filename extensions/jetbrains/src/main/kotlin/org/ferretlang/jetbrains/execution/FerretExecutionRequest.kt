package org.ferretlang.jetbrains.execution

import org.ferretlang.jetbrains.run.FerretParameterBindings
import java.nio.file.Files
import java.nio.file.InvalidPathException
import java.nio.file.Path

internal data class FerretExecutionInput(
    val sourcePath: String,
    val workingDirectory: String,
    val projectBasePath: String?,
    val bindings: FerretParameterBindings,
)

internal data class FerretExecutionRequest(
    val source: Path,
    val workspaceRoot: Path,
    val relativeSourcePath: String,
    val workingDirectory: Path?,
    val bindings: FerretParameterBindings,
) {
    companion object {
        fun resolve(input: FerretExecutionInput): FerretExecutionRequest {
            val projectBase = input.projectBasePath?.let {
                configuredPath(it, null, "project base directory")
                    .canonicalDirectory("project base directory")
            }
            val source = configuredPath(input.sourcePath, projectBase, "source file").canonical("source file")
            require(Files.isRegularFile(source)) { "The Ferret source path is not a file: $source" }
            require(Files.isReadable(source)) { "The Ferret source file is not readable: $source" }

            val workspaceRoot = projectBase ?: source.parent
                ?.canonicalDirectory("source parent directory")
                ?: throw FerretExecutionRequestException("The Ferret source file has no parent directory: $source")
            if (!source.startsWith(workspaceRoot)) {
                throw FerretExecutionRequestException(
                    "The Ferret source file must be inside the project workspace: $source is outside $workspaceRoot",
                )
            }

            val relative = workspaceRoot.relativize(source)
            if (relative.nameCount == 0 || relative.isAbsolute || relative.any { it.toString() == ".." }) {
                throw FerretExecutionRequestException(
                    "Cannot derive a relative Ferret source path for $source from $workspaceRoot",
                )
            }
            val protocolPath = relative.joinToString("/") { it.toString() }
            if (protocolPath.isBlank() || protocolPath.contains('\u0000') || protocolPath.contains('\\')) {
                throw FerretExecutionRequestException("The Ferret source path is not protocol-safe: $protocolPath")
            }

            val workingDirectory = input.workingDirectory.takeUnless(String::isBlank)?.let {
                configuredPath(it, projectBase, "working directory").canonicalDirectory("working directory")
            }

            return FerretExecutionRequest(source, workspaceRoot, protocolPath, workingDirectory, input.bindings)
        }

        private fun configuredPath(value: String, base: Path?, label: String): Path {
            if (value.isBlank()) {
                throw FerretExecutionRequestException("Set the Ferret $label.")
            }
            val path = try {
                Path.of(value)
            } catch (error: InvalidPathException) {
                throw FerretExecutionRequestException("The Ferret $label path is invalid: ${error.message}", error)
            }
            if (path.isAbsolute) {
                return path.normalize()
            }
            if (base == null) {
                throw FerretExecutionRequestException(
                    "The Ferret $label path must be absolute because the project has no base directory.",
                )
            }
            return base.resolve(path).normalize()
        }

        private fun Path.canonical(label: String): Path = try {
            toRealPath()
        } catch (error: Exception) {
            throw FerretExecutionRequestException("Cannot resolve the Ferret $label: $this", error)
        }

        private fun Path.canonicalDirectory(label: String): Path = canonical(label).also { canonical ->
            require(Files.isDirectory(canonical)) { "The Ferret $label path is not a directory: $canonical" }
            require(Files.isReadable(canonical)) { "The Ferret $label is not readable: $canonical" }
        }

        private fun require(condition: Boolean, message: () -> String) {
            if (!condition) {
                throw FerretExecutionRequestException(message())
            }
        }
    }
}

internal class FerretExecutionRequestException(
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)
