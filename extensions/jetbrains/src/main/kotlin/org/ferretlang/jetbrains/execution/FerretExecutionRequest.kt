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
    val bindings: FerretParameterBindings,
) {
    companion object {
        fun resolve(input: FerretExecutionInput): FerretExecutionRequest {
            val projectBase = input.projectBasePath
                ?.takeUnless(String::isBlank)
                ?.let { configuredPath(it, null, "project base directory") }
            val source = configuredPath(input.sourcePath, projectBase, "source file").canonical("source file")
            require(Files.isRegularFile(source)) { "The Ferret source path is not a file: $source" }
            require(Files.isReadable(source)) { "The Ferret source file is not readable: $source" }

            val rootCandidate = if (input.workingDirectory.isBlank()) {
                projectBase ?: source.parent
                    ?: throw FerretExecutionRequestException("The Ferret source file has no parent directory: $source")
            } else {
                configuredPath(input.workingDirectory, projectBase, "working directory")
            }
            val root = rootCandidate.canonical("working directory")
            require(Files.isDirectory(root)) { "The Ferret working directory path is not a directory: $root" }
            require(Files.isReadable(root)) { "The Ferret working directory is not readable: $root" }
            if (!source.startsWith(root)) {
                throw FerretExecutionRequestException(
                    "The Ferret source file must be inside the effective working directory: $source is outside $root",
                )
            }

            val relative = root.relativize(source)
            if (relative.nameCount == 0 || relative.isAbsolute || relative.any { it.toString() == ".." }) {
                throw FerretExecutionRequestException("Cannot derive a relative Ferret source path for $source from $root")
            }
            val protocolPath = relative.joinToString("/") { it.toString() }
            if (protocolPath.isBlank() || protocolPath.contains('\u0000') || protocolPath.contains('\\')) {
                throw FerretExecutionRequestException("The Ferret source path is not protocol-safe: $protocolPath")
            }

            return FerretExecutionRequest(source, root, protocolPath, input.bindings)
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
